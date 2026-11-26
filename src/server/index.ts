import { createApp } from './app.js';
import { getConfig } from './config.js';
import { createLogger, getLogDirectory } from './utils/logger.js';
import { getPlatform } from './utils/platform.js';
import { scrubProcessEnv } from './utils/claude-env.js';
import { installSkillsAtBoot } from './utils/skill-install.js';
import { resumeMergeQueues } from './factory/merge-queue.js';
import { startFactoryAtBoot } from './factory/factory-boot.js';

const logger = createLogger('server');

// Handle uncaught exceptions - log and exit
process.on('uncaughtException', (error: Error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception - shutting down');
  // Give logger time to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

// Handle unhandled promise rejections - log and exit
process.on('unhandledRejection', (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal({ error: error.message, stack: error.stack }, 'Unhandled promise rejection - shutting down');
  // Give logger time to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

async function main() {
  logger.info({ platform: getPlatform(), logDir: getLogDirectory() }, 'Starting Claude Remote Terminal Server');

  // Done before anything can spawn a child: the server may have been started from
  // inside a claude-remote terminal (that is what restart-server.ps1 does), in which
  // case it inherited that conversation's session markers and would pass them to
  // every PTY and every headless `claude` run. See utils/claude-env.ts.
  const inherited = scrubProcessEnv();
  if (inherited.length > 0) {
    logger.info(
      { inherited },
      'Started from inside a Claude Code session; dropped its env markers so terminals save their own transcripts'
    );
  }

  try {
    const app = await createApp();
    const config = getConfig();

    const protocol = config.tls.enabled ? 'https' : 'http';
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info({ address, protocol }, 'Server started');
    void installSkillsAtBoot();
    // Merges and Lands the last server left queued (a Land answered "queued" must happen).
    // Caught: an unhandled rejection here would shut the server down.
    // Then the factory: its sink hands passed units to that queue, and dispatch starts.
    resumeMergeQueues()
      .catch((error: Error) => logger.error({ error: error.message }, 'merge queue: resume failed'))
      .finally(() => {
        try {
          startFactoryAtBoot();
        } catch (error) {
          logger.error({ error: (error as Error).message }, 'factory: start failed');
        }
      });

    // Print helpful startup message
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Claude Remote Terminal Server                    ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: ${address.padEnd(37)}║
║  Protocol: ${protocol.toUpperCase().padEnd(46)}║
║  Platform: ${getPlatform().padEnd(46)}║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    • Web UI:     ${address}/
║    • WebSocket:  ${address.replace('http', 'ws')}/ws
║    • Health:     ${address}/health
║    • API:        ${address}/api/sessions
╚════════════════════════════════════════════════════════════╝
`);
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
