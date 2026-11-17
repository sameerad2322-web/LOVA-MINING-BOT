import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getPublicSystemStatus, isGramVerificationConfigured, serverConfig } from './config.ts';
import { db } from './db.ts';
import {
  createRateLimiter,
  extractBearerOrCookie,
  normalizeTonAddress,
  safeText,
  signSessionToken,
  verifySessionToken,
  verifyTelegramInitData,
  type SessionClaims,
} from './security.ts';
import {
  configureBotConnection,
  getBotStatus,
  getResolvedBotUsername,
  getWebhookSecret,
  handleTelegramWebhookUpdate,
} from './telegramBot.ts';
import { verifyGramJettonTransaction, verifyTonTransactionFinalized } from './tonVerifier.ts';
import type { AdminRole, LovaUser } from '../src/types/lova.ts';

interface AuthedRequest extends Request {
  session?: SessionClaims;
  currentUser?: LovaUser;
  adminSession?: SessionClaims;
}

const SESSION_COOKIE = 'lova_session';
const ADMIN_COOKIE = 'lova_admin_session';

function setSessionCookie(res: Response, name: string, value: string, maxAgeSec: number) {
  const isProd = serverConfig.nodeEnv === 'production';
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: maxAgeSec * 1000,
    path: '/',
  });
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = extractBearerOrCookie(req, SESSION_COOKIE, 'authorization');
  const claims = verifySessionToken(token);
  if (!claims || claims.kind !== 'user') {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Valid session required.' });
    return;
  }
  const user = await db.getUserById(claims.sub);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: 'User account not found.' });
    return;
  }
  if (user.status === 'banned') {
    res.status(403).json({
      error: 'ACCOUNT_BANNED',
      message: user.ban_reason || 'This account has been banned by an administrator.',
    });
    return;
  }
  req.session = claims;
  req.currentUser = user;
  next();
}

async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = extractBearerOrCookie(req, ADMIN_COOKIE, 'x-admin-authorization');
  const claims = verifySessionToken(token);
  if (!claims || claims.kind !== 'admin' || !claims.adminRole) {
    res.status(401).json({ error: 'ADMIN_UNAUTHORIZED', message: 'Admin authentication required.' });
    return;
  }
  req.adminSession = claims;
  next();
}

