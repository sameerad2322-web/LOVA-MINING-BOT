import crypto from 'crypto';
import dotenv from 'dotenv';
import type { PublicSystemStatus } from '../src/types/lova.ts';

dotenv.config();

const runtimeFallbackSecret = crypto.randomBytes(32).toString('hex');

function normalizeBotToken(raw: string): string {
  return raw
    .trim()
    .replace(/^TELEGRAM_BOT_TOKEN\s*=\s*/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .replace(/^bot(?=\d+:)/i, '');
}

export const serverConfig = {
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Telegram
  telegramBotToken: normalizeBotToken(process.env.TELEGRAM_BOT_TOKEN || ''),
  telegramBotUsername: (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@+/, '') || null,
  telegramWebhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim() || null,
  telegramAllowDevPreview:
    process.env.TELEGRAM_ALLOW_DEV_PREVIEW !== 'false' && process.env.NODE_ENV !== 'production',

  // Supabase
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseServiceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),

  // Session & Admin
  explicitSessionSecret: (process.env.SESSION_SECRET || '').trim() || null,
  sessionSecret: (process.env.SESSION_SECRET || '').trim() || runtimeFallbackSecret,
  adminBootstrapSecret: (process.env.ADMIN_BOOTSTRAP_SECRET || '').trim(),
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0),

  // TON & GRAM Verification (never invent or hardcode a GRAM contract address)
  gramJettonMasterAddress: (process.env.GRAM_JETTON_MASTER_ADDRESS || '').trim() || null,
  gramJettonDecimals: process.env.GRAM_JETTON_DECIMALS
    ? Number(process.env.GRAM_JETTON_DECIMALS)
    : null,
  adminTonWalletAddress: (process.env.ADMIN_TON_WALLET_ADDRESS || '').trim() || null,
  tonApiEndpoint: (process.env.TON_API_ENDPOINT || 'https://tonapi.io/v2').trim().replace(/\/+$/, ''),
  tonApiKey: (process.env.TON_API_KEY || '').trim() || null,
  tonconnectManifestUrl: (process.env.TONCONNECT_MANIFEST_URL || '').trim() || null,

  // LOVA Token Deployment
  lovaJettonMasterAddress: (process.env.LOVA_JETTON_MASTER_ADDRESS || '').trim() || null,
};

let supabaseSchemaReady = false;

export function setSupabaseSchemaReady(ready: boolean) {
  supabaseSchemaReady = ready;
}

export function hasSupabaseConfig(): boolean {
  return Boolean(serverConfig.supabaseUrl && serverConfig.supabaseServiceRoleKey);
}

export function isGramVerificationConfigured(overrideAdminWallet?: string | null): boolean {
  const adminWallet = (overrideAdminWallet || serverConfig.adminTonWalletAddress || '').trim();
  return Boolean(
    serverConfig.gramJettonMasterAddress &&
      serverConfig.gramJettonDecimals !== null &&
      Number.isInteger(serverConfig.gramJettonDecimals) &&
      serverConfig.gramJettonDecimals >= 0 &&
      serverConfig.gramJettonDecimals <= 18 &&
      adminWallet
  );
}

export function getPublicSystemStatus(
  gramFee = 0.05,
  overrideAdminWallet?: string | null
): PublicSystemStatus {
  const adminWallet = (overrideAdminWallet || serverConfig.adminTonWalletAddress || '').trim() || null;
  const dbMode: PublicSystemStatus['databaseMode'] = !hasSupabaseConfig()
    ? 'local_preview'
    : supabaseSchemaReady
      ? 'supabase'
      : 'supabase_needs_schema';
  return {
    databaseMode: dbMode,
    telegramAuthMode:
      serverConfig.telegramBotToken && !serverConfig.telegramAllowDevPreview
        ? 'hmac_strict'
        : serverConfig.telegramBotToken
          ? 'hmac_strict'
          : 'preview_fallback',
    telegramBotConfigured: Boolean(serverConfig.telegramBotToken),
    telegramBotUsername: serverConfig.telegramBotUsername,
    isDemoTokenMode: !serverConfig.lovaJettonMasterAddress,
    lovaJettonMasterAddress: serverConfig.lovaJettonMasterAddress,
    gramVerificationConfigured: isGramVerificationConfigured(adminWallet),
    gramVerificationFee: gramFee,
    gramJettonMasterAddress: serverConfig.gramJettonMasterAddress,
    gramJettonDecimals: serverConfig.gramJettonDecimals,
    adminTonWalletAddress: adminWallet,
    tonApiConfigured: Boolean(serverConfig.tonApiEndpoint),
    tonconnectManifestUrl: serverConfig.tonconnectManifestUrl,
    adminBootstrapConfigured: Boolean(
      serverConfig.adminBootstrapSecret || serverConfig.adminTelegramIds.length > 0
    ),
  };
}
