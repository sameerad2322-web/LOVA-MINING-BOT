import { useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck2,
  CheckCircle2,
  Clock,
  Coins,
  Megaphone,
  PauseCircle,
  Play,
  Square,
  Zap,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  AnnouncementItem,
  AppSettings,
  LovaUser,
  MiningReward,
  MiningSession,
  PublicSystemStatus,
} from '../types/lova';

interface MiningViewProps {
  user: LovaUser;
  activeSession: MiningSession | null;
  settings: AppSettings;
  announcements: AnnouncementItem[];
  systemStatus: PublicSystemStatus;
  serverTimeOffsetMs: number;
  canCheckInToday: boolean;
  onRefreshBootstrap: () => Promise<void>;
  onUpdateUserAndSession: (user: LovaUser, session: MiningSession | null) => void;
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}

const EMBLEM_SRC = '/src/assets/images/lova_emblem_1794836082450.jpg';

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )}`;
}

export function MiningView({
  user,
  activeSession,
  settings,
  announcements,
  systemStatus,
  serverTimeOffsetMs,
  canCheckInToday,
  onRefreshBootstrap,
  onUpdateUserAndSession,
  onToast,
}: MiningViewProps) {
  const [nowMs, setNowMs] = useState(() => Date.now() + serverTimeOffsetMs);
  const [busyAction, setBusyAction] = useState<'start' | 'stop' | 'claim' | 'checkin' | null>(null);
  const [history, setHistory] = useState<{ sessions: MiningSession[]; rewards: MiningReward[] }>({
    sessions: [],
    rewards: [],
  });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [emblemError, setEmblemError] = useState(false);

  // Visual ticker synced to authoritative server clock offset (all actual rewards are computed on server)
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now() + serverTimeOffsetMs);
    }, 250);
    return () => window.clearInterval(id);
  }, [serverTimeOffsetMs]);

  const loadHistory = async () => {
    try {
      setHistoryLoading(true);
      const data = await apiFetch<{ sessions: MiningSession[]; rewards: MiningReward[] }>(
        '/api/mining/history'
      );
      setHistory(data);
    } catch {
      // silent
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [user.id, activeSession?.id]);

  const sessionMetrics = useMemo(() => {
    if (!activeSession) {
      return {
        isActive: false,
        isExpired: false,
        progressPct: 0,
        remainingMs: 0,
        accruedDisplay: 0,
      };
    }
    const startMs = new Date(activeSession.started_at).getTime();
    const endMs = new Date(activeSession.ends_at).getTime();
    const effectiveNow = Math.min(nowMs, endMs);
    const elapsedSec = Math.max(0, (effectiveNow - startMs) / 1000);
    const totalDurMs = Math.max(1000, endMs - startMs);
    const progressPct = Math.min(100, Math.max(0, ((effectiveNow - startMs) / totalDurMs) * 100));
    const remainingMs = Math.max(0, endMs - nowMs);
    const accruedDisplay = Math.min(
      elapsedSec * activeSession.reward_rate_per_sec,
      activeSession.max_reward
    );
    const isExpired = activeSession.status === 'expired' || nowMs >= endMs;

    return {
      isActive: !isExpired && activeSession.status === 'active',
      isExpired,
      progressPct,
      remainingMs,
      accruedDisplay,
    };
  }, [activeSession, nowMs]);

  const handleStartMining = async () => {
    try {
      setBusyAction('start');
      const res = await apiFetch<{ session: MiningSession }>('/api/mining/start', {
        method: 'POST',
      });
      onUpdateUserAndSession(user, res.session);
      onToast('success', 'Server-verified mining session started.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStopMining = async () => {
    try {
      setBusyAction('stop');
      const res = await apiFetch<{ user: LovaUser; claimedAmount: number }>('/api/mining/stop', {
        method: 'POST',
      });
      onUpdateUserAndSession(res.user, null);
      await loadHistory();
      onToast(
        'info',
        res.claimedAmount > 0
          ? `Session stopped and ${res.claimedAmount.toFixed(4)} LOVA (Demo) credited.`
          : 'Mining session stopped.'
      );
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleClaimMining = async () => {
    try {
      setBusyAction('claim');
      const res = await apiFetch<{ user: LovaUser; claimedAmount: number }>('/api/mining/claim', {
        method: 'POST',
      });
      onUpdateUserAndSession(res.user, null);
      await loadHistory();
      onToast('success', `Claimed ${res.claimedAmount.toFixed(4)} LOVA to your Demo Balance.`);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDailyCheckin = async () => {
    try {
      setBusyAction('checkin');
      const res = await apiFetch<{ user: LovaUser; streakDay: number; rewardAmount: number }>(
        '/api/checkin',
        { method: 'POST' }
      );
      onUpdateUserAndSession(res.user, activeSession);
      await loadHistory();
      await onRefreshBootstrap();
      onToast(
        'success',
        `Day ${res.streakDay} check-in complete: +${res.rewardAmount.toFixed(2)} LOVA (Demo).`
      );
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const ringRadius = 112;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const strokeDashoffset =
    ringCircumference - (sessionMetrics.progressPct / 100) * ringCircumference;

  const isPaused = settings.maintenance_mode || settings.emergency_pause || !settings.mining_enabled;
  const currentRatePerSec = activeSession
    ? activeSession.reward_rate_per_sec
    : settings.reward_rate_per_hour / 3600;

  return (
    <div className="space-y-6">
      {/* System Status Notice if paused or maintenance */}
      {isPaused && (
        <div className="glass-panel rounded-2xl p-4 flex items-center gap-3 border-amber-500/30 bg-amber-950/20">
          <PauseCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold text-amber-200">Mining Temporarily Paused</p>
            <p className="text-amber-300/80 text-xs mt-0.5">
              Administrators have temporarily paused new mining sessions for maintenance.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* PRIMARY MINING CORE */}
        <section className="lg:col-span-7 glass-panel-elevated rounded-3xl p-6 sm:p-8 relative overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div>
              <p className="text-xs font-medium text-blue-300/90">
                {systemStatus.isDemoTokenMode
                  ? 'Demo Balance · Pre-Token Deployment'
                  : 'LOVA Balance · TON Network'}
              </p>
              <div className="flex items-baseline gap-2.5 mt-1">
                <span className="text-3xl sm:text-4xl font-bold font-mono tabular-nums tracking-tight text-white">
                  {user.available_balance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  })}
                </span>
                <span className="text-sm font-semibold text-blue-400">LOVA</span>
              </div>
            </div>

            <div className="text-left sm:text-right">
              <p className="text-xs text-slate-400">Mining Rate</p>
              <p className="text-base font-mono font-semibold tabular-nums text-slate-100 mt-0.5">
                {settings.reward_rate_per_hour.toFixed(2)} LOVA/hr
              </p>
              <p className="text-xs font-mono tabular-nums text-slate-400">
                {currentRatePerSec.toFixed(5)}/sec
              </p>
            </div>
          </div>

          {/* ANIMATED CIRCULAR MINING BUTTON */}
          <div className="flex flex-col items-center justify-center py-4 sm:py-6">
            <div className="relative w-64 h-64 flex items-center justify-center">
              {/* Outer Orbital Glow Ring */}
              <div
                className={`absolute inset-2 rounded-full border border-blue-500/20 ${
                  sessionMetrics.isActive ? 'animate-orbit' : ''
                }`}
                style={{
                  background:
                    'radial-gradient(circle, rgba(59,130,246,0.12) 0%, rgba(124,58,237,0.06) 55%, transparent 72%)',
                }}
              />

              {/* SVG Progress Track */}
              <svg className="w-64 h-64 -rotate-90" viewBox="0 0 256 256" aria-hidden="true">
                <circle
                  cx="128"
                  cy="128"
                  r={ringRadius}
                  fill="none"
                  stroke="rgba(148, 163, 184, 0.14)"
                  strokeWidth="8"
                />
                <circle
                  cx="128"
                  cy="128"
                  r={ringRadius}
                  fill="none"
                  stroke="url(#lovaRingGradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={strokeDashoffset}
                  className="transition-[stroke-dashoffset] duration-300 ease-out"
                />
                <defs>
                  <linearGradient id="lovaRingGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#3B82F6" />
                    <stop offset="100%" stopColor="#8B5CF6" />
                  </linearGradient>
                </defs>
              </svg>

              {/* Center Interactive Orb Button */}
              <button
                type="button"
                disabled={busyAction !== null || (isPaused && !activeSession)}
                onClick={() => {
                  if (!activeSession) void handleStartMining();
                  else if (
                    sessionMetrics.isExpired ||
                    sessionMetrics.accruedDisplay >= settings.min_claim_amount
                  ) {
                    void handleClaimMining();
                  }
                }}
                aria-label={activeSession ? 'Claim mined LOVA' : 'Start mining session'}
                className="group absolute w-44 h-44 rounded-full overflow-hidden border border-blue-400/35 shadow-[0_0_45px_rgba(59,130,246,0.28)] transition-transform duration-150 active:scale-[0.97] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-60 disabled:cursor-not-allowed flex flex-col items-center justify-center bg-[#091124]"
              >
                {!emblemError ? (
                  <img
                    src={EMBLEM_SRC}
                    alt="LOVA Core Emblem"
                    referrerPolicy="no-referrer"
                    onError={() => setEmblemError(true)}
                    className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
                      sessionMetrics.isActive ? 'opacity-85' : 'opacity-65 group-hover:opacity-80'
                    }`}
                  />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-600/30 to-violet-700/30 flex items-center justify-center">
                    <Zap className="w-12 h-12 text-blue-400" />
                  </div>
                )}

                <div className="relative z-10 inset-0 w-full h-full bg-gradient-to-t from-[#060913]/90 via-[#060913]/35 to-transparent flex flex-col items-center justify-end pb-5 px-3">
                  {activeSession ? (
                    <>
                      <span className="text-xs font-medium text-blue-200">
                        {sessionMetrics.isExpired ? 'Ready to Claim' : 'Mining Active'}
                      </span>
                      <span className="text-lg font-bold font-mono tabular-nums text-white mt-0.5">
                        +{sessionMetrics.accruedDisplay.toFixed(4)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-white">Start Mining</span>
                      <span className="text-xs text-slate-300 mt-0.5">
                        {Math.round(settings.mining_duration_seconds / 3600)}h Session
                      </span>
                    </>
                  )}
                </div>
              </button>
            </div>

            {/* Session Countdown & Progress Metadata */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-300">
              <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                <Clock className="w-3.5 h-3.5 text-blue-400" />
                {activeSession
                  ? sessionMetrics.isExpired
                    ? '00:00:00 · Session Expired'
                    : `${formatCountdown(sessionMetrics.remainingMs)} remaining`
                  : `${Math.round(settings.mining_duration_seconds / 3600)}h session duration`}
              </span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span className="font-mono tabular-nums">
                {sessionMetrics.progressPct.toFixed(1)}% complete
              </span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span className="font-mono tabular-nums">
                Cap {settings.max_reward_per_session} LOVA
              </span>
            </div>

            {/* Action Buttons Row */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3 w-full max-w-md">
              {!activeSession ? (
                <button
                  type="button"
                  disabled={busyAction !== null || isPaused}
                  onClick={handleStartMining}
                  className="flex-1 min-h-[46px] px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-950/50 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  {busyAction === 'start' ? 'Starting...' : 'Start Mining'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={
                      busyAction !== null ||
                      sessionMetrics.accruedDisplay < settings.min_claim_amount
                    }
                    onClick={handleClaimMining}
                    className="flex-1 min-h-[46px] px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                  >
                    <Coins className="w-4 h-4" />
                    {busyAction === 'claim'
                      ? 'Claiming...'
                      : `Claim ${sessionMetrics.accruedDisplay.toFixed(3)} LOVA`}
                  </button>
                  {!sessionMetrics.isExpired && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={handleStopMining}
                      className="min-h-[46px] px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-200 font-medium text-sm inline-flex items-center justify-center gap-2 transition-colors"
                    >
                      <Square className="w-4 h-4" />
                      {busyAction === 'stop' ? 'Stopping...' : 'Stop'}
                    </button>
                  )}
                </>
              )}
            </div>
            {activeSession && sessionMetrics.accruedDisplay < settings.min_claim_amount && (
              <p className="text-xs text-slate-400 mt-2.5">
                Minimum claim threshold: {settings.min_claim_amount} LOVA
              </p>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN: BALANCE STATS, DAILY CHECK-IN, ANNOUNCEMENTS */}
        <div className="lg:col-span-5 space-y-6">
          {/* Balance Breakdown Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Total Earned (Demo)</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white mt-1">
                {user.total_earned.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-slate-400 mt-1">LOVA · All sources</p>
            </div>
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Pending Withdrawal</p>
              <p className="text-xl font-bold font-mono tabular-nums text-violet-300 mt-1">
                {user.pending_balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-slate-400 mt-1">LOVA · In review</p>
            </div>
          </div>

          {/* Daily Check-in Streak Card */}
          <section className="glass-panel rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Daily Mining Check-in</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Consecutive streak: {user.streak_days} {user.streak_days === 1 ? 'day' : 'days'} ·
                  Base bonus {settings.daily_bonus_amount} LOVA
                </p>
              </div>
              <CalendarCheck2 className="w-5 h-5 text-blue-400 shrink-0" />
            </div>

            <div className="grid grid-cols-7 gap-1.5 mt-4">
              {Array.from({ length: 7 }).map((_, idx) => {
                const dayNum = idx + 1;
                const currentMod = user.streak_days % 7 || (user.streak_days > 0 ? 7 : 0);
                const reached = dayNum <= currentMod;
                const bonusVal = Math.round(
                  settings.daily_bonus_amount * (1 + Math.min(idx, 6) * 0.1)
                );
                return (
                  <div
                    key={dayNum}
                    className={`rounded-xl py-2 px-1 text-center border ${
                      reached
                        ? 'bg-blue-600/20 border-blue-500/40 text-blue-200'
                        : 'bg-slate-900/60 border-slate-800 text-slate-400'
                    }`}
                  >
                    <p className="text-[11px] font-medium">D{dayNum}</p>
                    <p className="text-[11px] font-mono tabular-nums mt-0.5">+{bonusVal}</p>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              disabled={!canCheckInToday || busyAction !== null}
              onClick={handleDailyCheckin}
              className={`mt-4 w-full min-h-[44px] rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors ${
                canCheckInToday
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-slate-800/70 text-slate-400 cursor-not-allowed'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              {busyAction === 'checkin'
                ? 'Claiming Bonus...'
                : canCheckInToday
                  ? 'Claim Daily Check-in Bonus'
                  : 'Daily Bonus Claimed Today'}
            </button>
          </section>

          {/* Airdrop & System Announcements */}
          <section className="glass-panel rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-white">Announcements</h2>
              <Megaphone className="w-4 h-4 text-violet-400" />
            </div>
            {announcements.length === 0 ? (
              <p className="text-xs text-slate-400">No active announcements.</p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {announcements.slice(0, 3).map((ann) => (
                  <div key={ann.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="capitalize text-blue-300 font-medium">{ann.category}</span>
                      <span aria-hidden="true">·</span>
                      <span>{new Date(ann.created_at).toLocaleDateString()}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-slate-100 mt-1">{ann.title}</h3>
                    <p className="text-xs text-slate-300/90 leading-relaxed mt-1">{ann.body}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* MINING HISTORY */}
      <section className="glass-panel rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-white">Recent Mining History</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Server-verified mining claims and daily bonuses
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {history.rewards.length} records
          </span>
        </div>

        {historyLoading ? (
          <div className="space-y-2">
            <div className="h-10 rounded-lg bg-slate-800/50" />
            <div className="h-10 rounded-lg bg-slate-800/50" />
          </div>
        ) : history.rewards.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            No mining rewards claimed yet. Start your first session above to earn LOVA Demo Balances.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-2.5 pr-4 font-medium">Reward Type</th>
                  <th className="py-2.5 pr-4 font-medium">Balance Tier</th>
                  <th className="py-2.5 pr-4 font-medium">Timestamp</th>
                  <th className="py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {history.rewards.slice(0, 10).map((rw) => (
                  <tr key={rw.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 pr-4 font-medium text-slate-200 capitalize">
                      {rw.reward_type.replace('_', ' ')}
                    </td>
                    <td className="py-3 pr-4 text-xs text-slate-400">
                      {rw.is_demo_balance ? 'Demo Balance' : 'On-Chain'}
                    </td>
                    <td className="py-3 pr-4 text-xs font-mono tabular-nums text-slate-400">
                      {new Date(rw.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 text-right font-mono tabular-nums font-semibold text-blue-300">
                      +{rw.amount.toFixed(4)} LOVA
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
