import {
  InsufficientScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createJwtVerifier,
  mapRole,
  MAX_TOKEN_BYTES,
  principalFromAuthInfo,
  type JwtAuthConfig,
} from '../../src/auth/jwt.js';
import { silentLogger } from '../tools/harness.js';
import { AUDIENCE, hsToken, ISSUER, TEST_SECRET } from './tokens.js';

const base: JwtAuthConfig = {
  secret: TEST_SECRET,
  issuer: ISSUER,
  audience: AUDIENCE,
  roleClaim: 'groups',
  adminValues: ['Portfolio-Admins'],
  analystValues: ['Portfolio-Analysts'],
  clockToleranceSec: 0,
};

describe('mapRole', () => {
  it('maps arrays, strings and prefers admin', () => {
    expect(mapRole(['Portfolio-Analysts'], ['Portfolio-Admins'], ['Portfolio-Analysts'])).toBe(
      'analyst',
    );
    expect(
      mapRole(
        ['Portfolio-Analysts', 'Portfolio-Admins'],
        ['Portfolio-Admins'],
        ['Portfolio-Analysts'],
      ),
    ).toBe('admin');
    expect(mapRole('analyst admin', ['admin'], ['analyst'])).toBe('admin');
    expect(mapRole(['Everyone'], ['admin'], ['analyst'])).toBeUndefined();
    expect(mapRole(42, ['admin'], ['analyst'])).toBeUndefined();
  });
});

describe('JWT verifier (shared secret / HS256)', () => {
  const verifier = createJwtVerifier(base, silentLogger);

  it('accepts a valid analyst token and builds a principal', async () => {
    const info = await verifier.verifyAccessToken(await hsToken());
    expect(principalFromAuthInfo(info)).toEqual({
      subject: 'alice@example.com',
      role: 'analyst',
      authMethod: 'jwt',
    });
    expect(info.expiresAt).toBeTypeOf('number');
  });

  it('maps admin groups to the admin role', async () => {
    const info = await verifier.verifyAccessToken(
      await hsToken({ groups: ['Portfolio-Admins'] }, { sub: 'bob' }),
    );
    expect(principalFromAuthInfo(info)?.role).toBe('admin');
  });

  it('reads scopes from Okta-style scp arrays', async () => {
    const info = await verifier.verifyAccessToken(
      await hsToken({ groups: ['Portfolio-Analysts'], scp: ['portfolio.read'], cid: 'claude' }),
    );
    expect(info.scopes).toEqual(['portfolio.read']);
    expect(info.clientId).toBe('claude');
  });

  const rejects = async (token: string | Promise<string>, type: unknown, msg?: RegExp) => {
    const p = verifier.verifyAccessToken(await token);
    await expect(p).rejects.toBeInstanceOf(type);
    if (msg) await expect(p).rejects.toThrow(msg);
  };

  it('rejects expired tokens', async () => {
    await rejects(
      hsToken(undefined, { exp: Math.floor(Date.now() / 1000) - 60 }),
      InvalidTokenError,
      /expired/,
    );
  });

  it('rejects the wrong audience, issuer or signing key', async () => {
    await rejects(hsToken(undefined, { aud: 'api://other' }), InvalidTokenError, /Invalid token/);
    await rejects(hsToken(undefined, { iss: 'https://evil.example.com' }), InvalidTokenError);
    await rejects(
      hsToken(undefined, { secret: 'another-secret-that-is-also-32-characters!!' }),
      InvalidTokenError,
    );
  });

  it('rejects tokens without a subject', async () => {
    await rejects(hsToken(undefined, { sub: '' }), InvalidTokenError);
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: 'mallory',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        groups: ['Portfolio-Admins'],
      }),
    ).toString('base64url');
    await rejects(`${header}.${body}.`, InvalidTokenError);
  });

  it('rejects garbage and oversized tokens', async () => {
    await rejects('not-a-jwt', InvalidTokenError);
    await rejects('x'.repeat(MAX_TOKEN_BYTES + 1), InvalidTokenError, /too large/);
  });

  it('returns 403-class error when the token has no recognised role', async () => {
    await rejects(hsToken({ groups: ['Everyone'] }), InsufficientScopeError);
    await rejects(hsToken({}), InsufficientScopeError);
  });

  it('principalFromAuthInfo ignores forged or malformed extras', () => {
    expect(principalFromAuthInfo(undefined)).toBeUndefined();
    expect(
      principalFromAuthInfo({
        token: 't',
        clientId: 'c',
        scopes: [],
        extra: { principal: { subject: 'x', role: 'root', authMethod: 'jwt' } },
      }),
    ).toBeUndefined();
  });
});

describe('JWT verifier (JWKS / RS256)', () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    jwksServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/v1/keys`;
  });
  afterAll(
    () =>
      new Promise<void>((r) =>
        jwksServer.close(() => {
          r();
        }),
      ),
  );

  const rsToken = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('okta-user-123')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);

  it('verifies tokens against the remote key set', async () => {
    const verifier = createJwtVerifier({ ...base, secret: undefined, jwksUrl }, silentLogger);
    const info = await verifier.verifyAccessToken(await rsToken({ groups: ['Portfolio-Admins'] }));
    expect(principalFromAuthInfo(info)).toMatchObject({ subject: 'okta-user-123', role: 'admin' });
  });

  it('blocks algorithm confusion: an HS256 token is refused in JWKS mode', async () => {
    const verifier = createJwtVerifier({ ...base, secret: undefined, jwksUrl }, silentLogger);
    await expect(verifier.verifyAccessToken(await hsToken())).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('supports namespaced and nested role claims', async () => {
    const verifier = createJwtVerifier(
      { ...base, secret: undefined, jwksUrl, roleClaim: 'realm_access.roles' },
      silentLogger,
    );
    const info = await verifier.verifyAccessToken(
      await rsToken({ realm_access: { roles: ['Portfolio-Analysts'] } }),
    );
    expect(principalFromAuthInfo(info)?.role).toBe('analyst');
  });
});
