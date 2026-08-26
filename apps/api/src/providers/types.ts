/**
 * ⚠️ SIMULATED payment-provider adapters. These stand in for licensed Egyptian
 * rails (InstaPay, Vodafone Cash). NO real financial transfer happens anywhere:
 * the "provider" is a deterministic function that succeeds unless the requestId
 * ends with '-fail' (a demo/test hook). The adapter interface is the seam where
 * real provider SDKs plug in later.
 */

export interface TopUpRequest {
  requestId: string;
  amountPiasters: number;
  currency: 'EGP';
  /** Reference of the receiving wallet (customer id) for the provider ledger. */
  customerRef: string;
}

export type TopUpResult =
  | { ok: true; providerRef: string }
  | { ok: false; code: 'PROVIDER_FAILED'; message: string };

export interface PaymentProviderAdapter {
  readonly id: 'instapay_sim' | 'vodafone_cash_sim';
  initiateTopUp(req: TopUpRequest): Promise<TopUpResult>;
}
