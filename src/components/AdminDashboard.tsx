import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Ban,
  Bot,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  Database,
  KeyRound,
  LogOut,
  Megaphone,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { apiFetch, getStoredAdminToken, setStoredAdminToken } from '../lib/api';
import type {
  AdminRole,
  AnnouncementItem,
  AppSettings,
  LovaUser,
  PublicSystemStatus,
  TaskCategory,
  TaskItem,
  UserWallet,
  WalletVerification,
  WithdrawalItem,
} from '../types/lova';

interface AdminDashboardProps {
  systemStatus: PublicSystemStatus;
  onExit: () => void;
  onRefreshBootstrap: () => Promise<void>;
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}

type AdminSection =
  | 'overview'
  | 'telegram'
  | 'users'
  | 'settings'
  | 'withdrawals'
  | 'wallets'
  | 'tasks'
  | 'audit';

export function AdminDashboard({
  systemStatus,
  onExit,
  onRefreshBootstrap,
  onToast,
}: AdminDashboardProps) {
  const [adminAuth, setAdminAuth] = useState<{ role: string; displayName: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [secretInput, setSecretInput] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [section, setSection] = useState<AdminSection>('overview');
  const [overview, setOverview] = useState<{
    totalUsers: number;
    activeUsers: number;
    activeMiners: number;
    totalMiningRewards: number;
    pendingWithdrawals: number;
    completedWithdrawals: number;
    totalReferrals: number;
    verifiedWalletsCount: number;
    totalGramFeesReceived: number;
  } | null>(null);
  const [settingsForm, setSettingsForm] = useState<AppSettings | null>(null);
  const [users, setUsers] = useState<Array<LovaUser & { wallet: UserWallet | null }>>([]);
  const [userSearch, setUserSearch] = useState('');
  const [withdrawals, setWithdrawals] = useState<WithdrawalItem[]>([]);
  const [payoutHashes, setPayoutHashes] = useState<Record<string, string>>({});
  const [walletsData, setWalletsData] = useState<{
    wallets: Array<UserWallet & { telegram_id?: number; username?: string }>;
    verifications: WalletVerification[];
  }>({ wallets: [], verifications: [] });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<
    Array<{
      id: string;
      admin_id: string;
      admin_role: string;
      action: string;
      target_type: string;
      target_id: string | null;
      created_at: string;
    }>
  >([]);
  const [referralsData, setReferralsData] = useState<{
    referrals: Array<{
      id: string;
      level: number;
      referrer_handle: string | number;
      referred_handle: string | number;
      created_at: string;
    }>;
  }>({ referrals: [] });

  // New / Edit Task & Announcement Forms
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [dailyBonusQuick, setDailyBonusQuick] = useState<number>(25);
  const [newTask, setNewTask] = useState({
    title: '',
    description: '',
    category: 'ads_code' as TaskCategory,
    reward_amount: 100,
    action_url: '',
    verification_code: '',
    telegram_chat_id: '',
    required_count: 1,
  });
  const [newAnnouncement, setNewAnnouncement] = useState({
    title: '',
    body: '',
    category: 'airdrop' as AnnouncementItem['category'],
  });

  // Confirmation modal for sensitive actions
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  // Telegram Bot & Setup state
  const [botStatus, setBotStatus] = useState<{
    configured: boolean;
    bot: { id: number; first_name: string; username?: string } | null;
    webhook: { url: string; pending_update_count: number; last_error_message?: string } | null;
    menuButton: { type: string; text?: string; web_app?: { url: string } } | null;
    error: string | null;
    detectedOrigin?: string;
  } | null>(null);
  const [botMiniAppUrl, setBotMiniAppUrl] = useState(() =>
    typeof window !== 'undefined' ? window.location.origin : ''
  );
  const [registerWebhook, setRegisterWebhook] = useState(true);
  const [botBusy, setBotBusy] = useState(false);
  const [checkingWebhookHealth, setCheckingWebhookHealth] = useState(false);
  const [webhookHealth, setWebhookHealth] = useState<{
    url: string;
    checkedAt: string;
    reachable: boolean;
    healthy: boolean;
    latencyMs: number;
    getStatus: number | null;
    postStatus: number | null;
    redirectLocation: string | null;
    summary: string;
    responsePreview: string | null;
  } | null>(null);
  const [copiedSchema, setCopiedSchema] = useState(false);

  // Admin team state
  const [adminsList, setAdminsList] = useState<
    Array<{
      id: string;
      telegram_id: number | null;
      display_name: string;
      role: AdminRole;
      is_active: boolean;
      created_at: string;
    }>
  >([]);
  const [envAdminIds, setEnvAdminIds] = useState<number[]>([]);
  const [newAdminForm, setNewAdminForm] = useState({
    telegram_id: '',
    display_name: '',
    role: 'moderator' as AdminRole,
  });

  useEffect(() => {
    (async () => {
      try {
        setCheckingAuth(true);
        if (!getStoredAdminToken()) {
          setAdminAuth(null);
          return;
        }
        const me = await apiFetch<{ adminId: string; role: string }>('/api/admin/me', {}, true);
        setAdminAuth({ role: me.role, displayName: me.adminId });
      } catch {
        setStoredAdminToken(null);
        setAdminAuth(null);
      } finally {
        setCheckingAuth(false);
      }
    })();
  }, []);

  const loadSectionData = async (sec: AdminSection) => {
    try {
      if (sec === 'overview' || sec === 'settings') {
        const res = await apiFetch<{ overview: typeof overview; settings: AppSettings }>(
          '/api/admin/overview',
          {},
          true
        );
        setOverview(res.overview);
        setSettingsForm(res.settings);
      }
      if (sec === 'users') {
        const res = await apiFetch<{ users: typeof users }>(
          `/api/admin/users?search=${encodeURIComponent(userSearch)}`,
          {},
          true
        );
        setUsers(res.users);
      }
      if (sec === 'withdrawals') {
        const res = await apiFetch<{ withdrawals: WithdrawalItem[] }>(
          '/api/admin/withdrawals',
          {},
          true
        );
        setWithdrawals(res.withdrawals);
      }
      if (sec === 'wallets') {
        const res = await apiFetch<typeof walletsData>('/api/admin/wallets', {}, true);
        setWalletsData(res);
      }
      if (sec === 'tasks') {
        const [tRes, aRes, oRes] = await Promise.all([
          apiFetch<{ tasks: TaskItem[] }>('/api/admin/tasks', {}, true),
          apiFetch<{ announcements: AnnouncementItem[] }>('/api/admin/announcements', {}, true),
          apiFetch<{ overview: typeof overview; settings: AppSettings }>(
            '/api/admin/overview',
            {},
            true
          ),
        ]);
        setTasks(tRes.tasks);
        setAnnouncements(aRes.announcements);
        setDailyBonusQuick(oRes.settings.daily_bonus_amount);
      }
      if (sec === 'audit') {
        const [lRes, rRes] = await Promise.all([
          apiFetch<{ logs: typeof auditLogs }>('/api/admin/audit-logs', {}, true),
          apiFetch<typeof referralsData>('/api/admin/referrals', {}, true),
        ]);
        setAuditLogs(lRes.logs);
        setReferralsData(rRes);
      }
      if (sec === 'telegram') {
        const [bRes, aRes] = await Promise.all([
          apiFetch<NonNullable<typeof botStatus>>('/api/admin/telegram/status', {}, true),
          apiFetch<{ admins: typeof adminsList; envAdminTelegramIds: number[] }>(
            '/api/admin/admins',
            {},
            true
          ),
        ]);
        setBotStatus(bRes);
        if (bRes.detectedOrigin && bRes.detectedOrigin.startsWith('https://')) {
          setBotMiniAppUrl((curr) => curr || bRes.detectedOrigin!);
        }
        setAdminsList(aRes.admins);
        setEnvAdminIds(aRes.envAdminTelegramIds || []);
      }
    } catch (err) {
      onToast('error', (err as Error).message);
    }
  };

  useEffect(() => {
    if (adminAuth) {
      void loadSectionData(section);
    }
  }, [adminAuth, section]);

  const handleAdminLogin = async (opts: { secret?: string; bootstrapPreviewAdmin?: boolean }) => {
    try {
      setLoginBusy(true);
      const res = await apiFetch<{ adminToken: string; role: string; displayName: string }>(
        '/api/admin/login',
        {
          method: 'POST',
          body: JSON.stringify(opts),
        }
      );
      setStoredAdminToken(res.adminToken);
      setAdminAuth({ role: res.role, displayName: res.displayName });
      onToast('success', `Signed in as ${res.role.replace('_', ' ')}.`);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };

  const handleAdminLogout = async () => {
    await apiFetch('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
    setStoredAdminToken(null);
    setAdminAuth(null);
    onExit();
  };

  if (checkingAuth) {
    return <div className="p-8 text-center text-sm text-slate-400">Verifying admin session...</div>;
  }

  if (!adminAuth) {
    return (
      <div className="max-w-lg mx-auto py-8 space-y-6">
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Mining App
        </button>

        <section className="glass-panel-elevated rounded-3xl p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Admin Control Center</h1>
              <p className="text-xs text-slate-400">
                Server-validated role access · No public or hardcoded passwords
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleAdminLogin({ secret: secretInput });
            }}
            className="space-y-3"
          >
            <label className="block text-xs text-slate-300">
              Server Admin Bootstrap Secret (<code className="font-mono">ADMIN_BOOTSTRAP_SECRET</code>)
            </label>
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="Enter server-configured admin secret"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#070B17] border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={loginBusy || !secretInput.trim()}
              className="w-full min-h-[44px] rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50"
            >
              {loginBusy ? 'Verifying...' : 'Sign In with Server Secret'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-800 space-y-3">
            <button
              type="button"
              disabled={loginBusy}
              onClick={() => void handleAdminLogin({})}
              className="w-full min-h-[44px] rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold"
            >
              Verify with Authorized Telegram Admin ID
            </button>

            {!systemStatus.adminBootstrapConfigured && (
              <div className="p-4 rounded-2xl bg-blue-950/30 border border-blue-500/25 space-y-2.5 text-xs">
                <p className="font-semibold text-blue-200">
                  Preview Environment Bootstrap Available
                </p>
                <p className="text-blue-200/80 leading-relaxed">
                  No <code className="font-mono">ADMIN_BOOTSTRAP_SECRET</code> or{' '}
                  <code className="font-mono">ADMIN_TELEGRAM_IDS</code> is set in environment
                  variables yet. You can register your current preview session as the initial{' '}
                  <strong>super_admin</strong> in the database to test all Admin controls.
                </p>
                <button
                  type="button"
                  disabled={loginBusy}
                  onClick={() => void handleAdminLogin({ bootstrapPreviewAdmin: true })}
                  className="w-full min-h-[40px] rounded-xl bg-blue-600/90 hover:bg-blue-500 text-white font-semibold"
                >
                  Initialize First Super Admin (Preview Mode)
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  const navItems: Array<{ id: AdminSection; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'telegram', label: 'Bot & Setup', icon: Bot },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'settings', label: 'Mining & Settings', icon: Settings },
    { id: 'withdrawals', label: 'Withdrawals', icon: Coins },
    { id: 'wallets', label: 'Wallets & GRAM', icon: Wallet },
    { id: 'tasks', label: 'Tasks & News', icon: Megaphone },
    { id: 'audit', label: 'Referrals & Logs', icon: ShieldCheck },
  ];

  return (
    <div className="space-y-6">
      {/* Top Admin Bar */}
      <div className="glass-panel rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onExit}
            className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            App
          </button>
          <div>
            <h1 className="text-base font-bold text-white">LOVA Admin Control Center</h1>
            <p className="text-xs text-slate-400">
              Role: <span className="text-blue-300 font-medium">{adminAuth.role}</span> ·{' '}
              {systemStatus.databaseMode === 'supabase' ? 'Supabase PostgreSQL' : 'Local Preview DB'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleAdminLogout}
          className="min-h-[40px] px-3.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-semibold inline-flex items-center gap-1.5"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign Out
        </button>
      </div>

      {/* Admin Layout: Sidebar + Content */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <aside className="lg:col-span-3 glass-panel rounded-2xl p-2 flex lg:flex-col gap-1 overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 transition-colors ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </aside>

        <main className="lg:col-span-9 space-y-6">
          {/* OVERVIEW */}
          {section === 'overview' && overview && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {[
                { label: 'Total Registered Users', val: overview.totalUsers },
                { label: 'Active Users (24h)', val: overview.activeUsers },
                { label: 'Live Active Miners', val: overview.activeMiners },
                {
                  label: 'Total Mining Rewards (Demo)',
                  val: `${overview.totalMiningRewards.toLocaleString()} LOVA`,
                },
                { label: 'Pending Withdrawals', val: overview.pendingWithdrawals },
                { label: 'Completed Payouts', val: overview.completedWithdrawals },
                { label: 'Total Referrals', val: overview.totalReferrals },
                { label: 'Verified TON Wallets', val: overview.verifiedWalletsCount },
                {
                  label: 'Total GRAM Fees Received',
                  val: `${overview.totalGramFeesReceived.toFixed(2)} GRAM`,
                },
              ].map((kpi) => (
                <div key={kpi.label} className="glass-panel rounded-2xl p-5">
                  <p className="text-xs text-slate-400">{kpi.label}</p>
                  <p className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                    {kpi.val}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* USERS */}
          {section === 'users' && (
            <section className="glass-panel rounded-2xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-white">User Management</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadSectionData('users');
                  }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Search Telegram ID or username"
                    className="px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-xs text-white focus:outline-none focus:border-blue-500"
                  />
                  <button
                    type="submit"
                    className="px-3.5 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold inline-flex items-center gap-1"
                  >
                    <Search className="w-3.5 h-3.5" />
                    Search
                  </button>
                </form>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 pr-3">Telegram ID</th>
                      <th className="py-2.5 pr-3">Handle</th>
                      <th className="py-2.5 pr-3">Balance (Demo)</th>
                      <th className="py-2.5 pr-3">Wallet</th>
                      <th className="py-2.5 pr-3">Status</th>
                      <th className="py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td className="py-3 pr-3 font-mono tabular-nums text-slate-200">
                          {u.telegram_id}
                        </td>
                        <td className="py-3 pr-3 text-slate-200">
                          {u.username ? `@${u.username}` : u.first_name || 'Miner'}
                        </td>
                        <td className="py-3 pr-3 font-mono tabular-nums text-blue-300">
                          {u.available_balance.toFixed(2)} LOVA
                        </td>
                        <td className="py-3 pr-3 font-mono text-slate-400">
                          {u.wallet
                            ? `${u.wallet.wallet_address.slice(0, 6)}... (${
                                u.wallet.is_verified ? 'Verified' : 'Unverified'
                              })`
                            : 'None'}
                        </td>
                        <td className="py-3 pr-3 capitalize font-semibold">{u.status}</td>
                        <td className="py-3 text-right space-x-2 whitespace-nowrap">
                          {u.status !== 'active' && (
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmAction({
                                  title: 'Restore User Account',
                                  description: `Restore Telegram ID ${u.telegram_id} to active status?`,
                                  onConfirm: async () => {
                                    await apiFetch(`/api/admin/users/${u.id}/status`, {
                                      method: 'POST',
                                      body: JSON.stringify({ status: 'active' }),
                                    }, true);
                                    await loadSectionData('users');
                                  },
                                })
                              }
                              className="px-2.5 py-1 rounded-lg bg-emerald-600/20 text-emerald-300 font-semibold"
                            >
                              Unban
                            </button>
                          )}
                          {u.status === 'active' && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmAction({
                                    title: 'Suspend User Account',
                                    description: `Suspend Telegram ID ${u.telegram_id} from mining and claims?`,
                                    onConfirm: async () => {
                                      await apiFetch(`/api/admin/users/${u.id}/status`, {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          status: 'suspended',
                                          reason: 'Suspended by administrator',
                                        }),
                                      }, true);
                                      await loadSectionData('users');
                                    },
                                  })
                                }
                                className="px-2.5 py-1 rounded-lg bg-amber-600/20 text-amber-300 font-semibold"
                              >
                                Suspend
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmAction({
                                    title: 'Ban User Account',
                                    description: `Permanently ban Telegram ID ${u.telegram_id}?`,
                                    onConfirm: async () => {
                                      await apiFetch(`/api/admin/users/${u.id}/status`, {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          status: 'banned',
                                          reason: 'Banned by administrator',
                                        }),
                                      }, true);
                                      await loadSectionData('users');
                                    },
                                  })
                                }
                                className="px-2.5 py-1 rounded-lg bg-rose-600/20 text-rose-300 font-semibold inline-flex items-center gap-1"
                              >
                                <Ban className="w-3 h-3" />
                                Ban
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* MINING & PLATFORM SETTINGS */}
          {section === 'settings' && settingsForm && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmAction({
                  title: 'Save Platform Settings',
                  description:
                    'Apply updated mining rates, referral percentages, withdrawal limits, and pause flags?',
                  onConfirm: async () => {
                    await apiFetch('/api/admin/settings', {
                      method: 'PATCH',
                      body: JSON.stringify(settingsForm),
                    }, true);
                    await onRefreshBootstrap();
                    onToast('success', 'Platform settings updated.');
                  },
                });
              }}
              className="glass-panel rounded-2xl p-6 space-y-5"
            >
              <h2 className="text-base font-semibold text-white">
                Mining, Referral, Withdrawal & Platform Controls
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
                <label className="space-y-1">
                  <span className="text-slate-400">App Name</span>
                  <input
                    type="text"
                    value={settingsForm.app_name}
                    onChange={(e) => setSettingsForm({ ...settingsForm, app_name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Mining Rate (LOVA / hour)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.reward_rate_per_hour}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        reward_rate_per_hour: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Session Duration (seconds)</span>
                  <input
                    type="number"
                    value={settingsForm.mining_duration_seconds}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        mining_duration_seconds: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Minimum Claim (LOVA)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.min_claim_amount}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        min_claim_amount: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Max Reward / Session (LOVA)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.max_reward_per_session}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        max_reward_per_session: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Daily Bonus Base (LOVA)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.daily_bonus_amount}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        daily_bonus_amount: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Referral L1 Fixed Bonus</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.referral_l1_fixed_bonus}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        referral_l1_fixed_bonus: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Referral L1 Commission (%)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={settingsForm.referral_l1_percent}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        referral_l1_percent: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Referral L2 Commission (%)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={settingsForm.referral_l2_percent}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        referral_l2_percent: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Min Withdrawal (LOVA)</span>
                  <input
                    type="number"
                    step="1"
                    value={settingsForm.min_withdrawal}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, min_withdrawal: Number(e.target.value) })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Max Withdrawal (LOVA)</span>
                  <input
                    type="number"
                    step="1"
                    value={settingsForm.max_withdrawal}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, max_withdrawal: Number(e.target.value) })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">GRAM Verification Fee</span>
                  <input
                    type="number"
                    step="0.01"
                    value={settingsForm.gram_verification_fee}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        gram_verification_fee: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                  />
                </label>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="text-slate-400">
                  Admin TON Receiving Wallet Override (optional — overrides ADMIN_TON_WALLET_ADDRESS)
                </span>
                <input
                  type="text"
                  value={settingsForm.admin_ton_wallet_override || ''}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, admin_ton_wallet_override: e.target.value })
                  }
                  placeholder="UQ... or EQ..."
                  className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                />
              </label>

              <div className="flex flex-wrap gap-5 pt-2 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settingsForm.mining_enabled}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, mining_enabled: e.target.checked })
                    }
                    className="rounded"
                  />
                  <span>Mining Enabled</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer text-amber-300">
                  <input
                    type="checkbox"
                    checked={settingsForm.emergency_pause}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, emergency_pause: e.target.checked })
                    }
                    className="rounded"
                  />
                  <span>Emergency Pause All Mining & Claims</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer text-rose-300">
                  <input
                    type="checkbox"
                    checked={settingsForm.maintenance_mode}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, maintenance_mode: e.target.checked })
                    }
                    className="rounded"
                  />
                  <span>Maintenance Mode</span>
                </label>
              </div>

              <button
                type="submit"
                className="min-h-[44px] px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold"
              >
                Save Settings
              </button>
            </form>
          )}

          {/* WITHDRAWALS */}
          {section === 'withdrawals' && (
            <section className="glass-panel rounded-2xl p-5 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-white">Withdrawal Requests</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  A payout can only be marked Paid after providing a real TON transaction hash
                  verified on-chain.
                </p>
              </div>

              {withdrawals.length === 0 ? (
                <p className="text-sm text-slate-400 py-8 text-center">
                  No withdrawal requests found.
                </p>
              ) : (
                <div className="space-y-3">
                  {withdrawals.map((w) => (
                    <div
                      key={w.id}
                      className="p-4 rounded-2xl bg-[#070B17] border border-slate-800 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-white">
                            {w.user_handle} ·{' '}
                            <span className="font-mono text-blue-300">{w.amount} LOVA</span>
                          </p>
                          <p className="text-xs font-mono text-slate-400 break-all">
                            To: {w.destination_address}
                          </p>
                        </div>
                        <span className="text-xs font-semibold text-slate-200">{w.status}</span>
                      </div>

                      {(w.status === 'Pending' || w.status === 'Approved') && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
                          {w.status === 'Pending' && (
                            <button
                              type="button"
                              onClick={() =>
                                void apiFetch(
                                  `/api/admin/withdrawals/${w.id}/action`,
                                  {
                                    method: 'POST',
                                    body: JSON.stringify({ action: 'approve' }),
                                  },
                                  true
                                )
                                  .then(() => loadSectionData('withdrawals'))
                                  .catch((e) => onToast('error', e.message))
                              }
                              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold"
                            >
                              Approve
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                title: 'Reject Withdrawal',
                                description: `Reject and refund ${w.amount} LOVA back to user's available balance?`,
                                onConfirm: async () => {
                                  await apiFetch(
                                    `/api/admin/withdrawals/${w.id}/action`,
                                    {
                                      method: 'POST',
                                      body: JSON.stringify({ action: 'reject' }),
                                    },
                                    true
                                  );
                                  await loadSectionData('withdrawals');
                                },
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-300 text-xs font-semibold"
                          >
                            Reject & Refund
                          </button>
                          <input
                            type="text"
                            value={payoutHashes[w.id] || ''}
                            onChange={(e) =>
                              setPayoutHashes((p) => ({ ...p, [w.id]: e.target.value }))
                            }
                            placeholder="Finalized TON payout TX hash"
                            className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-white"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                title: 'Confirm On-Chain Payout',
                                description:
                                  'Verify the TON transaction hash on-chain and mark this withdrawal Paid?',
                                onConfirm: async () => {
                                  await apiFetch(
                                    `/api/admin/withdrawals/${w.id}/action`,
                                    {
                                      method: 'POST',
                                      body: JSON.stringify({
                                        action: 'mark_paid',
                                        payoutTxHash: payoutHashes[w.id] || '',
                                      }),
                                    },
                                    true
                                  );
                                  await loadSectionData('withdrawals');
                                },
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold"
                          >
                            Verify & Mark Paid
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* WALLETS & GRAM PAYMENTS */}
          {section === 'wallets' && (
            <div className="space-y-6">
              <section className="glass-panel rounded-2xl p-5 space-y-3">
                <h2 className="text-base font-semibold text-white">Connected TON Wallets</h2>
                {walletsData.wallets.length === 0 ? (
                  <p className="text-sm text-slate-400">No wallets connected yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/70 text-xs">
                    {walletsData.wallets.map((w) => (
                      <div
                        key={w.id}
                        className="py-3 flex flex-wrap items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-slate-100 truncate">{w.wallet_address}</p>
                          <p className="text-slate-400 mt-0.5">
                            TG {w.telegram_id} · {w.is_verified ? 'Verified' : 'Unverified'} ·{' '}
                            {w.is_suspended ? 'Suspended' : 'Active'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({
                              title: w.is_suspended ? 'Restore Wallet' : 'Suspend Wallet',
                              description: `${
                                w.is_suspended ? 'Unsuspend' : 'Suspend'
                              } wallet ${w.wallet_address.slice(0, 12)}...?`,
                              onConfirm: async () => {
                                await apiFetch(
                                  `/api/admin/wallets/${w.id}/suspend`,
                                  {
                                    method: 'POST',
                                    body: JSON.stringify({ suspended: !w.is_suspended }),
                                  },
                                  true
                                );
                                await loadSectionData('wallets');
                              },
                            })
                          }
                          className={`px-3 py-1.5 rounded-lg font-semibold ${
                            w.is_suspended
                              ? 'bg-emerald-600/20 text-emerald-300'
                              : 'bg-rose-600/20 text-rose-300'
                          }`}
                        >
                          {w.is_suspended ? 'Restore' : 'Suspend'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="glass-panel rounded-2xl p-5 space-y-3">
                <h2 className="text-base font-semibold text-white">
                  0.05 GRAM Verification Payments
                </h2>
                {walletsData.verifications.length === 0 ? (
                  <p className="text-sm text-slate-400">No GRAM payments verified yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/70 text-xs">
                    {walletsData.verifications.map((v) => (
                      <div key={v.id} className="py-3 space-y-1">
                        <div className="flex justify-between">
                          <span className="font-semibold text-emerald-300">
                            {v.amount_display} GRAM
                          </span>
                          <span className="text-slate-400">
                            {new Date(v.verified_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="font-mono text-slate-300 truncate">TX: {v.tx_hash}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TASKS, DAILY CHECK-IN & ANNOUNCEMENTS */}
          {section === 'tasks' && (
            <div className="space-y-6">
              {/* Daily Check-In Quick Reward Control */}
              <section className="glass-panel rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-white">Daily Check-In Reward</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Configure base LOVA coins awarded for Daily Check-In (scales +10%/day for consecutive streaks)
                  </p>
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await apiFetch(
                        '/api/admin/settings',
                        {
                          method: 'PATCH',
                          body: JSON.stringify({ daily_bonus_amount: Number(dailyBonusQuick) }),
                        },
                        true
                      );
                      await onRefreshBootstrap();
                      onToast('success', 'Daily Check-In reward updated.');
                    } catch (err) {
                      onToast('error', (err as Error).message);
                    }
                  }}
                  className="flex items-center gap-2 shrink-0"
                >
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={dailyBonusQuick}
                    onChange={(e) => setDailyBonusQuick(Number(e.target.value))}
                    className="w-28 px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-xs text-white"
                  />
                  <button
                    type="submit"
                    className="min-h-[38px] px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                  >
                    Save Coins
                  </button>
                </form>
              </section>

              <section className="glass-panel rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      {editingTaskId ? 'Edit Task' : 'Create New Task (Link / Coins / Ads Code)'}
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Control task links, LOVA coin rewards, and Ads verification codes
                    </p>
                  </div>
                  {editingTaskId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTaskId(null);
                        setNewTask({
                          title: '',
                          description: '',
                          category: 'ads_code',
                          reward_amount: 100,
                          action_url: '',
                          verification_code: '',
                          telegram_chat_id: '',
                          required_count: 1,
                        });
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300"
                    >
                      Cancel Edit
                    </button>
                  )}
                </div>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await apiFetch(
                        '/api/admin/tasks',
                        {
                          method: 'POST',
                          body: JSON.stringify(
                            editingTaskId ? { id: editingTaskId, ...newTask } : newTask
                          ),
                        },
                        true
                      );
                      setEditingTaskId(null);
                      setNewTask({
                        title: '',
                        description: '',
                        category: 'ads_code',
                        reward_amount: 100,
                        action_url: '',
                        verification_code: '',
                        telegram_chat_id: '',
                        required_count: 1,
                      });
                      await loadSectionData('tasks');
                      onToast('success', editingTaskId ? 'Task updated.' : 'Task created.');
                    } catch (err) {
                      onToast('error', (err as Error).message);
                    }
                  }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs"
                >
                  <label className="space-y-1">
                    <span className="text-slate-400">Task Title</span>
                    <input
                      required
                      placeholder="e.g. Watch Sponsor Ad & Enter Code"
                      value={newTask.title}
                      onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-400">Task Type</span>
                    <select
                      value={newTask.category}
                      onChange={(e) =>
                        setNewTask({ ...newTask, category: e.target.value as TaskCategory })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    >
                      <option value="ads_code">Ads Code Task</option>
                      <option value="social_link">Task Link / Social</option>
                      <option value="telegram_channel">Telegram Channel Join</option>
                      <option value="referral_milestone">Referral Milestone</option>
                      <option value="mining_sessions">Mining Sessions Milestone</option>
                      <option value="wallet_verified">Verified Wallet</option>
                      <option value="custom">Custom Task</option>
                    </select>
                  </label>

                  <label className="sm:col-span-2 space-y-1">
                    <span className="text-slate-400">Task Description</span>
                    <input
                      required
                      placeholder="Instructions shown to miners (e.g. Open ad link, find code, verify)"
                      value={newTask.description}
                      onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-slate-400">Pay for Task Coin (LOVA)</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      placeholder="Reward LOVA coins"
                      value={newTask.reward_amount}
                      onChange={(e) =>
                        setNewTask({ ...newTask, reward_amount: Number(e.target.value) })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-slate-400">Task / Ad Link (https://...)</span>
                    <input
                      placeholder="https://..."
                      value={newTask.action_url}
                      onChange={(e) => setNewTask({ ...newTask, action_url: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-slate-400">Ads / Secret Verification Code (optional)</span>
                    <input
                      placeholder="e.g. LOVA2026 (users must enter this to claim)"
                      value={newTask.verification_code}
                      onChange={(e) =>
                        setNewTask({ ...newTask, verification_code: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                    />
                  </label>

                  {newTask.category === 'telegram_channel' ? (
                    <label className="space-y-1">
                      <span className="text-slate-400">Telegram Channel ID / @username</span>
                      <input
                        placeholder="@LovaMiningOfficial"
                        value={newTask.telegram_chat_id}
                        onChange={(e) =>
                          setNewTask({ ...newTask, telegram_chat_id: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                      />
                    </label>
                  ) : (
                    <label className="space-y-1">
                      <span className="text-slate-400">Required Count (for milestones)</span>
                      <input
                        type="number"
                        min="1"
                        value={newTask.required_count}
                        onChange={(e) =>
                          setNewTask({ ...newTask, required_count: Number(e.target.value) })
                        }
                        className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                      />
                    </label>
                  )}

                  <button
                    type="submit"
                    className="sm:col-span-2 min-h-[42px] rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold inline-flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    {editingTaskId ? 'Update Task' : 'Add Task'}
                  </button>
                </form>

                <div className="divide-y divide-slate-800/70 text-xs pt-2">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-semibold text-white">
                          {t.title} ·{' '}
                          <span className="font-mono text-blue-300">+{t.reward_amount} LOVA</span>
                        </p>
                        <p className="text-slate-400 truncate">
                          {t.category} · {t.is_active ? 'Active' : 'Disabled'}
                          {t.action_url ? ` · Link: ${t.action_url}` : ''}
                          {t.verification_code ? ` · Ads Code: ${t.verification_code}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTaskId(t.id);
                            setNewTask({
                              title: t.title,
                              description: t.description,
                              category: t.category,
                              reward_amount: t.reward_amount,
                              action_url: t.action_url || '',
                              verification_code: t.verification_code || '',
                              telegram_chat_id: t.telegram_chat_id || '',
                              required_count: t.required_count || 1,
                            });
                          }}
                          className="px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-300 font-semibold"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void apiFetch(
                              '/api/admin/tasks',
                              {
                                method: 'POST',
                                body: JSON.stringify({ ...t, is_active: !t.is_active }),
                              },
                              true
                            ).then(() => loadSectionData('tasks'))
                          }
                          className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-200"
                        >
                          {t.is_active ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void apiFetch(`/api/admin/tasks/${t.id}`, { method: 'DELETE' }, true).then(
                              () => loadSectionData('tasks')
                            )
                          }
                          className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/10"
                          aria-label="Delete task"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="glass-panel rounded-2xl p-5 space-y-4">
                <h2 className="text-base font-semibold text-white">Publish Announcement</h2>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await apiFetch(
                      '/api/admin/announcements',
                      { method: 'POST', body: JSON.stringify(newAnnouncement) },
                      true
                    );
                    setNewAnnouncement({ title: '', body: '', category: 'airdrop' });
                    await loadSectionData('tasks');
                    await onRefreshBootstrap();
                    onToast('success', 'Announcement published.');
                  }}
                  className="space-y-3 text-xs"
                >
                  <input
                    required
                    placeholder="Announcement Title"
                    value={newAnnouncement.title}
                    onChange={(e) =>
                      setNewAnnouncement({ ...newAnnouncement, title: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                  />
                  <textarea
                    required
                    rows={2}
                    placeholder="Announcement Body"
                    value={newAnnouncement.body}
                    onChange={(e) =>
                      setNewAnnouncement({ ...newAnnouncement, body: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                  />
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 rounded-xl bg-blue-600 text-white font-semibold"
                  >
                    Publish
                  </button>
                </form>

                <div className="divide-y divide-slate-800/70 text-xs">
                  {announcements.map((a) => (
                    <div key={a.id} className="py-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-white">{a.title}</p>
                        <p className="text-slate-400">{a.body}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void apiFetch(
                            `/api/admin/announcements/${a.id}`,
                            { method: 'DELETE' },
                            true
                          ).then(() => loadSectionData('tasks'))
                        }
                        className="p-1.5 text-rose-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* REFERRALS & AUDIT LOGS */}
          {section === 'audit' && (
            <div className="space-y-6">
              <section className="glass-panel rounded-2xl p-5 space-y-3">
                <h2 className="text-base font-semibold text-white">Referral Attribution Records</h2>
                {referralsData.referrals.length === 0 ? (
                  <p className="text-sm text-slate-400">No referral records yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/70 text-xs">
                    {referralsData.referrals.map((r) => (
                      <div key={r.id} className="py-2.5 flex justify-between">
                        <span>
                          {r.referrer_handle} invited {r.referred_handle} (Level {r.level})
                        </span>
                        <span className="font-mono text-slate-400">
                          {new Date(r.created_at).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="glass-panel rounded-2xl p-5 space-y-3">
                <h2 className="text-base font-semibold text-white">Admin Audit Logs</h2>
                {auditLogs.length === 0 ? (
                  <p className="text-sm text-slate-400">No admin actions logged yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/70 text-xs">
                    {auditLogs.map((log) => (
                      <div key={log.id} className="py-2.5 flex flex-wrap justify-between gap-2">
                        <div>
                          <span className="font-mono font-semibold text-blue-300">{log.action}</span>{' '}
                          <span className="text-slate-300">
                            · {log.target_type} ({log.target_id || '—'})
                          </span>
                        </div>
                        <span className="font-mono text-slate-400">
                          {log.admin_role} · {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TELEGRAM BOT & SETUP READINESS */}
          {section === 'telegram' && (
            <div className="space-y-6">
              {/* Connect Telegram Bot */}
              <section className="glass-panel rounded-2xl p-5 sm:p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      Telegram Bot &amp; Mini App Connection
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Sync bot commands, Menu Button WebApp URL, and live webhook updates (/start,
                      /mine, /balance, /referral)
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={checkingWebhookHealth}
                      onClick={async () => {
                        const base = botMiniAppUrl.trim().replace(/\/+$/, '');
                        const targetUrl = base
                          ? `${base}/api/telegram/webhook`
                          : botStatus?.webhook?.url ||
                            `${window.location.origin}/api/telegram/webhook`;
                        try {
                          setCheckingWebhookHealth(true);
                          const res = await apiFetch<NonNullable<typeof webhookHealth>>(
                            '/api/admin/telegram/webhook-health',
                            {
                              method: 'POST',
                              body: JSON.stringify({ url: targetUrl }),
                            },
                            true
                          );
                          setWebhookHealth(res);
                          onToast(res.healthy ? 'success' : 'error', res.summary);
                        } catch (err) {
                          onToast('error', (err as Error).message);
                        } finally {
                          setCheckingWebhookHealth(false);
                        }
                      }}
                      className="min-h-[36px] px-3 py-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/35 text-xs font-semibold text-blue-200 inline-flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Activity
                        className={`w-3.5 h-3.5 ${checkingWebhookHealth ? 'animate-pulse' : ''}`}
                      />
                      {checkingWebhookHealth ? 'Checking...' : 'Check Webhook Health'}
                    </button>
                    <button
                      type="button"
                      disabled={botBusy}
                      onClick={() => void loadSectionData('telegram')}
                      className="min-h-[36px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${botBusy ? 'animate-spin' : ''}`} />
                      Refresh Status
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3.5 rounded-xl bg-[#070B17] border border-slate-800">
                    <p className="text-slate-400">Bot Token &amp; Identity</p>
                    <p className="font-semibold text-white mt-1 font-mono">
                      {botStatus?.bot?.username
                        ? `@${botStatus.bot.username}`
                        : systemStatus.telegramBotConfigured
                          ? 'Configured (Checking...)'
                          : 'Not Set'}
                    </p>
                    <p className="text-slate-400 mt-0.5">
                      {botStatus?.bot ? `ID ${botStatus.bot.id}` : 'Set TELEGRAM_BOT_TOKEN'}
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070B17] border border-slate-800">
                    <p className="text-slate-400">Mini App Menu Button</p>
                    <p className="font-semibold text-blue-300 mt-1 truncate">
                      {botStatus?.menuButton?.web_app?.url || 'Not Linked Yet'}
                    </p>
                    <p className="text-slate-400 mt-0.5 capitalize">
                      Mode: {botStatus?.menuButton?.type || 'default'}
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[#070B17] border border-slate-800">
                    <p className="text-slate-400">Webhook Status</p>
                    <p className="font-semibold text-emerald-300 mt-1 truncate">
                      {botStatus?.webhook?.url ? 'Active Webhook' : 'Not Registered'}
                    </p>
                    <p className="text-slate-400 mt-0.5 truncate">
                      {botStatus?.webhook?.url || 'No webhook URL set'}
                    </p>
                  </div>
                </div>

                {(botStatus?.error ||
                  botStatus?.webhook?.last_error_message ||
                  /ais-(dev|pre)-/.test(botMiniAppUrl)) && (
                  <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/30 text-xs text-amber-200 space-y-1.5">
                    {(botStatus?.error || botStatus?.webhook?.last_error_message) && (
                      <p className="font-semibold">
                        {botStatus?.error || botStatus?.webhook?.last_error_message}
                      </p>
                    )}
                    {(/ais-(dev|pre)-/.test(botMiniAppUrl) ||
                      /ais-(dev|pre)-/.test(botStatus?.webhook?.url || '') ||
                      botStatus?.webhook?.last_error_message?.includes('404')) && (
                      <p className="text-amber-200/85 leading-relaxed">
                        AI Studio preview/share hosts (<code className="font-mono">ais-dev-*</code> /{' '}
                        <code className="font-mono">ais-pre-*</code>) place an authentication cookie
                        redirect (<code className="font-mono">302 /__cookie_check.html</code>) in
                        front of unauthenticated external requests, which causes Telegram webhook
                        POST requests to receive <strong>404</strong>. Use AI Studio&apos;s{' '}
                        <strong>Deploy to Cloud Run</strong> (or{' '}
                        <code className="font-mono">gcloud run deploy --allow-unauthenticated</code>)
                        and paste your public <code className="font-mono">https://...run.app</code>{' '}
                        service URL here.
                      </p>
                    )}
                  </div>
                )}

                {webhookHealth && (
                  <div
                    className={`p-4 rounded-xl border text-xs space-y-2 ${
                      webhookHealth.healthy
                        ? 'bg-emerald-950/25 border-emerald-500/35 text-emerald-100'
                        : 'bg-rose-950/25 border-rose-500/35 text-rose-100'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold inline-flex items-center gap-1.5">
                        <Activity className="w-4 h-4 shrink-0" />
                        Manual Webhook Health Check:{' '}
                        <span className="font-mono">
                          POST {webhookHealth.postStatus ?? 'ERR'} · GET{' '}
                          {webhookHealth.getStatus ?? 'ERR'}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-[11px] opacity-80">
                        {webhookHealth.latencyMs}ms ·{' '}
                        {new Date(webhookHealth.checkedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="font-mono text-[11px] opacity-90 break-all">
                      Target: {webhookHealth.url}
                    </p>
                    <p className="leading-relaxed">{webhookHealth.summary}</p>
                    {webhookHealth.redirectLocation && (
                      <p className="font-mono text-[11px] opacity-85 break-all">
                        Redirect Location: {webhookHealth.redirectLocation}
                      </p>
                    )}
                    {webhookHealth.responsePreview && (
                      <p className="font-mono text-[11px] bg-black/30 rounded-lg p-2 break-all opacity-85">
                        {webhookHealth.responsePreview}
                      </p>
                    )}
                  </div>
                )}

                {systemStatus.telegramBotConfigured ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        setBotBusy(true);
                        const res = await apiFetch<{
                          ok: boolean;
                          steps: {
                            commands: { ok: boolean; detail: string };
                            menuButton: { ok: boolean; detail: string };
                            webhook: { ok: boolean; detail: string };
                          };
                          status: NonNullable<typeof botStatus>;
                        }>(
                          '/api/admin/telegram/configure',
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              miniAppUrl: botMiniAppUrl,
                              registerWebhook,
                            }),
                          },
                          true
                        );
                        setBotStatus((prev) => ({ ...prev, ...res.status }));
                        await onRefreshBootstrap();
                        onToast(
                          res.ok ? 'success' : 'info',
                          res.ok
                            ? 'Telegram Bot connected! Commands, Menu Button & Webhook synced.'
                            : `${res.steps.commands.detail} | ${res.steps.menuButton.detail} | ${res.steps.webhook.detail}`
                        );
                      } catch (err) {
                        onToast('error', (err as Error).message);
                      } finally {
                        setBotBusy(false);
                      }
                    }}
                    className="space-y-3 text-xs pt-2 border-t border-slate-800/80"
                  >
                    <label className="block space-y-1">
                      <span className="text-slate-300">
                        Public HTTPS Mini App URL (auto-detected from browser origin or paste your
                        Cloudflare/App URL)
                      </span>
                      <input
                        type="url"
                        required
                        placeholder="https://your-app-url.run.app"
                        value={botMiniAppUrl}
                        onChange={(e) => setBotMiniAppUrl(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white focus:outline-none focus:border-blue-500"
                      />
                    </label>

                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={registerWebhook}
                        onChange={(e) => setRegisterWebhook(e.target.checked)}
                        className="rounded"
                      />
                      <span>
                        Also register live Bot Webhook at{' '}
                        <code className="font-mono text-blue-300">
                          {botMiniAppUrl.replace(/\/+$/, '')}/api/telegram/webhook
                        </code>
                      </span>
                    </label>

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <button
                        type="submit"
                        disabled={botBusy}
                        className="min-h-[44px] px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        <Bot className="w-4 h-4" />
                        {botBusy ? 'Connecting to Telegram...' : 'Connect & Sync Telegram Bot'}
                      </button>
                      {botStatus?.bot?.username && (
                        <a
                          href={`https://t.me/${botStatus.bot.username}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold inline-flex items-center gap-1.5"
                        >
                          Open @{botStatus.bot.username}
                        </a>
                      )}
                    </div>
                  </form>
                ) : (
                  <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300 space-y-2 leading-relaxed">
                    <p className="font-semibold text-white">How to connect your Telegram Bot:</p>
                    <ol className="list-decimal list-inside space-y-1 text-slate-300">
                      <li>
                        Open <strong>@BotFather</strong> in Telegram and run{' '}
                        <code className="font-mono text-blue-300">/newbot</code> to get your Bot
                        Token.
                      </li>
                      <li>
                        Add <code className="font-mono text-blue-300">TELEGRAM_BOT_TOKEN</code> to
                        your AI Studio Secrets panel (and restart/refresh).
                      </li>
                      <li>
                        Return here and click <strong>Connect &amp; Sync Telegram Bot</strong> to
                        automatically link the Mini App Menu Button, commands, and webhook.
                      </li>
                    </ol>
                  </div>
                )}
              </section>

              {/* Database & Environment Setup */}
              <section className="glass-panel rounded-2xl p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Database className="w-5 h-5 text-blue-400" />
                    <div>
                      <h2 className="text-base font-semibold text-white">
                        Supabase PostgreSQL &amp; Setup Readiness
                      </h2>
                      <p className="text-xs text-slate-400">
                        Active storage:{' '}
                        <strong className="text-slate-200">
                          {systemStatus.databaseMode === 'supabase'
                            ? 'Supabase PostgreSQL (Live)'
                            : systemStatus.databaseMode === 'supabase_needs_schema'
                              ? 'Supabase Credentials Found — Schema Not Applied Yet'
                              : 'Local Preview Store (.data/lova-store.json)'}
                        </strong>
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await apiFetch<{ sql: string }>('/api/admin/schema-sql', {}, true);
                        await navigator.clipboard.writeText(res.sql);
                        setCopiedSchema(true);
                        onToast('success', 'Copied supabase/schema.sql to clipboard!');
                        setTimeout(() => setCopiedSchema(false), 2500);
                      } catch (err) {
                        onToast('error', (err as Error).message);
                      }
                    }}
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    {copiedSchema ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copiedSchema ? 'Copied SQL!' : 'Copy supabase/schema.sql'}
                  </button>
                </div>

                {systemStatus.databaseMode !== 'supabase' && (
                  <p className="text-xs text-amber-200/90 leading-relaxed bg-amber-950/25 border border-amber-500/25 rounded-xl p-3.5">
                    {systemStatus.databaseMode === 'supabase_needs_schema'
                      ? 'Your Supabase project is connected, but the 16 LOVA tables have not been created yet. Click "Copy supabase/schema.sql" above, open Supabase -> SQL Editor, paste and run it once. The server will automatically switch to live PostgreSQL within 30 seconds.'
                      : 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Secrets and run supabase/schema.sql in Supabase SQL Editor for persistent cloud database storage.'}
                  </p>
                )}
              </section>

              {/* Admin Team & Roles */}
              <section className="glass-panel rounded-2xl p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-white">Admin Team &amp; Roles</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Authorize Telegram IDs as super_admin, finance_admin, or moderator
                    </p>
                  </div>
                  <UserPlus className="w-4 h-4 text-blue-400" />
                </div>

                {envAdminIds.length > 0 && (
                  <p className="text-xs text-slate-400">
                    Env Super Admin IDs:{' '}
                    <span className="font-mono text-slate-200">{envAdminIds.join(', ')}</span>
                  </p>
                )}

                {adminAuth.role === 'super_admin' && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiFetch(
                          '/api/admin/admins',
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              telegram_id: Number(newAdminForm.telegram_id),
                              display_name: newAdminForm.display_name,
                              role: newAdminForm.role,
                            }),
                          },
                          true
                        );
                        setNewAdminForm({ telegram_id: '', display_name: '', role: 'moderator' });
                        await loadSectionData('telegram');
                        onToast('success', 'Admin role saved.');
                      } catch (err) {
                        onToast('error', (err as Error).message);
                      }
                    }}
                    className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs"
                  >
                    <input
                      type="number"
                      required
                      placeholder="Telegram ID"
                      value={newAdminForm.telegram_id}
                      onChange={(e) =>
                        setNewAdminForm({ ...newAdminForm, telegram_id: e.target.value })
                      }
                      className="px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 font-mono text-white"
                    />
                    <input
                      type="text"
                      required
                      placeholder="Display Name"
                      value={newAdminForm.display_name}
                      onChange={(e) =>
                        setNewAdminForm({ ...newAdminForm, display_name: e.target.value })
                      }
                      className="px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    />
                    <select
                      value={newAdminForm.role}
                      onChange={(e) =>
                        setNewAdminForm({ ...newAdminForm, role: e.target.value as AdminRole })
                      }
                      className="px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-white"
                    >
                      <option value="super_admin">super_admin</option>
                      <option value="finance_admin">finance_admin</option>
                      <option value="moderator">moderator</option>
                    </select>
                    <button
                      type="submit"
                      className="min-h-[38px] rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                    >
                      Add / Update Admin
                    </button>
                  </form>
                )}

                <div className="divide-y divide-slate-800/70 text-xs">
                  {adminsList.length === 0 ? (
                    <p className="text-slate-400 py-4 text-center">
                      No database-stored admin records yet (using server bootstrap / env admin list).
                    </p>
                  ) : (
                    adminsList.map((adm) => (
                      <div key={adm.id} className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-white">
                            {adm.display_name} ·{' '}
                            <span className="font-mono text-blue-300">{adm.role}</span>
                          </p>
                          <p className="text-slate-400 font-mono">
                            TG {adm.telegram_id || '—'} · {adm.is_active ? 'Active' : 'Disabled'}
                          </p>
                        </div>
                        {adminAuth.role === 'super_admin' && (
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                title: adm.is_active ? 'Deactivate Admin' : 'Activate Admin',
                                description: `${adm.is_active ? 'Revoke' : 'Restore'} admin access for ${adm.display_name}?`,
                                onConfirm: async () => {
                                  await apiFetch(
                                    `/api/admin/admins/${adm.id}/toggle`,
                                    {
                                      method: 'POST',
                                      body: JSON.stringify({ is_active: !adm.is_active }),
                                    },
                                    true
                                  );
                                  await loadSectionData('telegram');
                                },
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg font-semibold ${
                              adm.is_active
                                ? 'bg-rose-600/20 text-rose-300'
                                : 'bg-emerald-600/20 text-emerald-300'
                            }`}
                          >
                            {adm.is_active ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>

      {/* Sensitive Action Confirmation Modal */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel-elevated rounded-2xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-2.5 text-amber-300">
              <ShieldAlert className="w-5 h-5" />
              <h3 className="text-base font-bold text-white">{confirmAction.title}</h3>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{confirmAction.description}</p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const fn = confirmAction.onConfirm;
                  setConfirmAction(null);
                  try {
                    await fn();
                  } catch (err) {
                    onToast('error', (err as Error).message);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                Confirm Action
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
