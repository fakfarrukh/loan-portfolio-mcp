import { SignJWT } from 'jose';

export const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long';
export const ISSUER = 'https://idp.example.com/oauth2/default';
export const AUDIENCE = 'api://loan-portfolio-mcp';

/** Signs an HS256 test token. Pass `sub: ''` to omit the subject claim. */
export async function hsToken(
  claims: Record<string, unknown> = { groups: ['Portfolio-Analysts'] },
  opts: { sub?: string; iss?: string; aud?: string; exp?: string | number; secret?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m');
  if (opts.sub !== '') jwt.setSubject(opts.sub ?? 'alice@example.com');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? TEST_SECRET));
}
