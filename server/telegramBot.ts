import crypto from 'crypto';
import { serverConfig } from './config.ts';
import { db } from './db.ts';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
}

export interface TelegramMenuButton {
  type: 'default' | 'commands' | 'web_app';
  text?: string;
  web_app?: { url: string };
}

export interface TelegramBotStatusPayload {
  configured: boolean;
  bot: TelegramBotInfo | null;
  webhook: TelegramWebhookInfo | null;
  menuButton: TelegramMenuButton | null;
  error: string | null;
}

let cachedBot: { tokenPrefix: string; username: string; fetchedAt: number } | null = null;

function getTokenPrefix(token: string): string {
  return token.split(':')[0] || 'unknown';
}

export function getWebhookSecret(): string {
  if (serverConfig.telegramWebhookSecret) {
    return serverConfig.telegramWebhookSecret;
  }
  const stableSeed =
    serverConfig.explicitSessionSecret || serverConfig.telegramBotToken || 'lova-fallback-seed';
  return crypto
    .createHmac('sha256', stableSeed)
    .update('lova-telegram-webhook-v1')
    .digest('hex')
    .slice(0, 48);
}

async function callTelegramApi<T>(
  method: string,
  payload?: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  const token = serverConfig.telegramBotToken;
  if (!token) {
    return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not configured on the server.' };
  }

  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const data = (await res.json().catch(() => ({
    ok: false,
    description: `Invalid JSON response (${res.status})`,
  }))) as TelegramApiResponse<T>;

  return data;
}

export async function getResolvedBotUsername(): Promise<string | null> {
  const token = serverConfig.telegramBotToken;
  if (!token) {
    return serverConfig.telegramBotUsername
      ? serverConfig.telegramBotUsername.replace(/^@+/, '')
      : null;
  }

  const prefix = getTokenPrefix(token);
  if (cachedBot && cachedBot.tokenPrefix === prefix && Date.now() - cachedBot.fetchedAt < 300_000) {
    return cachedBot.username;
  }

  try {
    const me = await callTelegramApi<TelegramBotInfo>('getMe');
    if (me.ok && me.result?.username) {
      const clean = me.result.username.replace(/^@+/, '');
      cachedBot = { tokenPrefix: prefix, username: clean, fetchedAt: Date.now() };
      return clean;
    }
  } catch {
    // fallback below
  }
  return serverConfig.telegramBotUsername
    ? serverConfig.telegramBotUsername.replace(/^@+/, '')
    : null;
}

export async function getBotStatus(): Promise<TelegramBotStatusPayload> {
  if (!serverConfig.telegramBotToken) {
    return {
      configured: false,
      bot: null,
      webhook: null,
      menuButton: null,
      error: 'TELEGRAM_BOT_TOKEN is not set in server environment secrets.',
    };
  }

  try {
    const [meRes, webhookRes, menuRes] = await Promise.all([
      callTelegramApi<TelegramBotInfo>('getMe'),
      callTelegramApi<TelegramWebhookInfo>('getWebhookInfo'),
      callTelegramApi<TelegramMenuButton>('getChatMenuButton'),
    ]);

    if (meRes.ok && meRes.result?.username) {
      cachedBot = {
        tokenPrefix: getTokenPrefix(serverConfig.telegramBotToken),
        username: meRes.result.username.replace(/^@+/, ''),
        fetchedAt: Date.now(),
      };
    }

    const errors: string[] = [];
    if (!meRes.ok && meRes.description) errors.push(`getMe: ${meRes.description}`);
    if (!webhookRes.ok && webhookRes.description) errors.push(`getWebhookInfo: ${webhookRes.description}`);
    if (!menuRes.ok && menuRes.description) errors.push(`getChatMenuButton: ${menuRes.description}`);

    return {
      configured: true,
      bot: meRes.ok ? meRes.result || null : null,
      webhook: webhookRes.ok ? webhookRes.result || null : null,
      menuButton: menuRes.ok ? menuRes.result || null : null,
      error: errors.length > 0 ? errors.join(' | ') : null,
    };
  } catch (err) {
    return {
      configured: true,
      bot: null,
      webhook: null,
      menuButton: null,
      error: err instanceof Error ? err.message : 'Failed to reach Telegram Bot API.',
    };
  }
}

