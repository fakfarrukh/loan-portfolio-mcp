/**
 * Mints a short-lived HS256 development token for the HTTP transport.
 * NOT for production — in production tokens come from your identity provider (e.g. Okta).
 *
 *   npm run token -- analyst
 *   npm run token -- admin --sub=bob@example.com --ttl=3600
 */
import { SignJWT } from 'jose';
import { loadConfig, loadDotEnv } from '../src/config.js';

loadDotEnv();
const args = process.argv.slice(2);
const role = args.find((a) => !a.startsWith('--')) ?? 'analyst';
const opt = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const config = loadConfig({ ...process.env, MCP_TRANSPORT: 'http' });
if (!config.AUTH_JWT_SECRET) {
  console.error('AUTH_JWT_SECRET is not set (dev tokens require shared-secret mode).');
  process.exit(1);
}
const claimValue =
  role === 'admin'
    ? config.AUTH_ADMIN_VALUES[0]
    : role === 'analyst'
      ? config.AUTH_ANALYST_VALUES[0]
      : role;

const token = await new SignJWT({ [config.AUTH_ROLE_CLAIM]: [claimValue] })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(opt('sub') ?? `${role}@example.com`)
  .setIssuer(config.AUTH_ISSUER ?? '')
  .setAudience(config.AUTH_AUDIENCE ?? '')
  .setIssuedAt()
  .setExpirationTime(`${opt('ttl') ?? '3600'}s`)
  .sign(new TextEncoder().encode(config.AUTH_JWT_SECRET));

console.log(token);
