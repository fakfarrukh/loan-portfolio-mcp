#!/usr/bin/env node
import { createApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { createLogger } from './logger.js';
import { startHttp } from './transport/http.js';
import { startStdio } from './transport/stdio.js';

async function main(): Promise<void> {
  // CLI flag overrides env for convenience: `node dist/index.js --transport=http`
  const flag = process.argv.find((a) => a.startsWith('--transport='));
  if (flag) process.env.MCP_TRANSPORT = flag.split('=')[1];

  loadDotEnv();
  const config = loadConfig();
  const app = createApp(config);
  const stop = config.MCP_TRANSPORT === 'http' ? await startHttp(app) : await startStdio(app);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info({ signal }, 'Shutting down');
    try {
      await stop();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // stdio: the client closing our stdin means the session is over.
  if (config.MCP_TRANSPORT === 'stdio')
    process.stdin.on('close', () => void shutdown('stdin-close'));
}

main().catch((err: unknown) => {
  const logger = createLogger('error');
  if (err instanceof ConfigError) {
    logger.fatal(err.message);
  } else {
    logger.fatal({ err }, 'Fatal startup error');
  }
  // Give pino a moment to flush to stderr before exiting.
  setTimeout(() => process.exit(1), 100);
});
