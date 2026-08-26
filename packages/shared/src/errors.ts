/**
 * Closed registry of error codes shared by API and both frontends.
 * The POS maps every code to human copy; no stringly-typed matching anywhere.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REQUEST_REPLAY_PAYLOAD_MISMATCH'
  | 'REQUEST_STALE'
  | 'BIOMETRIC_NO_MATCH'
  | 'BIOMETRIC_AMBIGUOUS_MATCH'
  | 'BIOMETRIC_NOT_ENROLLED'
  | 'BIOMETRIC_LOW_QUALITY'
  | 'BIOMETRIC_UNSUPPORTED_ALGO'
  | 'INSUFFICIENT_FUNDS'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_EXISTS'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'REFUND_NOT_ALLOWED'
  | 'PROVIDER_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Wire envelope: every API response is {ok:true,data} or {ok:false,error}. */
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

const HTTP_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  REQUEST_STALE: 400,
  BIOMETRIC_LOW_QUALITY: 400,
  BIOMETRIC_UNSUPPORTED_ALGO: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_REPLAY_PAYLOAD_MISMATCH: 409,
  CONFLICT: 409,
  ACCOUNT_EXISTS: 409,
  INSUFFICIENT_FUNDS: 422,
  AMOUNT_OUT_OF_RANGE: 422,
  ACCOUNT_DISABLED: 422,
  REFUND_NOT_ALLOWED: 422,
  BIOMETRIC_NO_MATCH: 422,
  BIOMETRIC_AMBIGUOUS_MATCH: 422,
  BIOMETRIC_NOT_ENROLLED: 422,
  PROVIDER_FAILED: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_BY_CODE[code];
}

/** Typed error thrown by API handlers; converted to the envelope by errorHandler. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}
