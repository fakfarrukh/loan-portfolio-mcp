import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContainer } from '../app.js';
import type { Principal } from '../auth/principal.js';
import { createMcpServer } from '../server.js';

/**
 * Local transport for Claude Desktop. The server runs as a child process of the desktop app, so
 * the OS user who launched it is the trust boundary; the role comes from configuration
 * (STDIO_ROLE, default `analyst` — least privilege).
 */
export async function startStdio(app: AppContainer): Promise<() => Promise<void>> {
  const principal: Principal = {
    subject: app.config.STDIO_SUBJECT,
    role: app.config.STDIO_ROLE,
    authMethod: 'stdio',
  };

  const server = createMcpServer({
    executor: app.executor,
    repo: app.repo,
    resolvePrincipal: () => principal,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  app.logger.info(
    { subject: principal.subject, role: principal.role },
    'MCP server ready on stdio',
  );

  return () => server.close();
}
