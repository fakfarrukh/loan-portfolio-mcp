import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { AppContainer } from '../app.js';
import { createJwtVerifier, principalFromAuthInfo } from '../auth/jwt.js';
import { createMcpServer } from '../server.js';

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

/**
 * Builds the Express app for the Streamable HTTP transport.
 *
 * Stateless mode: each POST gets a fresh MCP server/transport pair bound to the caller's verified
 * identity. Nothing is shared between requests, so instances scale horizontally behind a load
 * balancer with no sticky sessions.
 */
export function createHttpApp(app: AppContainer, verifier?: OAuthTokenVerifier): Express {
  const { config, logger } = app;
  const tokenVerifier =
    verifier ??
    createJwtVerifier(
      {
        jwksUrl: config.AUTH_JWKS_URL,
        secret: config.AUTH_JWT_SECRET,
        issuer: config.AUTH_ISSUER ?? '',
        audience: config.AUTH_AUDIENCE ?? '',
        roleClaim: config.AUTH_ROLE_CLAIM,
        adminValues: config.AUTH_ADMIN_VALUES,
        analystValues: config.AUTH_ANALYST_VALUES,
        clockToleranceSec: config.AUTH_CLOCK_TOLERANCE_SEC,
      },
      logger,
    );

  const http = express();
  http.disable('x-powered-by');
  http.set('trust proxy', false);
  http.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Unauthenticated liveness probe; reveals nothing about data.
  http.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // RFC 9728 protected-resource metadata, so OAuth-aware MCP clients can discover the IdP.
  let resourceMetadataUrl: string | undefined;
  if (config.PUBLIC_URL) {
    const mcpUrl = new URL(config.PUBLIC_URL);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
    const metadata = {
      resource: mcpUrl.href,
      authorization_servers: [config.AUTH_AUTHORIZATION_SERVER ?? config.AUTH_ISSUER],
      bearer_methods_supported: ['header'],
      resource_name: 'Loan Portfolio MCP',
    };
    http.get(new URL(resourceMetadataUrl).pathname, (_req, res) => {
      res.json(metadata);
    });
  }

  const auth = requireBearerAuth({
    verifier: tokenVerifier,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  });

  http.post(
    '/mcp',
    auth,
    express.json({ limit: config.HTTP_MAX_BODY_BYTES, strict: true }),
    async (req, res, next) => {
      try {
        const principal = principalFromAuthInfo(req.auth);
        const server = createMcpServer({
          executor: app.executor,
          repo: app.repo,
          resolvePrincipal: () => principal,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        next(err);
      }
    },
  );

  // Stateless server: no SSE stream to GET and no session to DELETE.
  http.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed'));
  });

  http.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Last-resort handler: never leak stack traces or parser internals.
  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    if (status >= 500) logger.error({ err }, 'HTTP request failed');
    if (res.headersSent) return;
    const message =
      status === 413
        ? 'Request body too large'
        : status < 500
          ? 'Bad request'
          : 'Internal server error';
    res
      .status(status)
      .json(jsonRpcError(status === 413 || status < 500 ? -32600 : -32603, message));
  };
  http.use(errorHandler);

  return http;
}

export async function startHttp(app: AppContainer): Promise<() => Promise<void>> {
  const { config, logger } = app;
  const http = createHttpApp(app);
  const server = await new Promise<HttpServer>((resolve) => {
    const s = http.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
      resolve(s);
    });
  });
  server.requestTimeout = config.TOOL_TIMEOUT_MS + 5_000;
  server.headersTimeout = 10_000;
  logger.info(
    {
      host: config.HTTP_HOST,
      port: config.HTTP_PORT,
      auth: config.AUTH_JWKS_URL ? 'jwks' : 'secret',
    },
    'MCP server ready on HTTP (POST /mcp)',
  );
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
}
