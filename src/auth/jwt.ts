import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InsufficientScopeError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { Logger } from '../logger.js';
import { isRole, type Principal, type Role } from './principal.js';

export interface JwtAuthConfig {
  jwksUrl?: string | undefined;
  secret?: string | undefined;
  issuer: string;
  audience: string;
  roleClaim: string;
  adminValues: readonly string[];
  analystValues: readonly string[];
  clockToleranceSec: number;
}

/** Tokens larger than this are rejected before any parsing (cheap DoS guard). */
export const MAX_TOKEN_BYTES = 8_192;

/**
 * Algorithm allow-lists are tied to the key type. This blocks algorithm-confusion attacks
 * (e.g. an attacker signing HS256 with a public RSA key) and `alg: none`.
 */
const ASYMMETRIC_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'];
const SYMMETRIC_ALGS = ['HS256', 'HS384', 'HS512'];

/** Reads a claim by exact name first (Okta/Auth0 namespaced URLs contain dots), then by dotted path. */
function readClaim(payload: JWTPayload, claim: string): unknown {
  if (claim in payload) return payload[claim];
  return claim
    .split('.')
    .reduce<unknown>(
      (obj, key) =>
        obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined,
      payload,
    );
}

/**
 * Maps IdP group/role claim values to an application role. Admin wins if both match.
 * Returns undefined when the token carries no recognised role (→ 403).
 */
export function mapRole(
  claimValue: unknown,
  adminValues: readonly string[],
  analystValues: readonly string[],
): Role | undefined {
  const values =
    typeof claimValue === 'string'
      ? claimValue.split(/[\s,]+/)
      : Array.isArray(claimValue)
        ? claimValue.filter((v): v is string => typeof v === 'string')
        : [];
  if (values.some((v) => adminValues.includes(v))) return 'admin';
  if (values.some((v) => analystValues.includes(v))) return 'analyst';
  return undefined;
}

function scopesOf(payload: JWTPayload): string[] {
  const scp = payload.scp ?? payload.scope;
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === 'string');
  if (typeof scp === 'string') return scp.split(' ').filter(Boolean);
  return [];
}

/**
 * Verifies bearer JWTs with `jose` and converts them into a Principal.
 *
 * Production (OAuth2/OIDC, e.g. Okta): set AUTH_JWKS_URL to the authorization server's
 * `/v1/keys` endpoint; keys are fetched and cached, and rotated automatically by `kid`.
 * Development: set AUTH_JWT_SECRET (HS256) and mint tokens with `npm run token`.
 */
export function createJwtVerifier(cfg: JwtAuthConfig, logger: Logger): OAuthTokenVerifier {
  let key: JWTVerifyGetKey | Uint8Array;
  let algorithms: string[];
  if (cfg.jwksUrl) {
    key = createRemoteJWKSet(new URL(cfg.jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    algorithms = ASYMMETRIC_ALGS;
  } else if (cfg.secret) {
    key = new TextEncoder().encode(cfg.secret);
    algorithms = SYMMETRIC_ALGS;
  } else {
    throw new Error('JWT verifier requires a JWKS URL or a shared secret');
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
        throw new InvalidTokenError('Token too large');
      }

      let payload: JWTPayload;
      try {
        const verifyOptions = {
          issuer: cfg.issuer,
          audience: cfg.audience,
          algorithms,
          clockTolerance: cfg.clockToleranceSec,
          requiredClaims: ['sub', 'exp'],
        };
        ({ payload } =
          key instanceof Uint8Array
            ? await jwtVerify(token, key, verifyOptions)
            : await jwtVerify(token, key, verifyOptions));
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('Token has expired');
        if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JOSENotSupported) {
          logger.error({ err }, 'JWKS unavailable or unsupported key');
          throw new ServerError('Unable to verify token');
        }
        // Deliberately vague: don't tell an attacker which check failed.
        logger.warn({ reason: (err as Error).name }, 'Rejected bearer token');
        throw new InvalidTokenError('Invalid token');
      }

      const role = mapRole(readClaim(payload, cfg.roleClaim), cfg.adminValues, cfg.analystValues);
      if (!role || !isRole(role)) {
        logger.warn({ sub: payload.sub }, 'Token has no recognised role');
        throw new InsufficientScopeError('Token does not grant access to this server');
      }

      const principal: Principal = { subject: payload.sub ?? 'unknown', role, authMethod: 'jwt' };
      const clientId = [payload.cid, payload.azp, payload.client_id].find(
        (v): v is string => typeof v === 'string',
      );
      return {
        token,
        clientId: clientId ?? 'unknown',
        scopes: scopesOf(payload),
        ...(payload.exp === undefined ? {} : { expiresAt: payload.exp }),
        extra: { principal },
      };
    },
  };
}

/** Extracts the Principal placed on AuthInfo by the verifier. */
export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | undefined {
  const p = authInfo?.extra?.principal as Partial<Principal> | undefined;
  if (!p || typeof p.subject !== 'string' || !isRole(p.role) || p.authMethod !== 'jwt') {
    return undefined;
  }
  return { subject: p.subject, role: p.role, authMethod: 'jwt' };
}
