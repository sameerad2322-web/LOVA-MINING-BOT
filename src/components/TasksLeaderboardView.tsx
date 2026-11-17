import { useEffect, useState } from 'react';
import { Award, CalendarCheck2, CheckCircle2, ExternalLink, ShieldCheck, Trophy } from 'lucide-react';
import { apiFetch, getTelegramWebApp } from '../lib/api';
import type { AppSettings, LovaUser, TaskItem } from '../types/lova';

interface TasksLeaderboardViewProps {
  user: LovaUser;
  settings: AppSettings;
  canCheckInToday: boolean;
  onRefreshBootstrap: () => Promise<void>;
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  handle: string;
  score: number;
  unit: string;
}

export function TasksLeaderboardView({
  user,
  settings,
  canCheckInToday,
  onRefreshBootstrap,
  onToast,
}: TasksLeaderboardViewProps) {
  const [subView, setSubView] = useState<'tasks' | 'leaderboard'>('tasks');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({
    referralCount: 0,
    completedMiningSessions: 0,
    hasVerifiedWallet: false,
  });
  const [tasksLoading, setTasksLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [codeInputs, setCodeInputs] = useState<Record<string, string>>({});

  // Leaderboard state
  const [lbTab, setLbTab] = useState<'miners' | 'referrals'>('miners');
  const [lbPeriod, setLbPeriod] = useState<'all' | 'weekly' | 'monthly'>('all');
  const [lbEntries, setLbEntries] = useState<LeaderboardEntry[]>([]);
  const [platformStats, setPlatformStats] = useState({
    totalMiners: 0,
    totalMiningRewards: 0,
    totalReferrals: 0,
  });
  const [lbLoading, setLbLoading] = useState(false);

  const loadTasks = async () => {
    try {
      setTasksLoading(true);
      const res = await apiFetch<{
        tasks: TaskItem[];
        stats: { referralCount: number; completedMiningSessions: number; hasVerifiedWallet: boolean };
      }>('/api/tasks');
      setTasks(res.tasks);
      setStats(res.stats);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setTasksLoading(false);
    }
  };

  const loadLeaderboard = async (tab: 'miners' | 'referrals', period: 'all' | 'weekly' | 'monthly') => {
    try {
      setLbLoading(true);
      const res = await apiFetch<{
        entries: LeaderboardEntry[];
        platformStats: { totalMiners: number; totalMiningRewards: number; totalReferrals: number };
      }>(`/api/leaderboard?tab=${tab}&period=${period}`);
      setLbEntries(res.entries);
      setPlatformStats(res.platformStats);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setLbLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, []);

  useEffect(() => {
    if (subView === 'leaderboard') {
      void loadLeaderboard(lbTab, lbPeriod);
    }
  }, [subView, lbTab, lbPeriod]);

  const handleDailyCheckin = async () => {
    try {
      setCheckingIn(true);
      const res = await apiFetch<{ streakDay: number; rewardAmount: number }>('/api/checkin', {
        method: 'POST',
      });
      await onRefreshBootstrap();
      onToast(
        'success',
        `Day ${res.streakDay} check-in complete: +${res.rewardAmount.toFixed(2)} LOVA (Demo).`
      );
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setCheckingIn(false);
    }
  };

  const openExternalTaskUrl = (url: string) => {
    const tg = getTelegramWebApp();
    if (tg?.openTelegramLink && /^https?:\/\/(t\.me|telegram\.me)\//i.test(url)) {
      tg.openTelegramLink(url);
      return;
    }
    if (tg?.openLink) {
      tg.openLink(url);
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleStartTask = async (task: TaskItem) => {
    try {
      setBusyTaskId(task.id);
      await apiFetch(`/api/tasks/${task.id}/start`, { method: 'POST' });
      if (task.action_url) {
        openExternalTaskUrl(task.action_url);
      }
      await loadTasks();
      onToast('info', 'Task link opened. Complete the task or enter the Ads Code, then tap Verify.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleVerifyTask = async (task: TaskItem) => {
    try {
      setBusyTaskId(task.id);
      const res = await apiFetch<{ tasks: TaskItem[]; awarded: number }>(
        `/api/tasks/${task.id}/verify`,
        {
          method: 'POST',
          body: JSON.stringify({ code: codeInputs[task.id] || '' }),
        }
      );
      setTasks(res.tasks);
      await onRefreshBootstrap();
      onToast('success', `Verified! +${res.awarded} LOVA (Demo) credited.`);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Segmented View Switch */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {subView === 'tasks' ? 'Daily Check-In & Task Center' : 'Global Leaderboard'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {subView === 'tasks'
              ? 'Claim daily streak rewards, visit task links, and submit Ads verification codes for LOVA coins'
              : 'Top verified miners and community referrers (privacy-masked handles)'}
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/90 border border-slate-800">
          <button
            type="button"
            onClick={() => setSubView('tasks')}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              subView === 'tasks' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Tasks
          </button>
          <button
            type="button"
            onClick={() => setSubView('leaderboard')}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              subView === 'leaderboard'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Leaderboard
          </button>
        </div>
      </div>

      {subView === 'tasks' ? (
        <>
          {/* Daily Check-In Banner Card */}
          <section className="glass-panel-elevated rounded-3xl p-5 sm:p-6">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-blue-300 font-medium">
                  <CalendarCheck2 className="w-4 h-4" />
                  <span>Daily Check-In · Consecutive Streak: {user.streak_days} days</span>
                </div>
                <h2 className="text-lg font-bold text-white">
                  Claim Today&apos;s Daily Check-In Bonus
                </h2>
                <p className="text-xs text-slate-300">
                  Base reward: <span className="font-mono font-semibold text-blue-300">{settings.daily_bonus_amount} LOVA</span> · Increases +10% per consecutive day up to Day 7.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
                <div className="grid grid-cols-7 gap-1.5">
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
                        className={`rounded-lg py-1.5 px-2 text-center border ${
                          reached
                            ? 'bg-blue-600/25 border-blue-500/45 text-blue-200'
                            : 'bg-slate-900/70 border-slate-800 text-slate-400'
                        }`}
                      >
                        <p className="text-[10px] font-medium">D{dayNum}</p>
                        <p className="text-[10px] font-mono tabular-nums">+{bonusVal}</p>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  disabled={!canCheckInToday || checkingIn}
                  onClick={handleDailyCheckin}
                  className={`min-h-[44px] px-5 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors ${
                    canCheckInToday
                      ? 'bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white'
                      : 'bg-slate-800/80 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {checkingIn
                    ? 'Claiming...'
                    : canCheckInToday
                      ? 'Daily Check-In'
                      : 'Checked In Today'}
                </button>
              </div>
            </div>
          </section>

          {/* Progress Summary Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Wallet Status</p>
              <p className="text-base font-semibold text-white mt-1 flex items-center gap-1.5">
                <ShieldCheck
                  className={`w-4 h-4 ${
                    stats.hasVerifiedWallet ? 'text-emerald-400' : 'text-slate-500'
                  }`}
                />
                {stats.hasVerifiedWallet ? 'Verified via 0.05 GRAM' : 'Not Verified'}
              </p>
            </div>
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Direct Referrals</p>
              <p className="text-base font-semibold font-mono tabular-nums text-white mt-1">
                {stats.referralCount} invited
              </p>
            </div>
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Claimed Sessions</p>
              <p className="text-base font-semibold font-mono tabular-nums text-white mt-1">
                {stats.completedMiningSessions} sessions
              </p>
            </div>
          </div>

          {tasksLoading ? (
            <div className="space-y-3">
              <div className="h-24 rounded-2xl bg-slate-900/60" />
              <div className="h-24 rounded-2xl bg-slate-900/60" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="glass-panel rounded-2xl p-10 text-center text-sm text-slate-400">
              No active tasks available right now.
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => {
                const isDone = task.user_status === 'completed';
                const hasLink = Boolean(task.action_url);
                const needsCode = Boolean(task.requires_code || task.verification_code || task.category === 'ads_code');
                const requiresStart =
                  hasLink &&
                  (task.category === 'social_link' || task.category === 'custom' || task.category === 'ads_code') &&
                  task.user_status === 'not_started';

                return (
                  <div
                    key={task.id}
                    className="glass-panel rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1.5 max-w-2xl">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="capitalize text-blue-300 font-medium">
                          {task.category === 'ads_code'
                            ? 'Ads Code Task'
                            : task.category.replace('_', ' ')}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-200 font-semibold">
                          +{task.reward_amount} LOVA (Demo)
                        </span>
                      </div>
                      <h3 className="text-base font-semibold text-white">{task.title}</h3>
                      <p className="text-xs text-slate-300/90 leading-relaxed">{task.description}</p>
                      {needsCode && !isDone && (
                        <input
                          type="text"
                          placeholder="Enter Ads / Task verification code"
                          value={codeInputs[task.id] || ''}
                          onChange={(e) =>
                            setCodeInputs((prev) => ({ ...prev, [task.id]: e.target.value }))
                          }
                          className="mt-2 w-full sm:w-72 px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                        />
                      )}
                      {requiresStart && (
                        <p className="text-[11px] text-amber-300/90 mt-1">
                          Step 1: Open the task link first to unlock verification.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      {isDone ? (
                        <span className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold inline-flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" />
                          Completed
                        </span>
                      ) : (
                        <>
                          {hasLink && (
                            <button
                              type="button"
                              disabled={busyTaskId === task.id}
                              onClick={() => handleStartTask(task)}
                              className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              {task.category === 'ads_code' ? 'Watch / Open Ad' : 'Open Link'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyTaskId === task.id || requiresStart}
                            onClick={() => handleVerifyTask(task)}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                          >
                            <Award className="w-4 h-4" />
                            {busyTaskId === task.id ? 'Checking...' : 'Verify'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-5">
          {/* Platform Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Total Registered Miners</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white mt-1">
                {platformStats.totalMiners.toLocaleString()}
              </p>
            </div>
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Total Mining Rewards (Demo)</p>
              <p className="text-xl font-bold font-mono tabular-nums text-blue-300 mt-1">
                {platformStats.totalMiningRewards.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{' '}
                LOVA
              </p>
            </div>
            <div className="glass-panel rounded-2xl p-4">
              <p className="text-xs text-slate-400">Verified Referral Links</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white mt-1">
                {platformStats.totalReferrals.toLocaleString()}
              </p>
            </div>
          </div>

          {/* Filter Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900 border border-slate-800">
              <button
                type="button"
                onClick={() => setLbTab('miners')}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg ${
                  lbTab === 'miners' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Top Miners
              </button>
              <button
                type="button"
                onClick={() => setLbTab('referrals')}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg ${
                  lbTab === 'referrals'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Top Referrals
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900 border border-slate-800">
              {(['all', 'weekly', 'monthly'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setLbPeriod(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize ${
                    lbPeriod === p ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {p === 'all' ? 'All-Time' : p}
                </button>
              ))}
            </div>
          </div>

          {/* Leaderboard Table */}
          <div className="glass-panel rounded-2xl p-5">
            {lbLoading ? (
              <div className="space-y-2">
                <div className="h-10 rounded-lg bg-slate-800/60" />
                <div className="h-10 rounded-lg bg-slate-800/60" />
              </div>
            ) : lbEntries.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">
                <Trophy className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                No rankings recorded in this period yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {lbEntries.map((row) => (
                  <div key={row.userId} className="py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-7 text-center font-mono tabular-nums text-sm font-bold ${
                          row.rank <= 3 ? 'text-blue-300' : 'text-slate-400'
                        }`}
                      >
                        #{row.rank}
                      </span>
                      <span className="text-sm font-medium text-slate-100 truncate">
                        {row.handle}
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-sm font-semibold text-blue-300 shrink-0">
                      {row.score.toLocaleString()} {row.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
