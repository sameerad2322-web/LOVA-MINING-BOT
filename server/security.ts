import crypto from 'crypto';
import { Address } from '@ton/core';
import type { NextFunction, Request, Response } from 'express';
import { serverConfig } from './config.ts';
import type { AdminRole } from '../src/types/lova.ts';

export interface TelegramInitUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
}

export interface VerifiedTelegramData {
  user: TelegramInitUser;
  startParam: string | null;
  authDate: number;
}

/**
 * Cryptographically verifies Telegram WebApp initData per Telegram's official spec:
 * secret_key = HMAC_SHA256("WebAppData", bot_token)
 * hash = HMAC_SHA256(secret_key, data_check_string)
 */
export function verifyTelegramInitData(initDataRaw: string, botToken: string): VerifiedTelegramData | null {
  if (!initDataRaw || !botToken) return null;

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return null;

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > 86400) {
    return null;
  }

  const entries: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      entries.push(`${key}=${value}`);
    }
  });
  entries.sort();
  const dataCheckString = entries.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuf = Buffer.from(hash, 'hex');
  const computedBuf = Buffer.from(computedHash, 'hex');
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;

  try {
    const parsedUser = JSON.parse(userJson) as TelegramInitUser;
    if (!parsedUser || typeof parsedUser.id !== 'number') return null;
    return {
      user: parsedUser,
      startParam: params.get('start_param'),
      authDate,
    };
  } catch {
    return null;
  }
}

export interface SessionClaims {
  sub: string; // user UUID
  tgId: number;
  kind: 'user' | 'admin';
  adminId?: string;
  adminRole?: AdminRole;
  exp: number;
}

export function signSessionToken(claims: Omit<SessionClaims, 'exp'>, ttlSeconds = 60 * 60 * 24 * 7): string {
  const payload: SessionClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', serverConfig.sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', serverConfig.sessionSecret)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionClaims;
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function extractBearerOrCookie(req: Request, cookieName: string, headerName = 'authorization'): string | null {
  const headerVal = req.headers[headerName];
  if (typeof headerVal === 'string' && headerVal.startsWith('Bearer ')) {
    return headerVal.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(';').map((c) => c.trim());
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx > 0 && part.slice(0, idx) === cookieName) {
        return decodeURIComponent(part.slice(idx + 1));
      }
    }
  }
  return null;
}

export function normalizeTonAddress(input: string): { friendly: string; raw: string } | null {
  try {
    const addr = Address.parse(input.trim());
    return {
      friendly: addr.toString({ bounceable: false, urlSafe: true }),
      raw: addr.toRawString(),
    };
  } catch {
    return null;
  }
}

export function safeText(val: unknown, maxLen = 200): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

// In-memory sliding-window rate limiter
const rateBuckets = new Map<string, number[]>();

export function createRateLimiter(maxRequests: number, windowMs: number, keyPrefix = 'global') {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userHint = (req as Request & { session?: SessionClaims }).session?.sub || 'anon';
    const key = `${keyPrefix}:${ip}:${userHint}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    const prev = rateBuckets.get(key) || [];
    const recent = prev.filter((ts) => ts > cutoff);
    if (recent.length >= maxRequests) {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please wait a moment and try again.',
      });
      return;
    }
    recent.push(now);
    rateBuckets.set(key, recent);
    next();
  };
}
