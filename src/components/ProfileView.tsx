import { useEffect, useState } from 'react';
import { CheckCircle2, Lock, RefreshCw, Server, Shield, UserCheck, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { LovaUser, PublicSystemStatus, TransactionItem, UserWallet } from '../types/lova';

interface ProfileViewProps {
  user: LovaUser;
  activeWallet: UserWallet | null;
  systemStatus: PublicSystemStatus;
  onOpenAdmin: () => void;
  onRefreshBootstrap?: () => Promise<void>;
}

export function ProfileView({
  user,
  activeWallet,
  systemStatus,
  onOpenAdmin,
  onRefreshBootstrap,
}: ProfileViewProps) {
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await apiFetch<{ transactions: TransactionItem[] }>('/api/transactions');
        setTransactions(res.transactions);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, [user.id, user.total_earned]);

  const configChecks = [
    {
      label: 'Supabase PostgreSQL',
      ok: systemStatus.databaseMode === 'supabase',
      detail:
        systemStatus.databaseMode === 'supabase'
          ? 'Connected via service role on server'
          : systemStatus.databaseMode === 'supabase_needs_schema'
            ? 'Supabase credentials detected, but supabase/schema.sql has not been executed in Supabase SQL Editor yet. Running on local preview store until applied.'
            : 'Local preview store active (set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY for production)',
    },
    {
      label: 'Telegram Bot HMAC Validation',
      ok: systemStatus.telegramBotConfigured,
      detail: systemStatus.telegramBotConfigured
        ? 'HMAC-SHA256 initData validation enabled'
        : 'Preview fallback active (set TELEGRAM_BOT_TOKEN for Telegram Mini App production)',
    },
    {
      label: '0.05 GRAM Jetton Verification',
      ok: systemStatus.gramVerificationConfigured,
      detail: systemStatus.gramVerificationConfigured
        ? 'Configured and verifying against TON API'
        : 'Disabled safely until GRAM_JETTON_MASTER_ADDRESS, decimals & ADMIN_TON_WALLET_ADDRESS are set',
    },
    {
      label: 'LOVA Mintable Jetton (1B Supply)',
      ok: !systemStatus.isDemoTokenMode,
      detail: systemStatus.isDemoTokenMode
        ? 'Pre-launch Demo Balance mode until LOVA_JETTON_MASTER_ADDRESS is deployed'
        : `Contract: ${systemStatus.lovaJettonMasterAddress}`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* User Identity Card */}
      <section className="glass-panel-elevated rounded-3xl p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-white font-display font-bold text-xl shrink-0">
            {(user.first_name || user.username || 'L')[0].toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">
              {user.first_name || 'LOVA Miner'} {user.last_name || ''}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 mt-1">
              <span>{user.username ? `@${user.username}` : 'Telegram User'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">TG ID: {user.telegram_id}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-blue-300">Ref: {user.referral_code}</span>
              <span aria-hidden="true">·</span>
              <span>Joined {new Date(user.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenAdmin}
          className="min-h-[44px] px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors shrink-0"
        >
          <Lock className="w-4 h-4 text-blue-400" />
          Admin Control Center
        </button>
      </section>

      {/* Account & Security Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 glass-panel rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-400" />
              <h2 className="text-base font-semibold text-white">System & Credential Readiness</h2>
            </div>
            {onRefreshBootstrap && (
              <button
                type="button"
                disabled={refreshing}
                onClick={async () => {
                  try {
                    setRefreshing(true);
                    await onRefreshBootstrap();
                  } finally {
                    setRefreshing(false);
                  }
                }}
                aria-label="Refresh status"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-800/70">
            {configChecks.map((item) => (
              <div key={item.label} className="py-3 first:pt-0 last:pb-0 flex items-start gap-3">
                {item.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="text-sm font-medium text-slate-100">{item.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-slate-800/70 flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-blue-400" />
              Account Status: <strong className="text-slate-200 capitalize">{user.status}</strong>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-blue-400" />
              Wallet: {activeWallet?.is_verified ? 'Verified' : 'Unverified'}
            </span>
          </div>
        </section>

        {/* Unified Transaction Ledger */}
        <section className="lg:col-span-7 glass-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-4">Account Activity Ledger</h2>
          {loading ? (
            <div className="space-y-2">
              <div className="h-10 rounded-lg bg-slate-800/50" />
              <div className="h-10 rounded-lg bg-slate-800/50" />
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-slate-400 py-10 text-center">
              No account transactions recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70 max-h-[420px] overflow-y-auto pr-1">
              {transactions.map((tx) => (
                <div key={tx.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-100 truncate">{tx.description}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {tx.tx_type.replace('_', ' ')} ·{' '}
                      {tx.is_demo ? 'Demo Balance' : 'On-Chain'} ·{' '}
                      {new Date(tx.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="font-mono tabular-nums text-sm font-semibold text-blue-300 shrink-0">
                    {tx.tx_type === 'withdrawal_request' ? '-' : '+'}
                    {tx.amount.toFixed(tx.currency === 'GRAM' ? 2 : 4)} {tx.currency}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
