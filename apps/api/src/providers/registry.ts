import { ApiError } from '@palmwallet/shared';
import type { DepositSource } from '@palmwallet/shared';
import type { PaymentProviderAdapter } from './types.js';

/**
 * Failure sentinel for the SIMULATED adapters: a nil-prefixed UUID
 * (00000000-…) still satisfies the wire's uuid requestId schema but always
 * simulates a provider outage. Real integrations replace these adapters.
 */
export const SIM_FAILURE_PREFIX = '00000000';

/**
 * Deterministic SIMULATED top-up: succeeds unless requestId carries the nil
 * sentinel. providerRef derives from the requestId so replays are visible in
 * records.
 */
function makeSim(id: PaymentProviderAdapter['id'], prefix: string): PaymentProviderAdapter {
  return {
    id,
    async initiateTopUp(req) {
      if (req.requestId.startsWith(SIM_FAILURE_PREFIX)) {
        return { ok: false, code: 'PROVIDER_FAILED', message: `${id}: simulated provider outage` };
      }
      return { ok: true, providerRef: `${prefix}-${req.requestId.replace(/-/g, '').slice(0, 16).toUpperCase()}` };
    }
  };
}

const ADAPTERS: Record<DepositSource, PaymentProviderAdapter> = {
  instapay_sim: makeSim('instapay_sim', 'IPS'),
  vodafone_cash_sim: makeSim('vodafone_cash_sim', 'VFC')
};

export class ProviderRegistry {
  get(source: DepositSource): PaymentProviderAdapter {
    const a = ADAPTERS[source];
    if (!a) throw new ApiError('VALIDATION_ERROR', `Unknown deposit source ${source}`);
    return a;
  }
}
