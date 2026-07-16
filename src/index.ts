import { createApp } from './app';
import { configured, env } from './config/env';
import { closeDb } from './db/client';

const app = createApp();

const server = app.listen(env.port, '0.0.0.0', () => {
  console.log(`Eko Telehealth API listening on :${env.port} (${env.nodeEnv})`);
  const live = Object.entries({
    database: configured.db(),
    stream: configured.stream(),
    flutterwave: configured.flutterwave(),
    paypal: configured.paypal(),
    resend: configured.resend(),
    r2: configured.r2(),
    sms: configured.sms(),
  })
    .map(([name, ok]) => `${ok ? '✓' : '·'} ${name}`)
    .join('   ');
  console.log(`Integrations:  ${live}`);
});

async function shutdown() {
  console.log('\nShutting down…');
  server.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
