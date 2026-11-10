import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { open, readFile, unlink } from 'node:fs/promises';
import { connectDatabase, initializeDatabase } from './db.js';
import { createApp } from './app.js';
import { ensureLocalMongo, stopLocalMongo } from './local-mongo.js';
import { createWhatsAppTransport } from './whatsapp.js';
dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });
const lockPath = fileURLToPath(new URL('.server.lock', import.meta.url));
let ownsLock = false, client, server, localMongo, app, whatsapp, stopping;
async function acquireLock() {
  try { const lock = await open(lockPath, 'wx'); ownsLock = true; await lock.writeFile(String(process.pid)); await lock.close(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await readFile(lockPath, 'utf8'));
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { await unlink(lockPath); return acquireLock(); } throw error; }
    throw new Error('Another backend is already running. Stop it before starting a second copy.');
  }
}
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    app?.locals.closeStreams();
    const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    await Promise.all([app?.locals.notifications.stop(), app?.locals.drainWhatsAppReplies()]);
    await whatsapp?.stop();
    await closed;
    if (client) await client.close();
    await stopLocalMongo(localMongo);
    if (ownsLock) await unlink(lockPath).catch(() => {});
  })();
  return stopping;
}
try {
  await acquireLock();
  localMongo = await ensureLocalMongo(process.env.MONGODB_URI);
  const connection = await connectDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB || 'auto_safety_report');
  client = connection.client;
  const store = await initializeDatabase(connection.db, { superadmin1: process.env.SUPERADMIN1_PASSWORD, superadmin2: process.env.SUPERADMIN2_PASSWORD, admin1: process.env.ADMIN1_PASSWORD, admin2: process.env.ADMIN2_PASSWORD });
  whatsapp = createWhatsAppTransport({ enabled: process.env.WHATSAPP_ENABLED === 'true', terminalQR: process.env.WHATSAPP_QR_TERMINAL === 'true', executablePath: process.env.WHATSAPP_CHROME_PATH });
  app = createApp(store, { whatsapp, defaultCountryCode: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '852', origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim()) });
  await app.locals.notifications.start();
  server = app.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => console.log(`Backend ready: http://127.0.0.1:${process.env.PORT || 3001} · ${store.databaseName} · collections: ${Object.values(store.collectionNames).join(", ")}`));
  server.on('error', async error => { console.error(`Cannot listen: ${error.code}.`); await stop(); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await stop(); process.exit(0); });
  void app.locals.restoreWhatsApp().catch(() => console.error('Could not restore the WhatsApp sender. Super Admin can retry the connection from the setup page.'));
} catch (error) {
  console.error(`Backend startup failed (${error.name}, code ${error.code || 'none'}).`);
  if (error.code === 'BLOCK_IDENTITY_REPAIR') console.error(error.message);
  if (String(error.message).includes('Subscription owning the database account is disabled')) console.error('Azure says the subscription owning this database is disabled. Reactivate it in Azure before using this connection.');
  if (String(error.message).startsWith('Local MongoDB')) console.error(error.message);
  console.error(ownsLock ? 'Check backend/.env, internet access, database credentials, and the Cosmos DB firewall. No database URI is logged.' : 'Another backend may already be running.');
  await stop(); process.exit(1);
}
