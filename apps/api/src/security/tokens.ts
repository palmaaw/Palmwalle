/**
 * JWT (HS256 via jose) session tokens. Payload carries only identity claims —
 * no PINs, no biometric material. TTL defaults to 12h which is FINE FOR A
 * PROTOTYPE ONLY; production needs refresh-token rotation (see docs).
 */

import { SignJWT, jwtVerify } from 'jose';

export type ActorType = 'customer' | 'merchant';

export interface SessionClaims {
  sub: string;
  typ: ActorType;
  name: string;
}

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(jwtSecretB64: string, private readonly ttlSeconds: number) {
    const bytes = Buffer.from(jwtSecretB64, 'base64');
    if (bytes.length < 32) throw new Error('JWT_SECRET must decode to at least 32 bytes');
    this.secret = new Uint8Array(bytes);
  }

  async sign(claims: SessionClaims): Promise<string> {
    return new SignJWT({ typ: claims.typ, name: claims.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('palmpay-prototype')
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.secret);
  }

  async verify(token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, this.secret, { issuer: 'palmpay-prototype' });
    const typ = payload['typ'];
    if (typ !== 'customer' && typ !== 'merchant') throw new Error('bad token type');
    return {
      sub: String(payload.sub ?? ''),
      typ,
      name: String(payload['name'] ?? '')
    };
  }
}
