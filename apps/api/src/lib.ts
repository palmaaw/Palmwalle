/** Small shared helpers for route handlers. */

import { ApiError } from '@palma/shared';
import type { ZodTypeAny, z } from 'zod';

/** Validate a request body against a shared zod schema -> VALIDATION_ERROR. */
export function parseBody<S extends ZodTypeAny>(req: { body?: unknown }, schema: S): z.infer<S> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Invalid request body',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    );
  }
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(req: { query?: unknown }, schema: S): z.infer<S> {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Invalid query parameters',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    );
  }
  return result.data;
}

/** SQLite surfaces constraint races as plain errors; classify UNIQUE hits. */
export function isUniqueViolation(err: unknown): boolean {
  return String((err as Error)?.message ?? '').includes('UNIQUE constraint failed');
}
