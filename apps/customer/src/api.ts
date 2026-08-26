/**
 * Typed fetch wrapper for the PalmPay API. Unwraps the {ok,data|error}
 * envelope into plain data or a typed ApiError carrying the ErrorCode.
 */

import type { DepositSource } from '@palma/shared';

const BASE = '/api/v1';
const TOKEN_KEY = 'palma.token';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function req<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach PalmPay — check your connection', 0);
  }

  const envelope = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null;

  if (envelope && envelope.ok) return envelope.data;
  const err = envelope && !envelope.ok ? envelope.error : { code: 'INTERNAL', message: 'Unexpected response' };
  throw new ApiError(err.code, err.message, res.status);
}

export interface CustomerDTO {
  id: string;
  name: string;
  phone: string;
  maskedPhone?: string;
  palmEnrolled?: boolean;
  status?: string;
}

export interface WalletDTO {
  accountId: string;
  balancePiasters: number;
  currency: string;
  formatted?: string;
}

export interface TransactionDTO {
  id: string;
  ref: string;
  type: 'deposit' | 'payment' | 'refund';
  status: string;
  amountPiasters: number;
  signedAmountPiasters?: number;
  formatted?: string;
  counterparty: { displayName: string; maskedPhone: string } | null;
  parentRef: string | null;
  provider: string | null;
  failureCode?: string | null;
  createdAt: string;
  settledAt?: string | null;
}

export interface MatchInfo {
  outcome: string;
  score: number;
  threshold: number;
  algoId: string;
}

export const api = {
  register: (name: string, phone: string, pin: string) =>
    req<{ accessToken: string; customer: CustomerDTO }>('POST', '/customers/register', { name, phone, pin }),

  login: (phone: string, pin: string) =>
    req<{ accessToken: string; customer: CustomerDTO }>('POST', '/auth/customer/login', { phone, pin }),

  me: () => req<{ customer: CustomerDTO }>('GET', '/customers/me'),

  wallet: () => req<{ wallet: WalletDTO }>('GET', '/customers/me/wallet'),

  deposit: (requestId: string, timestamp: string, amountPiasters: number, source: DepositSource) =>
    req<{ status: string; transaction: TransactionDTO; wallet: WalletDTO; replayed?: boolean }>(
      'POST',
      '/customers/me/deposits',
      { requestId, timestamp, amountPiasters, source }
    ),

  transactions: (cursor?: string, limit = 20) =>
    req<{ items: TransactionDTO[]; nextCursor: string | null }>(
      'GET',
      `/customers/me/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    ),

  protectionKey: () =>
    req<{ algoId: string; version: number; bits: number; protectionKeyB64: string }>('GET', '/biometrics/protection-key'),

  enrollPalm: (
    code: { algoId: string; version: number; bits: string },
    quality: unknown,
    consistencyScore: number,
    frames: number,
    source: 'camera' | 'synthetic'
  ) =>
    req<{ enrolled: boolean; templateId: string; consistencyScore: number }>('POST', '/customers/me/palm/enroll', {
      code,
      quality,
      consistencyScore,
      capture: { source, frames }
    }),

  palmStatus: () => req<{ enrolled: boolean; templateId: string | null; algo: { id: string; simulated?: boolean } }>(
    'GET',
    '/customers/me/palm/status'
  ),

  selfTest: (probe: unknown) =>
    req<{ decision: 'match' | 'no_match'; greyZone?: boolean; score: number; threshold: number }>(
      'POST',
      '/customers/me/palm/self-test',
      { probe }
    ),

  deletePalm: (pin: string) => req<{ deleted: boolean }>('DELETE', '/customers/me/palm', { pin }),

  changePin: (currentPin: string, newPin: string) => req<{ changed: boolean }>('POST', '/customers/me/pin', { currentPin, newPin })
};
