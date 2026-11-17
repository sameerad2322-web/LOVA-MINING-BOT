import { Address } from '@ton/core';
import { isGramVerificationConfigured, serverConfig } from './config.ts';
import { normalizeTonAddress } from './security.ts';

export interface GramVerificationCheckInput {
  txHash: string;
  expectedSenderAddress: string;
  expectedFeeDisplay?: number;
  overrideAdminWallet?: string | null;
}

export interface GramVerificationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  txHash?: string;
  senderRaw?: string;
  recipientRaw?: string;
  jettonMasterRaw?: string;
  amountRaw?: string;
  amountDisplay?: number;
  decimals?: number;
}

function toBaseUnits(amountDisplay: number, decimals: number): bigint {
  const fixed = amountDisplay.toFixed(decimals);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function normalizeRaw(addr: string | undefined | null): string | null {
  if (!addr) return null;
  try {
    return Address.parse(addr.trim()).toRawString();
  } catch {
    return null;
  }
}

/**
 * Verifies a 0.05 GRAM Jetton transfer on TON blockchain via TON API.
 * Strictly refuses to simulate or fake verification if GRAM config is missing.
 */
export async function verifyGramJettonTransaction(
  input: GramVerificationCheckInput
): Promise<GramVerificationResult> {
  const adminWallet = (input.overrideAdminWallet || serverConfig.adminTonWalletAddress || '').trim();

  if (!isGramVerificationConfigured(adminWallet)) {
    return {
      valid: false,
      errorCode: 'GRAM_VERIFICATION_NOT_CONFIGURED',
      errorMessage:
        'GRAM Jetton master contract, decimals, or Admin TON wallet address is not configured on the server.',
    };
  }

  const masterNorm = normalizeTonAddress(serverConfig.gramJettonMasterAddress!);
  const adminNorm = normalizeTonAddress(adminWallet);
  const senderNorm = normalizeTonAddress(input.expectedSenderAddress);

  if (!masterNorm || !adminNorm || !senderNorm) {
    return {
      valid: false,
      errorCode: 'INVALID_TON_ADDRESS',
      errorMessage: 'One or more TON addresses (master, admin, or sender) could not be parsed.',
    };
  }

  const cleanHash = input.txHash.trim();
  if (!cleanHash || cleanHash.length < 16) {
    return {
      valid: false,
      errorCode: 'INVALID_TX_HASH',
      errorMessage: 'A valid TON transaction hash is required for verification.',
    };
  }

  const decimals = serverConfig.gramJettonDecimals!;
  const feeDisplay = input.expectedFeeDisplay ?? 0.05;
  const expectedAmountRaw = toBaseUnits(feeDisplay, decimals);

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (serverConfig.tonApiKey) {
    headers.Authorization = `Bearer ${serverConfig.tonApiKey}`;
  }

  try {
    // Query TonAPI events endpoint for finalized JettonTransfer actions
    const endpoint = `${serverConfig.tonApiEndpoint}/events/${encodeURIComponent(cleanHash)}`;
    const response = await fetch(endpoint, { headers });

    if (!response.ok) {
      return {
        valid: false,
        errorCode: 'TON_API_TX_NOT_FOUND',
        errorMessage: `Transaction not yet finalized or not found on TON explorer (HTTP ${response.status}).`,
      };
    }

    const event = (await response.json()) as {
      event_id?: string;
      in_progress?: boolean;
      actions?: Array<{
        type?: string;
        status?: string;
        JettonTransfer?: {
          sender?: { address?: string };
          recipient?: { address?: string };
          amount?: string;
          jetton?: { address?: string; decimals?: number };
        };
      }>;
    };

    if (event.in_progress) {
      return {
        valid: false,
        errorCode: 'TX_PENDING_FINALITY',
        errorMessage: 'Transaction is still in progress on TON. Please wait for finality and retry.',
      };
    }

    const actions = Array.isArray(event.actions) ? event.actions : [];
    const matchingTransfer = actions.find((act) => {
      if (act.type !== 'JettonTransfer' || act.status !== 'ok' || !act.JettonTransfer) {
        return false;
      }
      const jt = act.JettonTransfer;
      const jtMaster = normalizeRaw(jt.jetton?.address);
      const jtSender = normalizeRaw(jt.sender?.address);
      const jtRecipient = normalizeRaw(jt.recipient?.address);
      if (!jtMaster || !jtSender || !jtRecipient || !jt.amount) return false;

      let amountBigInt = 0n;
      try {
        amountBigInt = BigInt(jt.amount);
      } catch {
        return false;
      }

      return (
        jtMaster === masterNorm.raw &&
        jtSender === senderNorm.raw &&
        jtRecipient === adminNorm.raw &&
        amountBigInt === expectedAmountRaw
      );
    });

    if (!matchingTransfer || !matchingTransfer.JettonTransfer) {
      return {
        valid: false,
        errorCode: 'JETTON_TRANSFER_MISMATCH',
        errorMessage: `No finalized ${feeDisplay} GRAM Jetton transfer from your connected wallet to the Admin wallet was found in this transaction.`,
      };
    }

    return {
      valid: true,
      txHash: event.event_id || cleanHash,
      senderRaw: senderNorm.raw,
      recipientRaw: adminNorm.raw,
      jettonMasterRaw: masterNorm.raw,
      amountRaw: expectedAmountRaw.toString(),
      amountDisplay: feeDisplay,
      decimals,
    };
  } catch (err) {
    return {
      valid: false,
      errorCode: 'TON_VERIFICATION_NETWORK_ERROR',
      errorMessage:
        err instanceof Error
          ? `Failed to query TON API: ${err.message}`
          : 'Failed to query TON API.',
    };
  }
}

/**
 * Verifies an admin-submitted payout transaction hash exists and finalized on TON
 * before marking a withdrawal as Paid.
 */
export async function verifyTonTransactionFinalized(txHash: string): Promise<{
  ok: boolean;
  normalizedHash?: string;
  error?: string;
}> {
  const cleanHash = txHash.trim();
  if (!cleanHash || cleanHash.length < 16) {
    return { ok: false, error: 'Invalid transaction hash format.' };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (serverConfig.tonApiKey) {
    headers.Authorization = `Bearer ${serverConfig.tonApiKey}`;
  }

  try {
    const endpoint = `${serverConfig.tonApiEndpoint}/blockchain/transactions/${encodeURIComponent(cleanHash)}`;
    const res = await fetch(endpoint, { headers });
    if (!res.ok) {
      return {
        ok: false,
        error: `Transaction could not be confirmed on TON (${res.status}). Ensure the payout hash is finalized on-chain.`,
      };
    }
    const tx = (await res.json()) as { hash?: string; success?: boolean; aborted?: boolean };
    if (tx.aborted || tx.success === false) {
      return { ok: false, error: 'Transaction was aborted or failed on-chain.' };
    }
    return { ok: true, normalizedHash: tx.hash || cleanHash };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to reach TON API to verify payout transaction.',
    };
  }
}