export async function configureBotConnection(input: {
  miniAppUrl: string;
  registerWebhook: boolean;
}): Promise<{
  ok: boolean;
  steps: {
    commands: { ok: boolean; detail: string };
    menuButton: { ok: boolean; detail: string };
    webhook: { ok: boolean; detail: string; skipped?: boolean };
  };
  status: TelegramBotStatusPayload;
}> {
  const cleanUrl = input.miniAppUrl.trim().replace(/\/+$/, '');
  if (!cleanUrl.startsWith('https://')) {
    throw new Error('Telegram requires an HTTPS URL for Mini Apps and Webhooks (https://...).');
  }

  const commandsRes = await callTelegramApi<boolean>('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open LOVA Mining Mini App' },
      { command: 'mine', description: 'Launch mining core & daily check-in' },
      { command: 'balance', description: 'View your LOVA Demo Balance' },
      { command: 'referral', description: 'Get your referral invite link' },
      { command: 'help', description: 'LOVA Mining guide & support' },
    ],
  });

  const menuRes = await callTelegramApi<boolean>('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Launch LOVA',
      web_app: { url: cleanUrl },
    },
  });

  let webhookStep: { ok: boolean; detail: string; skipped?: boolean } = {
    ok: true,
    skipped: true,
    detail: 'Webhook registration skipped by admin.',
  };

  if (input.registerWebhook) {
    const webhookUrl = `${cleanUrl}/api/telegram/webhook`;
    const whRes = await callTelegramApi<boolean>('setWebhook', {
      url: webhookUrl,
      secret_token: getWebhookSecret(),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    webhookStep = {
      ok: whRes.ok,
      detail: whRes.ok ? `Webhook registered at ${webhookUrl}` : whRes.description || 'setWebhook failed',
    };
  }

  const status = await getBotStatus();
  const ok = commandsRes.ok && menuRes.ok && webhookStep.ok;

  return {
    ok,
    steps: {
      commands: {
        ok: commandsRes.ok,
        detail: commandsRes.ok ? 'Bot commands synced (/start, /mine, /balance, /referral, /help)' : commandsRes.description || 'Failed',
      },
      menuButton: {
        ok: menuRes.ok,
        detail: menuRes.ok ? `Menu button linked to ${cleanUrl}` : menuRes.description || 'Failed',
      },
      webhook: webhookStep,
    },
    status,
  };
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  webAppUrl?: string,
  buttonLabel = '🚀 Open LOVA Mining'
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (webAppUrl && webAppUrl.startsWith('https://')) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: buttonLabel,
            web_app: { url: webAppUrl },
          },
        ],
      ],
    };
  }

  await callTelegramApi('sendMessage', payload).catch(() => undefined);
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: { id: number };
  };
}

export async function handleTelegramWebhookUpdate(update: TelegramUpdate, appOrigin: string) {
  if (!serverConfig.telegramBotToken) return;

  if (update.callback_query?.id) {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: update.callback_query.id,
    }).catch(() => undefined);
  }

  const msg = update.message;
  if (!msg || !msg.text || !msg.chat?.id) return;

  const text = msg.text.trim();
  const [rawCmd, rawArg] = text.split(/\s+/, 2);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const cleanOrigin = appOrigin.replace(/\/+$/, '');

  if (cmd === '/start') {
    const startArg = (rawArg || '').trim();
    const launchUrl = startArg
      ? `${cleanOrigin}/?tgWebAppStartParam=${encodeURIComponent(startArg)}`
      : cleanOrigin;

    const firstName = msg.from?.first_name ? `, ${msg.from.first_name}` : '';
    const refNote = startArg.startsWith('ref_')
      ? '\n\nReferral invite detected and attached to your session.'
      : '';

    await sendTelegramMessage(
      msg.chat.id,
      `<b>Welcome to LOVA Mining${firstName}!</b>\nMine Today, Earn Tomorrow.\n\nTap below to launch the LOVA Mini App, start your mining session, complete tasks, and connect your TON wallet.${refNote}`,
      launchUrl,
      '🚀 Launch LOVA Mining'
    );
    return;
  }

  if (cmd === '/mine') {
    await sendTelegramMessage(
      msg.chat.id,
      '<b>LOVA Mining Core</b>\nStart or claim your server-verified mining session and daily streak bonus inside the Mini App.',
      cleanOrigin,
      '⚡ Open Mining Core'
    );
    return;
  }

  if (cmd === '/balance' || cmd === '/referral') {
    const tgId = msg.from?.id;
    let user = null;
    if (tgId) {
      try {
        user = await db.getUserByTelegramId(tgId);
      } catch {
        user = null;
      }
    }
    if (!user) {
      await sendTelegramMessage(
        msg.chat.id,
        'Open the LOVA Mining Mini App first to initialize your miner profile.',
        cleanOrigin,
        '🚀 Initialize Account'
      );
      return;
    }

    if (cmd === '/balance') {
      await sendTelegramMessage(
        msg.chat.id,
        `<b>Your LOVA Account (Demo Balance)</b>\nAvailable: <code>${user.available_balance.toFixed(
          4
        )} LOVA</code>\nPending Withdrawal: <code>${user.pending_balance.toFixed(
          2
        )} LOVA</code>\nTotal Earned: <code>${user.total_earned.toFixed(
          4
        )} LOVA</code>\nDaily Streak: <b>${user.streak_days} days</b>`,
        cleanOrigin,
        '💼 Open Wallet & Mining'
      );
      return;
    }

    const botUsername = await getResolvedBotUsername();
    const refLink = botUsername
      ? `https://t.me/${botUsername}?startapp=ref_${user.referral_code}`
      : `${cleanOrigin}/?ref=${user.referral_code}`;
    await sendTelegramMessage(
      msg.chat.id,
      `<b>Your LOVA Referral Link</b>\n<code>${refLink}</code>\n\nShare this link to earn multi-level LOVA referral bonuses when friends join and mine.`,
      cleanOrigin,
      '👥 Open Friends Tab'
    );
    return;
  }

  if (cmd === '/help') {
    await sendTelegramMessage(
      msg.chat.id,
      `<b>LOVA Mining Commands</b>\n/start — Launch LOVA Mining Mini App\n/mine — Open Mining Core\n/balance — Check LOVA Demo Balance\n/referral — Get your invite link\n/help — Show this guide`,
      cleanOrigin,
      '🚀 Open LOVA Mining'
    );
    return;
  }

  if (msg.chat.type === 'private') {
    await sendTelegramMessage(
      msg.chat.id,
      `<b>LOVA Mining</b> — Mine Today, Earn Tomorrow.\n\nUse /start, /mine, /balance, or /referral, or tap the button below to launch the Mini App.`,
      cleanOrigin,
      '🚀 Open LOVA Mining'
    );
  }
}
