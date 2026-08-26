/**
 * Bearer-token auth prehandlers. Tokens carry identity claims only; account
 * state is re-checked from the database where it matters.
 */

import { ApiError } from '@palma/shared';
import type { PalmaDatabase, CustomerRow, MerchantRow } from '@palma/db';
import { CustomerRepo, MerchantRepo } from '@palma/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService } from '../security/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    customer?: CustomerRow;
    merchant?: MerchantRow;
  }
}

export interface AuthHooks {
  requireCustomer: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireMerchant: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Either kind of active session — used by endpoints that serve both apps. */
  requireAnySession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

interface DbServer {
  palmaDb: PalmaDatabase;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export function authHooks(tokens: TokenService): AuthHooks {
  const requireCustomer = async (req: FastifyRequest): Promise<void> => {
    const token = bearerToken(req);
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in required');
    let claims;
    try {
      claims = await tokens.verify(token);
    } catch {
      throw new ApiError('AUTH_REQUIRED', 'Session expired or invalid — sign in again');
    }
    if (claims.typ !== 'customer') throw new ApiError('FORBIDDEN', 'Customer session required');
    const customers = new CustomerRepo((req.server as DbServer).palmaDb);
    const row = customers.getById(claims.sub);
    if (!row) throw new ApiError('AUTH_REQUIRED', 'Account no longer exists');
    if (row.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    req.customer = row;
  };

  const requireMerchant = async (req: FastifyRequest): Promise<void> => {
    const token = bearerToken(req);
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Merchant sign-in required');
    let claims;
    try {
      claims = await tokens.verify(token);
    } catch {
      throw new ApiError('AUTH_REQUIRED', 'Session expired or invalid — sign in again');
    }
    if (claims.typ !== 'merchant') throw new ApiError('FORBIDDEN', 'Merchant session required');
    const merchants = new MerchantRepo((req.server as DbServer).palmaDb);
    const row = merchants.getById(claims.sub);
    if (!row) throw new ApiError('AUTH_REQUIRED', 'Merchant account no longer exists');
    if (row.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This merchant account is disabled');
    req.merchant = row;
  };

  const requireAnySession = async (req: FastifyRequest): Promise<void> => {
    const token = bearerToken(req);
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in required');
    let claims;
    try {
      claims = await tokens.verify(token);
    } catch {
      throw new ApiError('AUTH_REQUIRED', 'Session expired or invalid — sign in again');
    }
    if (claims.typ === 'customer') return requireCustomer(req);
    if (claims.typ === 'merchant') return requireMerchant(req);
    throw new ApiError('FORBIDDEN', 'Unrecognized session type');
  };

  return { requireCustomer, requireMerchant, requireAnySession };
}
