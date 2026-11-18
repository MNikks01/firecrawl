import http from 'node:http';
import { loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import { buildGateway } from '../wiring.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const gw = await buildGateway(cfg, log);

const server = http.createServer(gw.app);
// Scrapes can run for minutes; don't let Node's defaults cut them off before the upstream timeout.
server.requestTimeout = cfg.UPSTREAM_TIMEOUT_MS + 30_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
server.listen(cfg.PORT, () => log.info('gateway listening', { port: cfg.PORT, upstream: new URL(cfg.UPSTREAM_URL).origin, auth: cfg.AUTH_PROVIDER }));

const metricsServer = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(gw.metrics.render());
  } else {
    res.statusCode = 404;
    res.end();
  }
});
metricsServer.listen(cfg.METRICS_PORT);

if (cfg.RECONCILER_ENABLED) gw.reconciler.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  // Stop taking requests; in-flight ones finish and settle before the pool closes.
  await new Promise<void>((r) => server.close(() => r()));
  metricsServer.close();
  await gw.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
