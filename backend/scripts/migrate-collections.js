import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { connectDatabase, initializeDatabase } from '../db.js';
import { createStore } from '../store.js';
import { migrateLegacyCollection, LEGACY_COLLECTION } from '../migration.js';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
let client;
try {
  let locked = false;
  try { await access(fileURLToPath(new URL('../.server.lock', import.meta.url))); locked = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (locked) throw new Error('Stop the backend before migrating collections.');
  const connection = await connectDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB || 'auto_safety_report');
  client = connection.client;
  const result = await migrateLegacyCollection(connection.db, createStore(connection.db));
  await initializeDatabase(connection.db, { admin: process.env.ADMIN_PASSWORD, superadmin: process.env.SUPERADMIN_PASSWORD });
  console.log(`Copied and verified ${result.copied} records in ${connection.db.databaseName}.`);
  for (const [name, count] of Object.entries(result.counts)) console.log(`${name}: ${count} source records`);
  console.log(`${LEGACY_COLLECTION} retained as an inactive migration backup. The application uses the separate collections.`);
} catch (error) { console.error(`Collection migration failed (${error.name}, code ${error.code || 'none'}). Source retained; no credentials logged.`); process.exitCode = 1; }
finally { await client?.close(); }
