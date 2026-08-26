/**
 * PaymentService — the one-step scan & pay orchestration.
 *
 * Sequence (throttle -> freshness -> idempotency -> biometric 1:N -> wallet
 * state -> double-entry settlement) with a deliberate split: the ASYNC
 * biometric match happens BEFORE the synchronous SQLite transaction, so no
 * await ever sits inside BEGIN IMMEDIATE (see PalmWalletDatabase.withTransaction).
 *
 * SECURITY NOTES:
 *  - The probe arrives as an ALREADY-PROTECTED 1024-bit code (device-side
 *    templating). The server never sees or derives descriptors.
 *  - Responses carry a coarse similarity BAND, never the precise score: match
 *    scores are a probing oracle, and merchant-facing clients don't need more
 *    than the decision. Exact scores live in internal records/audit only.
 *  - Probes are rate-limited per merchant (score-oracle / forgery-refinement
 *    mitigation) before any matching work happens.
 *
 * Biometric rejections (no_match / ambiguous / grey zone) are NOT errors: they
 * return 200 {status:'rejected'} so the POS shows "try another palm".
 * Non-biometric failures (funds, disabled accounts, validation, staleness)
 * are 4xx error envelopes.
 *
 * ⚠️ SIMULATED matching (docs/BIOMETRICS.md): decisions come from the synthetic
 * HOG pipeline behind a swappable interface.
 */

import { ApiError, formatEGP, isFresh } from '@palmwallet/shared';
import type { AuthorizePaymentDTO } from '@palmwallet/shared';
import type { CustomerRow, MerchantRow } from '@palmwallet/db';
import { CustomerRepo } from '@palmwallet/db';
import type { BestMatchResult, BiometricService } from '@palmwallet/biometrics';
import { decodeCode } from '@palmwallet/biometrics';
import { maskPhone } from '../dto.js';
import type { ProbeThrottle } from '../security/throttle.js';
import type { LedgerService } from './ledgerService.js';
import type { IdempotencyService } from './idempotency.js';

export interface MatchWireInfo {
  outcome: string;
  /** Coarse band instead of a precise score: 'high' | 'grey' | 'low'. */
  similarityBand: 'high' | 'grey' | 'low';
  threshold: number;
  algoId: string;
}

export interface AuthorizeOutcome {
  status: 'completed' | 'rejected';
  httpStatus: number;
  body: Record<string, unknown>;
}

function bandOf(m: BestMatchResult): MatchWireInfo['similarityBand'] {
  if (m.decision === 'match') return 'high';
  return m.greyZone ? 'grey' : 'low';
}

function matchInfoOf(m: BestMatchResult): MatchWireInfo {
  return {
    outcome: m.decision,
    similarityBand: bandOf(m),
    threshold: m.threshold,
    algoId: 'palmwallet-sim-hog-v1'
  };
}

export class PaymentService {
  constructor(
    private readonly deps: {
      ledger: LedgerService;
      idempotency: IdempotencyService;
      biometrics: BiometricService;
      customers: CustomerRepo;
      probeThrottle: ProbeThrottle;
      freshnessWindowMs: number;
      nowMs?: () => number;
    }
  ) {}

  async authorize(merchant: MerchantRow, req: AuthorizePaymentDTO): Promise<AuthorizeOutcome> {
    // 0. Probe budget FIRST: rejected/throttled callers learn nothing about
    // matches and burn no biometric work. Throttled requests are NOT idempotent
    // replays — they never enter the idempotency store.
    if (!this.deps.probeThrottle.take(merchant.id)) {
      throw new ApiError(
        'RATE_LIMITED',
        `Too many palm scans from this terminal — retry in ${this.deps.probeThrottle.retryAfterSeconds(merchant.id)}s`
      );
    }

    // 1. Freshness BEFORE anything else — stale requests never touch money paths.
    if (!isFresh(req.timestamp, (this.deps.nowMs ?? Date.now)(), this.deps.freshnessWindowMs)) {
      throw new ApiError('REQUEST_STALE', 'Request timestamp is outside the allowed freshness window');
    }

    const probeCode = this.toCode(req);

    // The payload hash binds THIS amount + THIS probe to THIS requestId: a replayed
    // key with different content is rejected rather than silently executed.
    const result = await this.deps.idempotency.run(
      'payments.authorize',
      req.requestId,
      {
        merchantCode: merchant.code,
        amountPiasters: req.amountPiasters,
        codePrefix: req.probe.code.bits.slice(0, 48),
        qualityScore: req.probe.quality.score
      },
      () => this.matchAndSettle(merchant, req, probeCode)
    );

    return {
      status: result.data.status,
      httpStatus: result.data.httpStatus,
      // A true replay carries the original outcome verbatim + replayed flag.
      body: result.replayed ? { ...result.data.body, replayed: true } : result.data.body
    };
  }

