import { useEffect, useState } from 'react';
import { TonConnectButton, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Info,
  ShieldAlert,
  ShieldCheck,
  Unlink,
  Wallet,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { resolveTonConnectManifest } from '../lib/tonManifest';
import { buildJettonTransferPayloadBase64, getBocHashHex } from '../lib/tonPayload';
import type {
  AppSettings,
  LovaUser,
  PublicSystemStatus,
  UserWallet,
  WalletVerification,
  WithdrawalItem,
} from '../types/lova';

interface WalletViewProps {
  user: LovaUser;
  activeWallet: UserWallet | null;
  settings: AppSettings;
  systemStatus: PublicSystemStatus;
  onRefreshBootstrap: () => Promise<void>;
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}

export function WalletView({
  user,
  activeWallet,
  settings,
  systemStatus,
  onRefreshBootstrap,
  onToast,
}: WalletViewProps) {
  const tonWallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();

  const [verifications, setVerifications] = useState<WalletVerification[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalItem[]>([]);
  const [limits, setLimits] = useState({
    minWithdrawal: settings.min_withdrawal,
    maxWithdrawal: settings.max_withdrawal,
  });

  const [manualTxHash, setManualTxHash] = useState('');
  const [manualAddressInput, setManualAddressInput] = useState('');
  const [showBridgeInPreview, setShowBridgeInPreview] = useState(false);
  const [tonConnectError, setTonConnectError] = useState<string | null>(null);
  const [jettonWalletInput, setJettonWalletInput] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'verify' | 'withdraw' | null>(null);

  const tonManifest = resolveTonConnectManifest(systemStatus);

  const loadWalletData = async () => {
    try {
      const [verRes, wdRes] = await Promise.all([
        apiFetch<{ verifications: WalletVerification[] }>('/api/wallet/verifications'),
        apiFetch<{
          withdrawals: WithdrawalItem[];
          limits: { minWithdrawal: number; maxWithdrawal: number };
        }>('/api/withdrawals'),
      ]);
      setVerifications(verRes.verifications);
      setWithdrawals(wdRes.withdrawals);
      setLimits(wdRes.limits);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    void loadWalletData();
  }, [user.id, activeWallet?.id]);

  // Sync TON Connect wallet address to backend securely whenever user connects in TON Connect modal
  useEffect(() => {
    const addr = tonWallet?.account?.address;
    if (!addr) return;
    if (activeWallet && activeWallet.raw_address.toLowerCase() === addr.toLowerCase()) return;

    (async () => {
      try {
        setBusy('connect');
        await apiFetch('/api/wallet/connect', {
          method: 'POST',
          body: JSON.stringify({
            address: addr,
            provider: tonWallet.device?.appName || 'TON Connect',
          }),
        });
        await onRefreshBootstrap();
        onToast('info', 'TON wallet connected. Complete 0.05 GRAM verification to unlock verified status.');
      } catch (err) {
        onToast('error', (err as Error).message);
      } finally {
        setBusy(null);
      }
    })();
  }, [tonWallet?.account?.address]);

  // Surface TON Connect bridge/manifest errors cleanly in UI instead of failing silently
  useEffect(() => {
    if (!tonConnectUI) return;
    const unsubscribe = tonConnectUI.onStatusChange(
      (wallet) => {
        if (wallet) {
          setTonConnectError(null);
        }
      },
      (err) => {
        const msg = err?.message || String(err || '');
        if (/manifest/i.test(msg) || (err as { name?: string })?.name === 'ManifestNotFoundError') {
          const detail =
            'External TON wallet could not fetch tonconnect-manifest.json. Auth-gated preview URLs (ais-dev / localhost) redirect external wallet requests; deploy to a public HTTPS URL or set TONCONNECT_MANIFEST_URL.';
          setTonConnectError(detail);
          onToast('error', 'Wallet manifest unreachable from this preview URL.');
          try {
            tonConnectUI.closeModal();
          } catch {
            // ignore modal close errors
          }
        } else if (/user rejects/i.test(msg)) {
          onToast('info', 'Wallet connection request was cancelled.');
        } else if (msg) {
          setTonConnectError(msg);
          onToast('error', msg);
        }
      }
    );
    return unsubscribe;
  }, [tonConnectUI, onToast]);

  const handleManualAddressConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualAddressInput.trim();
    if (!trimmed) {
      onToast('error', 'Enter a valid TON wallet address (UQ... or EQ...).');
      return;
    }
    try {
      setBusy('connect');
      setTonConnectError(null);
      await apiFetch('/api/wallet/connect', {
        method: 'POST',
        body: JSON.stringify({
          address: trimmed,
          provider: 'TON Address (Preview)',
        }),
      });
      setManualAddressInput('');
      await onRefreshBootstrap();
      onToast('success', 'TON wallet address connected.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    try {
      setBusy('disconnect');
      if (tonWallet) {
        await tonConnectUI.disconnect();
      }
      await apiFetch('/api/wallet/disconnect', { method: 'POST' });
      await onRefreshBootstrap();
      onToast('info', 'TON wallet disconnected.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handlePayAndVerifyGram = async () => {
    if (!activeWallet || !systemStatus.gramVerificationConfigured) return;
    if (!tonWallet) {
      onToast('error', 'Connect your TON wallet via TON Connect first.');
      return;
    }
    if (!jettonWalletInput.trim()) {
      onToast(
        'error',
        'Enter your GRAM Jetton Wallet address (from Tonviewer/Tonkeeper) or verify an existing TX hash below.'
      );
      return;
    }

    try {
      setBusy('verify');
      const payload = buildJettonTransferPayloadBase64({
        amount: systemStatus.gramVerificationFee,
        decimals: systemStatus.gramJettonDecimals!,
        destinationAddress: systemStatus.adminTonWalletAddress!,
        responseAddress: activeWallet.wallet_address,
        comment: `LOVA-${user.telegram_id}`,
      });

      const txResult = await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [
          {
            address: jettonWalletInput.trim(),
            amount: '65000000', // 0.065 TON gas attached (excess returned to sender)
            payload,
          },
        ],
      });

      const bocHash = getBocHashHex(txResult.boc);
      setManualTxHash(bocHash);
      onToast(
        'info',
        'Transaction signed! Submitting hash to server for on-chain finality verification...'
      );

      await apiFetch('/api/wallet/verify-gram', {
        method: 'POST',
        body: JSON.stringify({ txHash: bocHash }),
      });
      await onRefreshBootstrap();
      await loadWalletData();
      onToast('success', 'Wallet verified on-chain via 0.05 GRAM Jetton transfer!');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyManualHash = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTxHash.trim()) return;
    try {
      setBusy('verify');
      await apiFetch('/api/wallet/verify-gram', {
        method: 'POST',
        body: JSON.stringify({ txHash: manualTxHash.trim() }),
      });
      setManualTxHash('');
      await onRefreshBootstrap();
      await loadWalletData();
      onToast('success', '0.05 GRAM transaction verified on-chain! Wallet is now Verified.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleRequestWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = Number(withdrawAmount);
    if (!Number.isFinite(num) || num <= 0) {
      onToast('error', 'Enter a valid withdrawal amount.');
      return;
    }
    try {
      setBusy('withdraw');
      await apiFetch('/api/withdrawals/request', {
        method: 'POST',
        body: JSON.stringify({ amount: num }),
      });
      setWithdrawAmount('');
      await onRefreshBootstrap();
      await loadWalletData();
      onToast('success', 'Withdrawal request submitted for admin review.');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Wallet Connection & Verification Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-6 glass-panel-elevated rounded-3xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-white">TON Wallet</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Tonkeeper, TON Space & TON Connect compatible wallets · Never enter seed phrases
              </p>
            </div>
            {(!tonManifest.isGatedPreviewWithoutPublicManifest || showBridgeInPreview) && (
              <TonConnectButton />
            )}
          </div>

          {tonConnectError && (
            <div className="p-3.5 rounded-2xl bg-rose-950/35 border border-rose-500/35 text-xs text-rose-200 leading-relaxed flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-100">TON Connect Manifest Error</p>
                <p className="mt-0.5 text-rose-200/90">{tonConnectError}</p>
              </div>
            </div>
          )}

          {activeWallet ? (
            <div className="p-4 rounded-2xl bg-[#070B17] border border-slate-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-400">
                  {activeWallet.wallet_provider || 'Connected TON Wallet'}
                </span>
                {activeWallet.is_suspended ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
                    <ShieldAlert className="w-4 h-4" />
                    Suspended
                  </span>
                ) : activeWallet.is_verified ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                    <ShieldCheck className="w-4 h-4" />
                    Verified Wallet
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                    <AlertTriangle className="w-4 h-4" />
                    Unverified Wallet
                  </span>
                )}
              </div>

              <p className="font-mono text-xs sm:text-sm text-slate-100 break-all">
                {activeWallet.wallet_address}
              </p>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80 text-xs text-slate-400">
                <span>
                  {activeWallet.verified_at
                    ? `Verified ${new Date(activeWallet.verified_at).toLocaleDateString()}`
                    : 'Changing wallets requires fresh 0.05 GRAM verification'}
                </span>
                <button
                  type="button"
                  disabled={busy === 'disconnect'}
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-1.5 text-rose-300 hover:text-rose-200 font-medium"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </div>
            </div>
          ) : tonManifest.isGatedPreviewWithoutPublicManifest ? (
            <div className="p-5 rounded-2xl bg-[#070B17] border border-slate-800 space-y-4">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <p className="text-sm font-semibold text-slate-100">
                    Preview Mode · Direct TON Address Link
                  </p>
                  <p className="text-slate-400 leading-relaxed">
                    External mobile & Telegram wallets must fetch{' '}
                    <code className="font-mono text-slate-300">/tonconnect-manifest.json</code>{' '}
                    over the public internet, which auth-gated preview URLs block. Deploy publicly
                    or set <code className="font-mono text-slate-300">TONCONNECT_MANIFEST_URL</code>{' '}
                    to enable the TON Connect QR modal.
                  </p>
                </div>
              </div>

              <form onSubmit={handleManualAddressConnect} className="space-y-2.5">
                <label className="block text-xs text-slate-300 font-medium">
                  Connect TON Wallet Address for Preview Testing
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={manualAddressInput}
                    onChange={(e) => setManualAddressInput(e.target.value)}
                    placeholder="UQ... or EQ... (TON wallet address)"
                    className="flex-1 px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || !manualAddressInput.trim()}
                    className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 shrink-0"
                  >
                    {busy === 'connect' ? 'Connecting...' : 'Connect Address'}
                  </button>
                </div>
              </form>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>Using a local TON browser extension?</span>
                <button
                  type="button"
                  onClick={() => setShowBridgeInPreview((prev) => !prev)}
                  className="text-blue-400 hover:text-blue-300 font-medium"
                >
                  {showBridgeInPreview ? 'Hide TON Connect Button' : 'Show TON Connect Button'}
                </button>
              </div>
            </div>
          ) : (
            <div className="p-6 rounded-2xl bg-[#070B17] border border-slate-800 text-center space-y-2">
              <Wallet className="w-8 h-8 text-blue-400 mx-auto" />
              <p className="text-sm font-medium text-slate-200">No TON Wallet Connected</p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                Click the Connect Wallet button above to link Tonkeeper or TON Space safely using
                TON Connect.
              </p>
            </div>
          )}

          {/* 0.05 GRAM Verification Module */}
          <div className="pt-4 border-t border-slate-800/80 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-white">
                0.05 GRAM Wallet Ownership Verification
              </h2>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Verification fee:{' '}
                <strong className="font-mono text-blue-300">
                  {systemStatus.gramVerificationFee} GRAM
                </strong>{' '}
                (this is a <strong>GRAM Jetton transfer, NOT 0.05 TON</strong>). Your wallet will
                also pay a separate TON network gas fee (~0.05–0.1 TON; unused gas is refunded).
              </p>
            </div>

            {!systemStatus.gramVerificationConfigured ? (
              <div className="p-4 rounded-2xl bg-amber-950/25 border border-amber-500/30 space-y-2 text-xs">
                <div className="flex items-center gap-2 font-semibold text-amber-200">
                  <Info className="w-4 h-4 text-amber-400 shrink-0" />
                  Verification Disabled Pending Server Configuration
                </div>
                <p className="text-amber-200/80 leading-relaxed">
                  For your security, GRAM payment verification remains strictly disabled until the
                  server administrator configures the verified{' '}
                  <code className="font-mono">GRAM_JETTON_MASTER_ADDRESS</code>,{' '}
                  <code className="font-mono">GRAM_JETTON_DECIMALS</code>, and{' '}
                  <code className="font-mono">ADMIN_TON_WALLET_ADDRESS</code> environment variables.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Admin Receiver Address</span>
                    <span className="font-mono text-slate-200 truncate max-w-[220px]">
                      {systemStatus.adminTonWalletAddress}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">GRAM Master Contract</span>
                    <span className="font-mono text-slate-200 truncate max-w-[220px]">
                      {systemStatus.gramJettonMasterAddress}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-400">Required Amount (Exact)</span>
                    <span className="font-mono font-semibold text-blue-300">
                      {systemStatus.gramVerificationFee} GRAM ({systemStatus.gramJettonDecimals}{' '}
                      decimals)
                    </span>
                  </div>
                </div>

                {activeWallet && !activeWallet.is_verified && (
                  <>
                    <div className="space-y-2">
                      <label className="block text-xs text-slate-300">
                        Your GRAM Jetton Wallet Address (required to construct TEP-74 payload)
                      </label>
                      <input
                        type="text"
                        value={jettonWalletInput}
                        onChange={(e) => setJettonWalletInput(e.target.value)}
                        placeholder="EQ... (your GRAM Jetton wallet address)"
                        className="w-full px-3.5 py-2.5 rounded-xl bg-[#070B17] border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                      />
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={handlePayAndVerifyGram}
                        className="w-full min-h-[44px] rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white text-sm font-semibold transition-all disabled:opacity-50"
                      >
                        {busy === 'verify'
                          ? 'Awaiting Wallet & Blockchain Check...'
                          : `Approve ${systemStatus.gramVerificationFee} GRAM Verification`}
                      </button>
                    </div>

                    <form
                      onSubmit={handleVerifyManualHash}
                      className="pt-3 border-t border-slate-800/70 space-y-2"
                    >
                      <label className="block text-xs text-slate-400">
                        Already sent 0.05 GRAM from your connected wallet? Paste finalized TX hash:
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={manualTxHash}
                          onChange={(e) => setManualTxHash(e.target.value)}
                          placeholder="TON transaction or event hash"
                          className="flex-1 px-3 py-2 rounded-xl bg-[#070B17] border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                        />
                        <button
                          type="submit"
                          disabled={busy !== null || !manualTxHash.trim()}
                          className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Verify Hash
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* User Balance & Withdrawal Request Form */}
        <section className="lg:col-span-6 glass-panel rounded-3xl p-6 space-y-5">
          <div>
            <p className="text-xs font-medium text-blue-300">
              {systemStatus.isDemoTokenMode
                ? 'Demo Balance Mode · LOVA Jetton Deployment Pending'
                : 'Live LOVA Token Balance'}
            </p>
            <h2 className="text-xl font-bold text-white mt-0.5">Balances & Withdrawals</h2>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3.5 rounded-2xl bg-[#070B17] border border-slate-800">
              <p className="text-xs text-slate-400">Available (Demo)</p>
              <p className="text-lg font-bold font-mono tabular-nums text-white mt-0.5">
                {user.available_balance.toFixed(2)} LOVA
              </p>
            </div>
            <div className="p-3.5 rounded-2xl bg-[#070B17] border border-slate-800">
              <p className="text-xs text-slate-400">Pending Review</p>
              <p className="text-lg font-bold font-mono tabular-nums text-amber-300 mt-0.5">
                {user.pending_balance.toFixed(2)} LOVA
              </p>
            </div>
            <div className="p-3.5 rounded-2xl bg-[#070B17] border border-slate-800">
              <p className="text-xs text-slate-400">Total Earned</p>
              <p className="text-lg font-bold font-mono tabular-nums text-blue-300 mt-0.5">
                {user.total_earned.toFixed(2)} LOVA
              </p>
            </div>
            <div className="p-3.5 rounded-2xl bg-[#070B17] border border-slate-800">
              <p className="text-xs text-slate-400">Total Withdrawn</p>
              <p className="text-lg font-bold font-mono tabular-nums text-emerald-300 mt-0.5">
                {user.total_withdrawn.toFixed(2)} LOVA
              </p>
            </div>
          </div>

          {systemStatus.isDemoTokenMode && (
            <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-500/25 text-xs text-blue-200 leading-relaxed">
              The 1,000,000,000 LOVA Mintable Jetton has not been deployed on-chain yet. Withdrawal
              requests are queued for manual review and will only be marked <strong>Paid</strong>{' '}
              after an admin verifies a real TON blockchain payout transaction.
            </div>
          )}

          <form onSubmit={handleRequestWithdrawal} className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Withdrawal Amount (LOVA)</span>
              <span className="font-mono tabular-nums">
                Min {limits.minWithdrawal} · Max {limits.maxWithdrawal}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.01"
                min={limits.minWithdrawal}
                max={limits.maxWithdrawal}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder={`Enter ${limits.minWithdrawal}+ LOVA`}
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-[#070B17] border border-slate-700 text-sm font-mono tabular-nums text-white focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() =>
                  setWithdrawAmount(
                    String(Math.min(user.available_balance, limits.maxWithdrawal))
                  )
                }
                className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-blue-300"
              >
                Max
              </button>
            </div>

            <button
              type="submit"
              disabled={busy !== null || !activeWallet?.is_verified}
              className="w-full min-h-[46px] rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <ArrowUpRight className="w-4 h-4" />
              {busy === 'withdraw'
                ? 'Submitting Request...'
                : activeWallet?.is_verified
                  ? 'Submit Withdrawal Request'
                  : 'Verify Wallet (0.05 GRAM) to Withdraw'}
            </button>
          </form>
        </section>
      </div>

      {/* Payment & Withdrawal History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass-panel rounded-2xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-white mb-3">
            GRAM Verification Payment History
          </h3>
          {verifications.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center">
              No verified 0.05 GRAM payments recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {verifications.map((v) => (
                <div key={v.id} className="py-3 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {v.amount_display} GRAM Verified
                    </span>
                    <span className="font-mono tabular-nums text-slate-400">
                      {new Date(v.verified_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="font-mono text-[11px] text-slate-400 truncate">
                    TX: {v.tx_hash}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="glass-panel rounded-2xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-white mb-3">Withdrawal History</h3>
          {withdrawals.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center">
              No withdrawal requests submitted yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {withdrawals.map((w) => (
                <div key={w.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-mono font-semibold tabular-nums text-white">
                      {w.amount.toFixed(2)} LOVA{' '}
                      <span className="text-xs font-sans font-normal text-slate-400">
                        {w.is_demo_request ? '(Demo Queue)' : ''}
                      </span>
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      To {w.destination_address} · {new Date(w.created_at).toLocaleDateString()}
                    </p>
                    {w.payout_tx_hash && (
                      <p className="text-[11px] font-mono text-blue-300 truncate mt-0.5">
                        Payout TX: {w.payout_tx_hash}
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-xs font-semibold inline-flex items-center gap-1 shrink-0 ${
                      w.status === 'Paid'
                        ? 'text-emerald-400'
                        : w.status === 'Approved'
                          ? 'text-blue-300'
                          : w.status === 'Rejected'
                            ? 'text-rose-400'
                            : 'text-amber-300'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    {w.status}
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
