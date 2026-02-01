import { createApp } from './app.js';
import { getConfig } from './config.js';
import { createLogger, getLogDirectory } from './utils/logger.js';
import { getPlatform } from './utils/platform.js';

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

  try {
    const app = await createApp();
    const config = getConfig();

    const protocol = config.tls.enabled ? 'https' : 'http';
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info({ address, protocol }, 'Server started');

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
