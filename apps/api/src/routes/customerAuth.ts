import { ApiError } from '@palma/shared';
import { CustomerLoginSchema, RegisterCustomerSchema, ChangePinSchema, DeletePalmSchema } from '@palma/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../container.js';
import { customerDTO } from '../dto.js';
import { isUniqueViolation, parseBody } from '../lib.js';
import { hashPin, verifyPin } from '../security/passwordHash.js';

export function customerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/customers/register', async (req) => {
    const body = parseBody(req, RegisterCustomerSchema);
    if (ctx.repos.customers.getByPhone(body.phone)) {
      throw new ApiError('ACCOUNT_EXISTS', 'A customer with this phone already exists');
    }
    const id = crypto.randomUUID();
    try {
      ctx.repos.customers.insert({ id, phone: body.phone, name: body.name, pinHash: await hashPin(body.pin) });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('ACCOUNT_EXISTS', 'A customer with this phone already exists');
      throw err;
    }
    ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: id });
    ctx.repos.audit.append({
      actorType: 'customer',
      actorId: id,
      event: 'customer.registered',
      subjectType: 'customer',
      subjectId: id
    });
    const row = ctx.repos.customers.getById(id)!;
    const token = await ctx.tokens.sign({ sub: id, typ: 'customer', name: row.name });
    return {
      ok: true as const,
      data: {
        accessToken: token,
        tokenType: 'Bearer' as const,
        expiresInSeconds: ctx.config.jwtTtlSeconds,
        customer: customerDTO(row, false)
      }
    };
  });

  app.post('/api/v1/auth/customer/login', async (req) => {
    const body = parseBody(req, CustomerLoginSchema);
    const throttleKey = `cust:${body.phone}:${req.ip}`;
    if (!ctx.throttle.allow(throttleKey)) {
      throw new ApiError('RATE_LIMITED', `Too many attempts — retry in ${ctx.throttle.retryAfterSeconds(throttleKey)}s`);
    }
    const row = ctx.repos.customers.getByPhone(body.phone);
    const okPin = row ? await verifyPin(body.pin, row.pinHash) : false;
    if (!row || !okPin) {
      ctx.throttle.recordFailure(throttleKey);
      ctx.repos.audit.append({ actorType: 'customer', actorId: body.phone, event: 'auth.login', outcome: 'rejected' });
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'Wrong phone or PIN');
    }
    if (row.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    ctx.throttle.clear(throttleKey);
    const enrolled = await palmEnrolled(ctx, row.id);
    const token = await ctx.tokens.sign({ sub: row.id, typ: 'customer', name: row.name });
    return {
      ok: true as const,
      data: {
        accessToken: token,
        tokenType: 'Bearer' as const,
        expiresInSeconds: ctx.config.jwtTtlSeconds,
        customer: customerDTO(row, enrolled)
      }
    };
  });

  app.get('/api/v1/customers/me', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const me = req.customer!;
    const enrolled = await palmEnrolled(ctx, me.id);
    return { ok: true as const, data: { customer: customerDTO(me, enrolled) } };
  });

  app.post('/api/v1/customers/me/pin', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const body = parseBody(req, ChangePinSchema);
    const me = req.customer!;
    if (!(await verifyPin(body.currentPin, me.pinHash))) {
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'Current PIN is wrong');
    }
    ctx.repos.customers.updatePinHash(me.id, await hashPin(body.newPin));
    ctx.repos.audit.append({
      actorType: 'customer',
      actorId: me.id,
      event: 'customer.pin_changed',
      subjectType: 'customer',
      subjectId: me.id
    });
    return { ok: true as const, data: { changed: true } };
  });
}

export async function palmEnrolled(ctx: AppContext, customerId: string): Promise<boolean> {
  const rows = await ctx.templates.getBySubject('customer', customerId);
  return rows.length > 0;
}

// Re-exported for the palm routes module (PIN confirmation on delete).
export { DeletePalmSchema };
