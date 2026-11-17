const SESSION_STORAGE_KEY = 'lova_session_token';
const ADMIN_STORAGE_KEY = 'lova_admin_token';

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    start_param?: string;
  };
  ready: () => void;
  expand: () => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
}

export function getTelegramWebApp(): TelegramWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } };
  return w.Telegram?.WebApp || null;
}

export function getStoredSessionToken(): string | null {
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
}

export function setStoredSessionToken(token: string | null) {
  if (token) sessionStorage.setItem(SESSION_STORAGE_KEY, token);
  else sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

export function getStoredAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_STORAGE_KEY);
}

export function setStoredAdminToken(token: string | null) {
  if (token) sessionStorage.setItem(ADMIN_STORAGE_KEY, token);
  else sessionStorage.removeItem(ADMIN_STORAGE_KEY);
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  useAdminAuth = false
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const userToken = getStoredSessionToken();
  if (userToken) {
    headers.set('Authorization', `Bearer ${userToken}`);
  }
  if (useAdminAuth) {
    const adminToken = getStoredAdminToken();
    if (adminToken) {
      headers.set('x-admin-authorization', `Bearer ${adminToken}`);
    }
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}
