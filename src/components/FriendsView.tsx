import { useEffect, useState } from 'react';
import { Check, Copy, Share2, UserPlus, Users } from 'lucide-react';
import { apiFetch, getTelegramWebApp } from '../lib/api';

interface ReferralData {
  referralCode: string;
  telegramInviteUrl: string | null;
  webInviteUrl: string;
  config: {
    l1FixedBonus: number;
    l1Percent: number;
    l2Percent: number;
  };
  level1Count: number;
  level2Count: number;
  totalReferralEarned: number;
  invited: Array<{
    id: string;
    level: 1 | 2;
    created_at: string;
    handle: string;
    total_earned: number;
  }>;
  rewards: Array<{
    id: string;
    level: 1 | 2;
    reward_source: 'signup_fixed' | 'mining_commission';
    amount: number;
    created_at: string;
  }>;
}

interface FriendsViewProps {
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}

export function FriendsView({ onToast }: FriendsViewProps) {
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await apiFetch<ReferralData>('/api/referrals');
        setData(res);
      } catch (err) {
        onToast('error', (err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const inviteUrl = data?.telegramInviteUrl || data?.webInviteUrl || '';

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      onToast('success', 'Referral link copied to clipboard.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onToast('error', 'Failed to copy link.');
    }
  };

  const handleShare = async () => {
    if (!inviteUrl) return;
    const text = 'Mine LOVA on TON with me — Mine Today, Earn Tomorrow!';
    const tg = getTelegramWebApp();
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(text)}`
      );
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: 'LOVA Mining', text, url: inviteUrl });
        return;
      } catch {
        // fallback to copy
      }
    }
    await handleCopy();
  };

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="h-44 rounded-3xl bg-slate-900/60" />
        <div className="h-64 rounded-2xl bg-slate-900/60" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero Referral Invite Card */}
      <section className="glass-panel-elevated rounded-3xl p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="max-w-xl">
            <h1 className="text-2xl sm:text-3xl font-bold text-white">
              Invite Friends, Grow Multi-Level Rewards
            </h1>
            <p className="text-sm text-slate-300 mt-2 leading-relaxed">
              Earn{' '}
              <span className="font-mono font-semibold text-blue-300">
                +{data.config.l1FixedBonus} LOVA
              </span>{' '}
              when a direct friend joins, plus{' '}
              <span className="font-mono font-semibold text-blue-300">
                {data.config.l1Percent}%
              </span>{' '}
              from Level 1 claims and{' '}
              <span className="font-mono font-semibold text-violet-300">
                {data.config.l2Percent}%
              </span>{' '}
              from Level 2 referrals. Self-referrals and duplicate accounts are automatically blocked.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 shrink-0">
            <button
              type="button"
              onClick={handleShare}
              className="min-h-[46px] px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all"
            >
              <Share2 className="w-4 h-4" />
              Invite via Telegram
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="min-h-[46px] px-5 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-100 font-medium text-sm inline-flex items-center justify-center gap-2 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy Link'}
            </button>
          </div>
        </div>

        <div className="mt-5 p-3.5 rounded-xl bg-[#070B17] border border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-400">Your Unique Referral Link</p>
            <p className="text-xs sm:text-sm font-mono text-slate-200 truncate mt-0.5">
              {inviteUrl}
            </p>
          </div>
          <span className="text-xs font-mono text-blue-300 shrink-0">
            Code: {data.referralCode}
          </span>
        </div>
      </section>

      {/* Referral KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs text-slate-400">Level 1 Invited Miners</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
            {data.level1Count}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            +{data.config.l1FixedBonus} LOVA signup · {data.config.l1Percent}% mining share
          </p>
        </div>
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs text-slate-400">Level 2 Network</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
            {data.level2Count}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {data.config.l2Percent}% secondary mining share
          </p>
        </div>
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs text-slate-400">Total Referral Rewards (Demo)</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-blue-300 mt-1">
            {data.totalReferralEarned.toFixed(2)} LOVA
          </p>
          <p className="text-xs text-slate-400 mt-1">Credited server-side</p>
        </div>
      </div>

      {/* Two-Column Invited Users & Reward Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass-panel rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-white">Invited Miners</h2>
            <Users className="w-4 h-4 text-blue-400" />
          </div>
          {data.invited.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">
              <UserPlus className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              No invited miners yet. Share your link to start building your network.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {data.invited.map((item) => (
                <div key={item.id} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-100">{item.handle}</p>
                    <p className="text-xs text-slate-400">
                      Level {item.level} · Joined {new Date(item.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right font-mono tabular-nums text-xs text-slate-300">
                    {item.total_earned.toFixed(2)} LOVA mined
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="glass-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-4">Referral Reward History</h2>
          {data.rewards.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">
              Referral rewards will appear here once invited miners register or claim mining sessions.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {data.rewards.map((rw) => (
                <div key={rw.id} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-100">
                      {rw.reward_source === 'signup_fixed'
                        ? 'Signup Bonus'
                        : 'Mining Commission'}
                    </p>
                    <p className="text-xs text-slate-400">
                      Level {rw.level} · {new Date(rw.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="font-mono tabular-nums text-sm font-semibold text-blue-300">
                    +{rw.amount.toFixed(4)} LOVA
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