  private toCode(req: AuthorizePaymentDTO): Uint8Array {
    try {
      return decodeCode(req.probe.code);
    } catch (err) {
      throw new ApiError('BIOMETRIC_UNSUPPORTED_ALGO', `Unsupported palm code: ${(err as Error).message}`);
    }
  }

  private async matchAndSettle(
    merchant: MerchantRow,
    req: AuthorizePaymentDTO,
    probeCode: Uint8Array
  ): Promise<{ data: AuthorizeOutcome; httpStatus: number }> {
    // 2. Biometric identification (1:N over all active customer templates).
    let match: BestMatchResult;
    try {
      match = await this.deps.biometrics.identifyPalm(probeCode);
    } catch (err) {
      if ((err as Error).name === 'IntegrityError') {
        throw new ApiError('BIOMETRIC_UNSUPPORTED_ALGO', 'Stored template failed integrity verification');
      }
      throw err;
    }

    if (match.decision !== 'match' || !match.subjectId) {
      const code = match.decision === 'ambiguous' ? 'BIOMETRIC_AMBIGUOUS_MATCH' : 'BIOMETRIC_NO_MATCH';
      const message =
        match.decision === 'ambiguous'
          ? 'Palm is ambiguous between two enrolled customers — ask for another scan'
          : match.greyZone
            ? 'No confident palm match (low similarity)'
            : 'No enrolled customer matches this palm';
      return {
        data: {
          status: 'rejected',
          httpStatus: 200,
          body: { status: 'rejected', code, message, match: matchInfoOf(match) }
        },
        httpStatus: 200
      };
    }

    // 3. Customer + wallet state.
    const customer = this.deps.customers.getById(match.subjectId);
    if (!customer) throw new ApiError('NOT_FOUND', 'Matched account no longer exists');
    if (customer.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'Customer account is disabled');
    const customerAccount = this.deps.ledger.accounts().getByOwner('customer', customer.id);
    if (!customerAccount || customerAccount.status !== 'active') {
      throw new ApiError('ACCOUNT_DISABLED', 'Customer wallet is not available');
    }
    const merchantAccount = this.deps.ledger.accounts().getByOwner('merchant', merchant.id);
    if (!merchantAccount || merchantAccount.status !== 'active') {
      throw new ApiError('ACCOUNT_DISABLED', 'Merchant wallet is not available');
    }

    // 4. Settlement — ONE synchronous double-entry transaction. The precise
    // match score is recorded internally for audit/dispute; it is not returned
    // to the POS (responses carry only the coarse band via matchInfoOf).
    const txn = this.deps.ledger.pay({
      amountPiasters: req.amountPiasters,
      customer,
      customerAccount,
      merchant,
      merchantAccount,
      requestId: req.requestId,
      matchScore: Math.round(match.similarity * 10000) / 10000
    });

    const walletAfter = this.deps.ledger.accounts().getById(customerAccount.id)!;

    return {
      data: {
        status: 'completed',
        httpStatus: 200,
        body: {
          status: 'completed',
          transaction: {
            ref: txn.humanRef,
            type: txn.type,
            status: txn.status,
            amountPiasters: txn.amountPiasters,
            createdAt: txn.createdAt,
            settledAt: txn.settledAt
          },
          customer: { displayName: customer.name, maskedPhone: maskPhone(customer.phone) },
          match: matchInfoOf(match),
          wallet: {
            accountId: walletAfter.id,
            balancePiasters: walletAfter.balancePiasters,
            currency: walletAfter.currency,
            formatted: formatEGP(walletAfter.balancePiasters)
          }
        }
      },
      httpStatus: 200
    };
  }
}