export function createApiRouter() {
  const router = express.Router();

  const authLimiter = createRateLimiter(30, 60_000, 'auth');
  const actionLimiter = createRateLimiter(45, 60_000, 'action');
  const strictLimiter = createRateLimiter(12, 60_000, 'strict');

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'lova-mining-api', timestamp: new Date().toISOString() });
  });

  router.get('/system/public', async (_req, res) => {
    try {
      const [settings, botUsername] = await Promise.all([
        db.getSettings(),
        getResolvedBotUsername(),
      ]);
      const status = getPublicSystemStatus(
        settings.gram_verification_fee,
        settings.admin_ton_wallet_override
      );
      res.json({
        systemStatus: {
          ...status,
          telegramBotUsername: botUsername || status.telegramBotUsername,
        },
        botUsername: botUsername || status.telegramBotUsername,
        appName: settings.app_name,
      });
    } catch (err) {
      res.status(500).json({ error: 'PUBLIC_STATUS_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // TELEGRAM BOT WEBHOOK
  // ============================================================================
  router.get('/telegram/webhook', async (_req, res) => {
    const status = await getBotStatus();
    res.status(200).json({
      ok: true,
      method: 'POST',
      endpoint: '/api/telegram/webhook',
      botConfigured: status.configured,
      tokenFormatValid: /^\d+:[A-Za-z0-9_-]{20,}$/.test(serverConfig.telegramBotToken),
      botTokenValid: Boolean(status.bot),
      botId: status.bot?.id || null,
      botUsername: status.bot?.username || null,
      webhookConfigured: Boolean(status.webhook?.url),
      pendingUpdateCount: status.webhook?.pending_update_count ?? 0,
      lastWebhookError: status.webhook?.last_error_message || null,
      apiError: status.error,
    });
  });

  router.post('/telegram/webhook', async (req, res) => {
    try {
      const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      const expected = getWebhookSecret();

      // Strictly verify secret_token if explicitly configured OR if Telegram sent the header
      if (serverConfig.telegramWebhookSecret || provided.length > 0) {
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          res.status(403).json({ ok: false, error: 'INVALID_WEBHOOK_SECRET' });
          return;
        }
      }

      if (!serverConfig.telegramBotToken) {
        res.status(200).json({ ok: false, skipped: 'TELEGRAM_BOT_NOT_CONFIGURED' });
        return;
      }

      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
        .split(',')[0]
        .trim();
      const appOrigin = host ? `${proto}://${host}` : serverConfig.appUrl;

      await handleTelegramWebhookUpdate(req.body || {}, appOrigin);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ============================================================================
  // TELEGRAM AUTHENTICATION
  // ============================================================================
  router.post('/auth/telegram', authLimiter, async (req: AuthedRequest, res) => {
    try {
      const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
      const referralParam = safeText(req.body?.startParam, 64) || null;
      const previewSlot = safeText(req.body?.previewSlot, 32);

      let tgUser: {
        id: number;
        username?: string;
        first_name?: string;
        last_name?: string;
        photo_url?: string;
      } | null = null;
      let startParam = referralParam;

      if (initData && serverConfig.telegramBotToken) {
        const verified = verifyTelegramInitData(initData, serverConfig.telegramBotToken);
        if (!verified) {
          res.status(401).json({
            error: 'INVALID_INIT_DATA',
            message: 'Telegram WebApp initData signature verification failed.',
          });
          return;
        }
        tgUser = verified.user;
        startParam = verified.startParam || referralParam;
      } else if (serverConfig.telegramAllowDevPreview) {
        // Preview sandbox mode when outside Telegram Mini App container
        // Uses deterministic preview ID tied to browser session header or default preview ID
        const existingToken = extractBearerOrCookie(req, SESSION_COOKIE, 'authorization');
        const existingClaims = verifySessionToken(existingToken);
        if (existingClaims && existingClaims.kind === 'user' && !previewSlot) {
          const existingUser = await db.getUserById(existingClaims.sub);
          if (existingUser) {
            tgUser = {
              id: existingUser.telegram_id,
              username: existingUser.username || 'lova_preview_miner',
              first_name: existingUser.first_name || 'Preview',
              last_name: existingUser.last_name || 'Miner',
            };
          }
        }
        if (!tgUser) {
          const baseId = previewSlot ? 900000000 + (Math.abs(hashString(previewSlot)) % 99999) : 900100001;
          tgUser = {
            id: baseId,
            username: previewSlot ? `miner_${previewSlot.slice(0, 8)}` : 'lova_preview_miner',
            first_name: 'LOVA',
            last_name: 'Preview Miner',
          };
        }
      } else {
        res.status(401).json({
          error: 'TELEGRAM_AUTH_REQUIRED',
          message: 'Please open LOVA Mining inside Telegram to authenticate securely.',
        });
        return;
      }

      const { user } = await db.upsertTelegramUser({
        telegram_id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        last_name: tgUser.last_name || null,
        photo_url: tgUser.photo_url || null,
        referralCodeParam: startParam,
      });

      if (user.status === 'banned') {
        res.status(403).json({
          error: 'ACCOUNT_BANNED',
          message: user.ban_reason || 'Account banned.',
        });
        return;
      }

      const token = signSessionToken({ sub: user.id, tgId: user.telegram_id, kind: 'user' });
      setSessionCookie(res, SESSION_COOKIE, token, 60 * 60 * 24 * 7);

      const bootstrap = await buildBootstrapPayload(user);
      res.json({ sessionToken: token, ...bootstrap });
    } catch (err) {
      res.status(500).json({
        error: 'AUTH_ERROR',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      });
    }
  });

  router.get('/auth/me', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const bootstrap = await buildBootstrapPayload(req.currentUser!);
      res.json(bootstrap);
    } catch (err) {
      res.status(500).json({ error: 'BOOTSTRAP_ERROR', message: (err as Error).message });
    }
  });

  router.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ============================================================================
  // MINING SYSTEM (Server-Timestamp Authoritative)
  // ============================================================================
  router.post('/mining/start', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      if (user.status !== 'active') {
        res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Your account is suspended from mining.' });
        return;
      }
      const settings = await db.getSettings();
      if (settings.maintenance_mode || settings.emergency_pause || !settings.mining_enabled) {
        res.status(403).json({
          error: 'MINING_PAUSED',
          message: 'Mining is currently paused by platform administrators.',
        });
        return;
      }

      const existing = await db.getActiveOrExpiredSession(user.id);
      if (existing) {
        res.status(409).json({
          error: 'SESSION_EXISTS',
          message:
            existing.status === 'expired'
              ? 'Your completed mining session has rewards ready to claim first.'
              : 'A mining session is already active.',
          activeSession: existing,
        });
        return;
      }

      const session = await db.startMiningSession(user.id, settings);
      res.json({ session, serverTime: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: 'MINING_START_ERROR', message: (err as Error).message });
    }
  });

  router.post('/mining/stop', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const settings = await db.getSettings();
      const existing = await db.getActiveOrExpiredSession(user.id);
      if (!existing) {
        res.status(404).json({ error: 'NO_ACTIVE_SESSION', message: 'No active mining session found.' });
        return;
      }
      const result = await db.settleMiningSession(existing, 'stop', settings);
      const updatedUser = (await db.getUserById(user.id))!;
      res.json({
        ...result,
        user: updatedUser,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      res.status(400).json({ error: 'MINING_STOP_ERROR', message: (err as Error).message });
    }
  });

  router.post('/mining/claim', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const settings = await db.getSettings();
      if (settings.maintenance_mode || settings.emergency_pause) {
        res.status(403).json({ error: 'SYSTEM_PAUSED', message: 'Claims are temporarily paused.' });
        return;
      }
      const existing = await db.getActiveOrExpiredSession(user.id);
      if (!existing) {
        res.status(404).json({ error: 'NO_SESSION', message: 'No active or completed mining session to claim.' });
        return;
      }
      const result = await db.settleMiningSession(existing, 'claim', settings);
      const updatedUser = (await db.getUserById(user.id))!;
      res.json({
        ...result,
        user: updatedUser,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      res.status(400).json({ error: 'MINING_CLAIM_ERROR', message: (err as Error).message });
    }
  });

  router.get('/mining/history', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const history = await db.getMiningHistory(req.currentUser!.id);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: 'HISTORY_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // DAILY CHECK-IN & TASKS
  // ============================================================================
  router.post('/checkin', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const settings = await db.getSettings();
      if (settings.maintenance_mode || settings.emergency_pause) {
        res.status(403).json({ error: 'SYSTEM_PAUSED', message: 'Platform is temporarily paused.' });
        return;
      }
      const result = await db.performDailyCheckin(req.currentUser!, settings);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'CHECKIN_ERROR', message: (err as Error).message });
    }
  });

  router.get('/tasks', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const tasks = await db.getTasksForUser(req.currentUser!.id, false);
      const stats = await db.getUserStatsForVerification(req.currentUser!.id);
      res.json({ tasks, stats });
    } catch (err) {
      res.status(500).json({ error: 'TASKS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/tasks/:id/start', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const task = await db.getTaskById(String(req.params.id));
      if (!task || !task.is_active) {
        res.status(404).json({ error: 'TASK_NOT_FOUND', message: 'Task not found or inactive.' });
        return;
      }
      const row = await db.startTask(req.currentUser!.id, task.id);
      res.json({ ok: true, completion: row });
    } catch (err) {
      res.status(400).json({ error: 'TASK_START_ERROR', message: (err as Error).message });
    }
  });

  router.post('/tasks/:id/verify', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const task = await db.getTaskById(String(req.params.id));
      if (!task || !task.is_active) {
        res.status(404).json({ error: 'TASK_NOT_FOUND', message: 'Task not found or inactive.' });
        return;
      }

      const userTasks = await db.getTasksForUser(user.id, true);
      const currentTaskState = userTasks.find((t) => t.id === task.id);
      if (currentTaskState?.user_status === 'completed') {
        res.status(409).json({ error: 'ALREADY_COMPLETED', message: 'You have already claimed this task.' });
        return;
      }

      const stats = await db.getUserStatsForVerification(user.id);

      if (task.category === 'wallet_verified') {
        if (!stats.hasVerifiedWallet) {
          res.status(422).json({
            error: 'WALLET_NOT_VERIFIED',
            message: 'Connect a TON wallet and complete the 0.05 GRAM verification fee first.',
          });
          return;
        }
      } else if (task.category === 'referral_milestone') {
        if (stats.referralCount < task.required_count) {
          res.status(422).json({
            error: 'MILESTONE_NOT_MET',
            message: `You have ${stats.referralCount} of ${task.required_count} required referrals.`,
          });
          return;
        }
      } else if (task.category === 'mining_sessions') {
        if (stats.completedMiningSessions < task.required_count) {
          res.status(422).json({
            error: 'MILESTONE_NOT_MET',
            message: `You have completed ${stats.completedMiningSessions} of ${task.required_count} required mining sessions.`,
          });
          return;
        }
      } else if (task.category === 'telegram_channel') {
        if (!serverConfig.telegramBotToken || !task.telegram_chat_id) {
          res.status(422).json({
            error: 'TELEGRAM_BOT_NOT_CONFIGURED',
            message:
              'Telegram channel membership verification requires TELEGRAM_BOT_TOKEN and a bot-accessible channel ID configured on the server.',
          });
          return;
        }
        const memberRes = await fetch(
          `https://api.telegram.org/bot${serverConfig.telegramBotToken}/getChatMember?chat_id=${encodeURIComponent(
            task.telegram_chat_id
          )}&user_id=${user.telegram_id}`
        );
        const memberJson = (await memberRes.json()) as {
          ok?: boolean;
          result?: { status?: string };
        };
        const status = memberJson.result?.status;
        if (!memberJson.ok || !['member', 'administrator', 'creator'].includes(status || '')) {
          res.status(422).json({
            error: 'NOT_CHANNEL_MEMBER',
            message: 'You are not verified as a member of the required Telegram channel yet.',
          });
          return;
        }
      } else {
        // ads_code / social_link / custom: require opening link first if action_url is configured + dwell + code verification
        if (task.action_url) {
          if (!currentTaskState?.started_at) {
            res.status(422).json({
              error: 'TASK_NOT_STARTED',
              message: 'Please open the task / ad link first before verifying.',
            });
            return;
          }
          const minDwellMs = task.category === 'ads_code' ? 5_000 : 10_000;
          const elapsedMs = Date.now() - new Date(currentTaskState.started_at).getTime();
          if (elapsedMs < minDwellMs) {
            res.status(422).json({
              error: 'VERIFICATION_DWELL_REQUIRED',
              message: `Please complete the task action first (${Math.ceil((minDwellMs - elapsedMs) / 1000)}s remaining).`,
            });
            return;
          }
        }
        if (task.verification_code) {
          const submittedCode = safeText(req.body?.code, 64);
          if (!submittedCode) {
            res.status(422).json({
              error: 'CODE_REQUIRED',
              message: 'Enter the Ads / Task verification code to claim your coins.',
            });
            return;
          }
          if (submittedCode.toLowerCase() !== task.verification_code.trim().toLowerCase()) {
            res.status(422).json({
              error: 'INVALID_VERIFICATION_CODE',
              message: 'The submitted verification code does not match.',
            });
            return;
          }
        } else if (!task.action_url) {
          res.status(422).json({
            error: 'TASK_MISCONFIGURED',
            message: 'This task requires either a task link or a verification code configured by an admin.',
          });
          return;
        }
      }

      const updatedUser = await db.completeTask(user.id, task, { verifiedAt: new Date().toISOString() });
      const tasks = await db.getTasksForUser(user.id, false);
      res.json({ user: updatedUser, tasks, awarded: task.reward_amount });
    } catch (err) {
      res.status(400).json({ error: 'TASK_VERIFY_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // REFERRALS & LEADERBOARD
  // ============================================================================
  router.get('/referrals', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const settings = await db.getSettings();
      const data = await db.getReferralDashboard(user.id);
      const botUsername = await getResolvedBotUsername();
      const telegramInviteUrl = botUsername
        ? `https://t.me/${botUsername}?startapp=ref_${user.referral_code}`
        : null;

      res.json({
        referralCode: user.referral_code,
        telegramInviteUrl,
        webInviteUrl: `${serverConfig.appUrl.replace(/\/+$/, '')}/?ref=${user.referral_code}`,
        config: {
          l1FixedBonus: settings.referral_l1_fixed_bonus,
          l1Percent: settings.referral_l1_percent,
          l2Percent: settings.referral_l2_percent,
        },
        ...data,
      });
    } catch (err) {
      res.status(500).json({ error: 'REFERRALS_ERROR', message: (err as Error).message });
    }
  });

  router.get('/leaderboard', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const tab = req.query.tab === 'referrals' ? 'referrals' : 'miners';
      const period =
        req.query.period === 'weekly'
          ? 'weekly'
          : req.query.period === 'monthly'
            ? 'monthly'
            : 'all';
      const entries = await db.getLeaderboard(tab, period);
      const overview = await db.getAdminOverview();
      res.json({
        tab,
        period,
        entries,
        platformStats: {
          totalMiners: overview.totalUsers,
          totalMiningRewards: overview.totalMiningRewards,
          totalReferrals: overview.totalReferrals,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'LEADERBOARD_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // TON WALLET & 0.05 GRAM VERIFICATION
  // ============================================================================
  router.post('/wallet/connect', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      const addressInput = safeText(req.body?.address, 128);
      const provider = safeText(req.body?.provider, 64) || null;
      const normalized = normalizeTonAddress(addressInput);
      if (!normalized) {
        res.status(400).json({ error: 'INVALID_TON_ADDRESS', message: 'Invalid TON wallet address.' });
        return;
      }

      const wallet = await db.connectWallet(
        req.currentUser!.id,
        normalized.friendly,
        normalized.raw,
        provider
      );
      res.json({ wallet });
    } catch (err) {
      res.status(400).json({ error: 'WALLET_CONNECT_ERROR', message: (err as Error).message });
    }
  });

  router.post('/wallet/disconnect', requireAuth, actionLimiter, async (req: AuthedRequest, res) => {
    try {
      await db.disconnectWallet(req.currentUser!.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'WALLET_DISCONNECT_ERROR', message: (err as Error).message });
    }
  });

  router.post('/wallet/verify-gram', requireAuth, strictLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const settings = await db.getSettings();
      const activeWallet = await db.getActiveWallet(user.id);

      if (!activeWallet) {
        res.status(400).json({ error: 'NO_WALLET', message: 'Connect a TON wallet first.' });
        return;
      }
      if (activeWallet.is_suspended) {
        res.status(403).json({ error: 'WALLET_SUSPENDED', message: 'This wallet has been suspended.' });
        return;
      }
      if (activeWallet.is_verified) {
        res.json({ wallet: activeWallet, alreadyVerified: true });
        return;
      }

      const overrideWallet = settings.admin_ton_wallet_override;
      if (!isGramVerificationConfigured(overrideWallet)) {
        res.status(503).json({
          error: 'GRAM_VERIFICATION_NOT_CONFIGURED',
          message:
            'GRAM Jetton verification is disabled until GRAM_JETTON_MASTER_ADDRESS, GRAM_JETTON_DECIMALS, and ADMIN_TON_WALLET_ADDRESS are configured on the server.',
        });
        return;
      }

      const txHash = safeText(req.body?.txHash, 256);
      if (!txHash) {
        res.status(400).json({
          error: 'MISSING_TX_HASH',
          message: 'Transaction hash is required to verify the 0.05 GRAM transfer.',
        });
        return;
      }

      // Replay protection check before calling TON API
      if (await db.hasTxHashBeenUsed(txHash)) {
        res.status(409).json({
          error: 'DUPLICATE_TX_HASH',
          message: 'This transaction hash has already been used for verification.',
        });
        return;
      }

      const verification = await verifyGramJettonTransaction({
        txHash,
        expectedSenderAddress: activeWallet.wallet_address,
        expectedFeeDisplay: settings.gram_verification_fee,
        overrideAdminWallet: overrideWallet,
      });

      if (!verification.valid) {
        res.status(422).json({
          error: verification.errorCode || 'VERIFICATION_FAILED',
          message: verification.errorMessage || 'GRAM transaction could not be verified on-chain.',
        });
        return;
      }

      // Double-check normalized txHash replay
      if (await db.hasTxHashBeenUsed(verification.txHash!)) {
        res.status(409).json({
          error: 'DUPLICATE_TX_HASH',
          message: 'This blockchain event has already been claimed.',
        });
        return;
      }

      const saved = await db.recordVerifiedWalletPayment({
        userId: user.id,
        walletId: activeWallet.id,
        txHash: verification.txHash!,
        senderAddress: verification.senderRaw!,
        recipientAddress: verification.recipientRaw!,
        jettonMasterAddress: verification.jettonMasterRaw!,
        amountRaw: verification.amountRaw!,
        amountDisplay: verification.amountDisplay!,
        decimals: verification.decimals!,
      });

      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: 'GRAM_VERIFY_ERROR', message: (err as Error).message });
    }
  });

  router.get('/wallet/verifications', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const verifications = await db.getUserWalletVerifications(req.currentUser!.id);
      res.json({ verifications });
    } catch (err) {
      res.status(500).json({ error: 'VERIFICATIONS_FETCH_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // WITHDRAWALS & TRANSACTIONS
  // ============================================================================
  router.get('/withdrawals', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [withdrawals, settings] = await Promise.all([
        db.getUserWithdrawals(req.currentUser!.id),
        db.getSettings(),
      ]);
      res.json({
        withdrawals,
        limits: {
          minWithdrawal: settings.min_withdrawal,
          maxWithdrawal: settings.max_withdrawal,
        },
        isDemoTokenMode: !serverConfig.lovaJettonMasterAddress,
      });
    } catch (err) {
      res.status(500).json({ error: 'WITHDRAWALS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/withdrawals/request', requireAuth, strictLimiter, async (req: AuthedRequest, res) => {
    try {
      const user = req.currentUser!;
      const settings = await db.getSettings();
      if (settings.maintenance_mode || settings.emergency_pause) {
        res.status(403).json({ error: 'SYSTEM_PAUSED', message: 'Withdrawals are temporarily paused.' });
        return;
      }

      const activeWallet = await db.getActiveWallet(user.id);
      if (!activeWallet) {
        res.status(400).json({ error: 'WALLET_REQUIRED', message: 'Connect a TON wallet first.' });
        return;
      }
      if (activeWallet.is_suspended) {
        res.status(403).json({ error: 'WALLET_SUSPENDED', message: 'Your wallet is currently suspended.' });
        return;
      }
      if (!activeWallet.is_verified) {
        res.status(422).json({
          error: 'WALLET_UNVERIFIED',
          message: 'Complete the 0.05 GRAM wallet ownership verification before requesting a withdrawal.',
        });
        return;
      }

      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'INVALID_AMOUNT', message: 'Enter a valid withdrawal amount.' });
        return;
      }
      if (amount < settings.min_withdrawal || amount > settings.max_withdrawal) {
        res.status(400).json({
          error: 'OUT_OF_RANGE',
          message: `Withdrawal must be between ${settings.min_withdrawal} and ${settings.max_withdrawal} LOVA.`,
        });
        return;
      }

      const result = await db.requestWithdrawal(user, activeWallet.wallet_address, amount);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'WITHDRAWAL_REQUEST_ERROR', message: (err as Error).message });
    }
  });

  router.get('/transactions', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const transactions = await db.getUserTransactions(req.currentUser!.id);
      res.json({ transactions });
    } catch (err) {
      res.status(500).json({ error: 'TRANSACTIONS_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // ADMIN CONTROL CENTER ROUTES
  // ============================================================================
  router.post('/admin/login', strictLimiter, async (req: AuthedRequest, res) => {
    try {
      const secretInput = typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';

      // 1. Check server-side ADMIN_BOOTSTRAP_SECRET
      if (secretInput && serverConfig.adminBootstrapSecret) {
        const a = Buffer.from(secretInput);
        const b = Buffer.from(serverConfig.adminBootstrapSecret);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          const adminId = 'env-super-admin';
          const token = signSessionToken(
            { sub: adminId, tgId: 0, kind: 'admin', adminId, adminRole: 'super_admin' },
            60 * 60 * 8
          );
          setSessionCookie(res, ADMIN_COOKIE, token, 60 * 60 * 8);
          await db.writeAuditLog({
            admin_id: adminId,
            admin_role: 'super_admin',
            action: 'ADMIN_LOGIN',
            target_type: 'auth',
            target_id: adminId,
            details: { method: 'bootstrap_secret' },
            ip_address: req.ip || null,
          });
          res.json({ adminToken: token, role: 'super_admin', displayName: 'Super Admin' });
          return;
        }
        res.status(401).json({ error: 'INVALID_ADMIN_SECRET', message: 'Invalid administrator secret.' });
        return;
      }

      // 2. Check authenticated Telegram user against ADMIN_TELEGRAM_IDS or admins table
      const userToken = extractBearerOrCookie(req, SESSION_COOKIE, 'authorization');
      const userClaims = verifySessionToken(userToken);
      if (userClaims && userClaims.kind === 'user') {
        const tgId = userClaims.tgId;
        const dbAdmin = await db.getAdminByTelegramId(tgId);
        const inEnvList = serverConfig.adminTelegramIds.includes(tgId);

        if (dbAdmin || inEnvList) {
          const role: AdminRole = dbAdmin?.role || 'super_admin';
          const adminId = dbAdmin?.id || `tg-${tgId}`;
          const token = signSessionToken(
            { sub: userClaims.sub, tgId, kind: 'admin', adminId, adminRole: role },
            60 * 60 * 8
          );
          setSessionCookie(res, ADMIN_COOKIE, token, 60 * 60 * 8);
          await db.writeAuditLog({
            admin_id: adminId,
            admin_role: role,
            action: 'ADMIN_LOGIN',
            target_type: 'auth',
            target_id: adminId,
            details: { method: 'telegram_id', telegram_id: tgId },
            ip_address: req.ip || null,
          });
          res.json({
            adminToken: token,
            role,
            displayName: dbAdmin?.display_name || `Telegram Admin (${tgId})`,
          });
          return;
        }

        // 3. First-time preview bootstrap ONLY when in dev preview and no admin credentials exist yet
        const adminsCount = await db.getAdminsCount();
        if (
          serverConfig.telegramAllowDevPreview &&
          !serverConfig.adminBootstrapSecret &&
          serverConfig.adminTelegramIds.length === 0 &&
          adminsCount === 0 &&
          req.body?.bootstrapPreviewAdmin === true
        ) {
          const created = await db.upsertAdmin({
            telegram_id: tgId,
            email: null,
            display_name: 'Preview Super Admin',
            role: 'super_admin',
          });
          const token = signSessionToken(
            { sub: userClaims.sub, tgId, kind: 'admin', adminId: created.id, adminRole: created.role },
            60 * 60 * 8
          );
          setSessionCookie(res, ADMIN_COOKIE, token, 60 * 60 * 8);
          await db.writeAuditLog({
            admin_id: created.id,
            admin_role: created.role,
            action: 'ADMIN_PREVIEW_BOOTSTRAP',
            target_type: 'admins',
            target_id: created.id,
            details: { telegram_id: tgId },
            ip_address: req.ip || null,
          });
          res.json({ adminToken: token, role: created.role, displayName: created.display_name });
          return;
        }
      }

      res.status(401).json({
        error: 'ADMIN_AUTH_FAILED',
        message: 'Provide a valid server ADMIN_BOOTSTRAP_SECRET or sign in with an authorized Telegram Admin ID.',
      });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_LOGIN_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/me', requireAdmin, (req: AuthedRequest, res) => {
    res.json({
      adminId: req.adminSession!.adminId,
      role: req.adminSession!.adminRole,
      telegramId: req.adminSession!.tgId,
    });
  });

  router.post('/admin/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/admin/overview', requireAdmin, async (_req, res) => {
    try {
      const [overview, settings] = await Promise.all([db.getAdminOverview(), db.getSettings()]);
      res.json({
        overview,
        settings,
        systemStatus: getPublicSystemStatus(
          settings.gram_verification_fee,
          settings.admin_ton_wallet_override
        ),
      });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_OVERVIEW_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/users', requireAdmin, async (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const users = await db.listAdminUsers(search);
      res.json({ users });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_USERS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/users/:id/status', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const status = req.body?.status;
      if (!['active', 'suspended', 'banned'].includes(status)) {
        res.status(400).json({ error: 'INVALID_STATUS', message: 'Invalid user status.' });
        return;
      }
      const reason = safeText(req.body?.reason, 200);
      const updated = await db.setUserStatus(String(req.params.id), status, reason);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: `USER_${status.toUpperCase()}`,
        target_type: 'user',
        target_id: updated.id,
        details: { status, reason },
        ip_address: req.ip || null,
      });
      res.json({ user: updated });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_USER_STATUS_ERROR', message: (err as Error).message });
    }
  });

  router.patch('/admin/settings', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.adminSession!.adminRole === 'moderator') {
        res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'Moderators cannot change platform settings.' });
        return;
      }
      const body = req.body || {};
      const patch: Record<string, unknown> = {};
      const numFields = [
        'reward_rate_per_hour',
        'mining_duration_seconds',
        'min_claim_amount',
        'max_reward_per_session',
        'daily_bonus_amount',
        'referral_l1_fixed_bonus',
        'referral_l1_percent',
        'referral_l2_percent',
        'min_withdrawal',
        'max_withdrawal',
        'gram_verification_fee',
      ];
      for (const f of numFields) {
        if (body[f] !== undefined && Number.isFinite(Number(body[f])) && Number(body[f]) >= 0) {
          patch[f] = Number(body[f]);
        }
      }
      const boolFields = ['mining_enabled', 'emergency_pause', 'maintenance_mode'];
      for (const f of boolFields) {
        if (typeof body[f] === 'boolean') patch[f] = body[f];
      }
      if (typeof body.app_name === 'string' && body.app_name.trim()) {
        patch.app_name = safeText(body.app_name, 64);
      }
      if (typeof body.admin_ton_wallet_override === 'string') {
        const trimmed = body.admin_ton_wallet_override.trim();
        if (!trimmed) {
          patch.admin_ton_wallet_override = null;
        } else {
          const norm = normalizeTonAddress(trimmed);
          if (!norm) {
            res.status(400).json({ error: 'INVALID_TON_ADDRESS', message: 'Admin TON wallet address is invalid.' });
            return;
          }
          patch.admin_ton_wallet_override = norm.friendly;
        }
      }

      const settings = await db.updateSettings(patch);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'SETTINGS_UPDATED',
        target_type: 'app_settings',
        target_id: '1',
        details: patch,
        ip_address: req.ip || null,
      });
      res.json({ settings });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_SETTINGS_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/withdrawals', requireAdmin, async (_req, res) => {
    try {
      const withdrawals = await db.listAdminWithdrawals();
      res.json({ withdrawals });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_WITHDRAWALS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/withdrawals/:id/action', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.adminSession!.adminRole === 'moderator') {
        res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'Moderators cannot process withdrawals.' });
        return;
      }
      const action = req.body?.action;
      if (!['approve', 'reject', 'mark_paid'].includes(action)) {
        res.status(400).json({ error: 'INVALID_ACTION', message: 'Action must be approve, reject, or mark_paid.' });
        return;
      }

      let payoutTxHash = safeText(req.body?.payoutTxHash, 256);
      if (action === 'mark_paid') {
        if (!payoutTxHash) {
          res.status(400).json({
            error: 'PAYOUT_HASH_REQUIRED',
            message: 'A finalized TON payout transaction hash is required before marking a withdrawal as Paid.',
          });
          return;
        }
        const check = await verifyTonTransactionFinalized(payoutTxHash);
        if (!check.ok) {
          res.status(422).json({
            error: 'PAYOUT_TX_NOT_VERIFIED',
            message: check.error || 'Could not verify payout transaction finality on TON.',
          });
          return;
        }
        payoutTxHash = check.normalizedHash || payoutTxHash;
      }

      const updated = await db.processWithdrawalAction({
        withdrawalId: String(req.params.id),
        action,
        adminId: req.adminSession!.adminId || 'admin',
        adminNote: safeText(req.body?.adminNote, 200),
        payoutTxHash,
      });

      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: `WITHDRAWAL_${action.toUpperCase()}`,
        target_type: 'withdrawal',
        target_id: updated.id,
        details: { payoutTxHash: payoutTxHash || null, note: req.body?.adminNote || null },
        ip_address: req.ip || null,
      });

      res.json({ withdrawal: updated });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_WITHDRAWAL_ACTION_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/wallets', requireAdmin, async (_req, res) => {
    try {
      const data = await db.listAdminWalletsAndPayments();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_WALLETS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/wallets/:id/suspend', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const suspended = Boolean(req.body?.suspended);
      const wallet = await db.toggleWalletSuspension(String(req.params.id), suspended);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: suspended ? 'WALLET_SUSPENDED' : 'WALLET_UNSUSPENDED',
        target_type: 'user_wallet',
        target_id: wallet.id,
        details: { wallet_address: wallet.wallet_address },
        ip_address: req.ip || null,
      });
      res.json({ wallet });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_WALLET_SUSPEND_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/tasks', requireAdmin, async (_req, res) => {
    try {
      const tasks = await db.getTasksForUser('00000000-0000-0000-0000-000000000000', true);
      res.json({ tasks });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_TASKS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/tasks', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const task = await db.createOrUpdateTask(req.body || {});
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: req.body?.id ? 'TASK_UPDATED' : 'TASK_CREATED',
        target_type: 'task',
        target_id: task.id,
        details: { title: task.title, reward: task.reward_amount },
        ip_address: req.ip || null,
      });
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_TASK_SAVE_ERROR', message: (err as Error).message });
    }
  });

  router.delete('/admin/tasks/:id', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      await db.deleteTask(id);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'TASK_DELETED',
        target_type: 'task',
        target_id: id,
        details: {},
        ip_address: req.ip || null,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_TASK_DELETE_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/announcements', requireAdmin, async (_req, res) => {
    try {
      const announcements = await db.getAnnouncements(true);
      res.json({ announcements });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_ANNOUNCEMENTS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/announcements', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const title = safeText(req.body?.title, 120);
      const body = safeText(req.body?.body, 600);
      const category = ['airdrop', 'update', 'maintenance', 'security'].includes(req.body?.category)
        ? req.body.category
        : 'airdrop';
      if (!title || !body) {
        res.status(400).json({ error: 'INVALID_ANNOUNCEMENT', message: 'Title and body are required.' });
        return;
      }
      const announcement = await db.createAnnouncement({ title, body, category, is_active: true });
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'ANNOUNCEMENT_CREATED',
        target_type: 'announcement',
        target_id: announcement.id,
        details: { title, category },
        ip_address: req.ip || null,
      });
      res.json({ announcement });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_ANNOUNCEMENT_ERROR', message: (err as Error).message });
    }
  });

  router.delete('/admin/announcements/:id', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      await db.deleteAnnouncement(id);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'ANNOUNCEMENT_DELETED',
        target_type: 'announcement',
        target_id: id,
        details: {},
        ip_address: req.ip || null,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_ANNOUNCEMENT_DELETE_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/referrals', requireAdmin, async (_req, res) => {
    try {
      const data = await db.listAdminReferrals();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_REFERRALS_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/audit-logs', requireAdmin, async (_req, res) => {
    try {
      const logs = await db.listAuditLogs();
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_AUDIT_ERROR', message: (err as Error).message });
    }
  });

  // ============================================================================
  // ADMIN TELEGRAM BOT, TEAM ROLES & SCHEMA SETUP
  // ============================================================================
  router.get('/admin/telegram/status', requireAdmin, async (req, res) => {
    try {
      const status = await getBotStatus();
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
        .split(',')[0]
        .trim();
      const detectedOrigin = host ? `${proto}://${host}` : serverConfig.appUrl;
      res.json({
        ...status,
        detectedOrigin,
      });
    } catch (err) {
      res.status(500).json({ error: 'BOT_STATUS_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/telegram/configure', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.adminSession!.adminRole === 'moderator') {
        res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'Moderators cannot configure the Telegram Bot.' });
        return;
      }
      if (!serverConfig.telegramBotToken) {
        res.status(400).json({
          error: 'TELEGRAM_BOT_TOKEN_MISSING',
          message: 'Set TELEGRAM_BOT_TOKEN in your server environment secrets before connecting the bot.',
        });
        return;
      }
      const miniAppUrl = safeText(req.body?.miniAppUrl, 300);
      const registerWebhook = req.body?.registerWebhook !== false;
      const result = await configureBotConnection({ miniAppUrl, registerWebhook });

      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'TELEGRAM_BOT_CONFIGURED',
        target_type: 'telegram_bot',
        target_id: result.status.bot?.username || 'bot',
        details: { miniAppUrl, registerWebhook, ok: result.ok },
        ip_address: req.ip || null,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'BOT_CONFIGURE_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/telegram/webhook-health', requireAdmin, async (req, res) => {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
        .split(',')[0]
        .trim();
      const defaultWebhookUrl = host
        ? `${proto}://${host}/api/telegram/webhook`
        : `${serverConfig.appUrl.replace(/\/+$/, '')}/api/telegram/webhook`;

      const rawUrl = safeText(req.body?.url, 400) || defaultWebhookUrl;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        res.status(400).json({ error: 'INVALID_URL', message: 'Enter a valid http(s) webhook URL.' });
        return;
      }

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        res.status(400).json({ error: 'INVALID_PROTOCOL', message: 'URL must use https:// or http://.' });
        return;
      }

      // SSRF protection: block cloud metadata and private RFC1918 networks unless matching current app host
      const hostname = parsed.hostname.toLowerCase();
      const isPrivateOrMetadata =
        hostname === 'metadata.google.internal' ||
        hostname.startsWith('169.254.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
      if (isPrivateOrMetadata) {
        res.status(400).json({ error: 'BLOCKED_HOST', message: 'Private or metadata IP addresses cannot be probed.' });
        return;
      }

      // If probing our own current host, also support probing local loopback port directly if needed
      const currentHostOnly = host.split(':')[0].toLowerCase();
      const isSameLocalHost =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        (currentHostOnly && hostname === currentHostOnly && parsed.hostname === host.split(':')[0]);
      const probeTarget =
        hostname === 'localhost' || hostname === '127.0.0.1'
          ? `http://127.0.0.1:${serverConfig.port}${parsed.pathname}${parsed.search}`
          : parsed.toString();

      const started = Date.now();
      let getStatus: number | null = null;
      let postStatus: number | null = null;
      let redirectLocation: string | null = null;
      let responsePreview: string | null = null;
      let fetchError: string | null = null;

      try {
        const getRes = await fetch(probeTarget, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
        });
        getStatus = getRes.status;
        if (getStatus >= 300 && getStatus < 400) {
          redirectLocation = getRes.headers.get('location');
        }
      } catch (err) {
        fetchError = err instanceof Error ? err.message : 'GET request failed';
      }

      try {
        const postRes = await fetch(probeTarget, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update_id: 0 }),
          signal: AbortSignal.timeout(6000),
        });
        postStatus = postRes.status;
        if (!redirectLocation && postStatus >= 300 && postStatus < 400) {
          redirectLocation = postRes.headers.get('location');
        }
        const txt = await postRes.text().catch(() => '');
        responsePreview = txt.replace(/\s+/g, ' ').trim().slice(0, 220) || null;
      } catch (err) {
        if (!fetchError) {
          fetchError = err instanceof Error ? err.message : 'POST request failed';
        }
      }

      const latencyMs = Date.now() - started;
      const reachable = getStatus !== null || postStatus !== null;
      const healthy = postStatus === 200 || postStatus === 403;

      let summary = '';
      if (!reachable) {
        summary = fetchError || 'Endpoint unreachable (DNS, TLS, or network timeout).';
      } else if (postStatus === 200) {
        summary = 'Healthy — Webhook endpoint responded with HTTP 200 OK.';
      } else if (postStatus === 403) {
        summary = 'Reachable — Webhook endpoint is live and enforcing secret token verification (HTTP 403 without secret).';
      } else if (postStatus !== null && postStatus >= 300 && postStatus < 400) {
        summary = `Blocked by HTTP ${postStatus} redirect${
          redirectLocation ? ` to ${redirectLocation}` : ''
        }. Telegram requires a public endpoint without an authentication gate.`;
      } else if (postStatus === 404) {
        summary = 'HTTP 404 Not Found — Webhook route is not deployed or missing at this URL.';
      } else {
        summary = `Unexpected HTTP ${postStatus ?? getStatus} response from webhook URL.`;
      }

      res.json({
        url: parsed.toString(),
        probedLocally: Boolean(isSameLocalHost && (hostname === 'localhost' || hostname === '127.0.0.1')),
        checkedAt: new Date().toISOString(),
        reachable,
        healthy,
        latencyMs,
        getStatus,
        postStatus,
        redirectLocation,
        summary,
        responsePreview,
      });
    } catch (err) {
      res.status(500).json({ error: 'WEBHOOK_HEALTH_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/admins', requireAdmin, async (_req, res) => {
    try {
      const admins = await db.listAdmins();
      res.json({
        admins,
        envAdminTelegramIds: serverConfig.adminTelegramIds,
      });
    } catch (err) {
      res.status(500).json({ error: 'ADMIN_LIST_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/admins', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.adminSession!.adminRole !== 'super_admin') {
        res.status(403).json({
          error: 'FORBIDDEN_ROLE',
          message: 'Only a super_admin can add or edit admin team members.',
        });
        return;
      }
      const telegramId = Number(req.body?.telegram_id);
      const displayName = safeText(req.body?.display_name, 80) || `Admin ${telegramId}`;
      const role = req.body?.role as AdminRole;
      if (!Number.isInteger(telegramId) || telegramId <= 0) {
        res.status(400).json({ error: 'INVALID_TELEGRAM_ID', message: 'Valid numeric Telegram ID required.' });
        return;
      }
      if (!['super_admin', 'finance_admin', 'moderator'].includes(role)) {
        res.status(400).json({ error: 'INVALID_ROLE', message: 'Role must be super_admin, finance_admin, or moderator.' });
        return;
      }
      const admin = await db.upsertAdmin({
        telegram_id: telegramId,
        email: null,
        display_name: displayName,
        role,
      });
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: 'ADMIN_UPSERTED',
        target_type: 'admins',
        target_id: admin.id,
        details: { telegram_id: telegramId, role, display_name: displayName },
        ip_address: req.ip || null,
      });
      res.json({ admin });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_UPSERT_ERROR', message: (err as Error).message });
    }
  });

  router.post('/admin/admins/:id/toggle', requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.adminSession!.adminRole !== 'super_admin') {
        res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'Only a super_admin can modify admin roles.' });
        return;
      }
      const isActive = Boolean(req.body?.is_active);
      const admin = await db.toggleAdminActive(String(req.params.id), isActive);
      await db.writeAuditLog({
        admin_id: req.adminSession!.adminId || 'admin',
        admin_role: req.adminSession!.adminRole || 'super_admin',
        action: isActive ? 'ADMIN_ACTIVATED' : 'ADMIN_DEACTIVATED',
        target_type: 'admins',
        target_id: admin.id,
        details: { telegram_id: admin.telegram_id, role: admin.role },
        ip_address: req.ip || null,
      });
      res.json({ admin });
    } catch (err) {
      res.status(400).json({ error: 'ADMIN_TOGGLE_ERROR', message: (err as Error).message });
    }
  });

  router.get('/admin/schema-sql', requireAdmin, (_req, res) => {
    try {
      const schemaPath = path.resolve(process.cwd(), 'supabase', 'schema.sql');
      if (!fs.existsSync(schemaPath)) {
        res.status(404).json({ error: 'SCHEMA_NOT_FOUND', message: 'supabase/schema.sql not found.' });
        return;
      }
      const sql = fs.readFileSync(schemaPath, 'utf8');
      res.json({ sql });
    } catch (err) {
      res.status(500).json({ error: 'SCHEMA_READ_ERROR', message: (err as Error).message });
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'API_NOT_FOUND', message: 'Unknown API endpoint.' });
  });

  return router;
}

async function buildBootstrapPayload(user: LovaUser) {
  const [activeSession, activeWallet, settings, announcements, resolvedBotUsername] =
    await Promise.all([
      db.getActiveOrExpiredSession(user.id),
      db.getActiveWallet(user.id),
      db.getSettings(),
      db.getAnnouncements(false),
      getResolvedBotUsername(),
    ]);

  const todayUtc = new Date().toISOString().slice(0, 10);
  const systemStatus = getPublicSystemStatus(
    settings.gram_verification_fee,
    settings.admin_ton_wallet_override
  );
  if (resolvedBotUsername) {
    systemStatus.telegramBotUsername = resolvedBotUsername;
  }

  return {
    user,
    activeSession,
    activeWallet,
    settings,
    announcements,
    systemStatus,
    serverTime: new Date().toISOString(),
    canCheckInToday: user.last_checkin_date !== todayUtc,
  };
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}
