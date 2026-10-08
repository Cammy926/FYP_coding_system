import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { connectDatabase, COLLECTIONS } from '../db.js';
import { createStore } from '../store.js';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
let client;
try {
  const connection = await connectDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB || 'auto_safety_report');
  client = connection.client;
  const store = createStore(connection.db);
  for (const name of COLLECTIONS) console.log(`${store.collectionNames[name]}: ${await store.collection(name).countDocuments()} documents`);
  console.log(`Connected to ${store.databaseName}. Refresh Compass to see the collections.`);
} catch (e) { console.error(`Connection failed: ${e.name} (${e.code || 'no code'}). Check credentials and database firewall.`); process.exitCode = 1; }
finally { await client?.close(); }
