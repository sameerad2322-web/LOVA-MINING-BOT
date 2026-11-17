import type { PublicSystemStatus } from '../types/lova';

export interface ResolvedTonManifest {
  manifestUrl: string;
  configuredOverrideUrl: string | null;
  isPreviewOrigin: boolean;
  isGatedPreviewWithoutPublicManifest: boolean;
}

export function isAuthGatedPreviewHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    /^ais-(dev|pre)-/i.test(lower)
  );
}

export function resolveTonConnectManifest(
  systemStatus?: PublicSystemStatus | null
): ResolvedTonManifest {
  const envOverride = (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_TONCONNECT_MANIFEST_URL || ''
  ).trim();
  const serverOverride = (systemStatus?.tonconnectManifestUrl || '').trim();
  const configuredOverrideUrl = serverOverride || envOverride || null;

  if (typeof window === 'undefined') {
    return {
      manifestUrl: configuredOverrideUrl || '/tonconnect-manifest.json',
      configuredOverrideUrl,
      isPreviewOrigin: false,
      isGatedPreviewWithoutPublicManifest: false,
    };
  }

  const origin = window.location.origin.replace(/\/+$/, '');
  const isPreviewOrigin = isAuthGatedPreviewHostname(window.location.hostname);

  return {
    manifestUrl: configuredOverrideUrl || `${origin}/tonconnect-manifest.json`,
    configuredOverrideUrl,
    isPreviewOrigin,
    isGatedPreviewWithoutPublicManifest: isPreviewOrigin && !configuredOverrideUrl,
  };
}

export function clearStaleTonConnectStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && (k.startsWith('ton-connect-') || k.startsWith('tonconnect'))) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      window.localStorage.removeItem(k);
    }
  } catch {
    // ignore storage errors
  }
}
