import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { connectDatabase } from '../db.js';
import { COLLECTION_NAMES } from '../store.js';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
let client;
try {
  const name = process.env.MONGODB_DB || 'auto_safety_report';
  assert.equal(name, 'auto_safety_report', 'This utility is limited to the application database.');
  const connection = await connectDatabase(process.env.MONGODB_URI, name);
  client = connection.client;
  const counts = {};
  for (const collection of Object.values(COLLECTION_NAMES)) counts[collection] = await connection.db.collection(collection).countDocuments();
  try { await connection.db.collection('sessions').drop(); } catch (error) { if (error.code !== 26) throw error; }
  const names = (await connection.db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  assert.ok(!names.includes('sessions'));
  for (const [collection, count] of Object.entries(counts)) {
    assert.equal(await connection.db.collection(collection).countDocuments(), count);
    console.log(`${collection}: ${count} records preserved`);
  }
  console.log('sessions collection removed. Login state now uses backend memory.');
  console.log(`FYP-SafetySystem ${names.includes('FYP-SafetySystem') ? 'still exists; not modified' : 'is absent, as reported'}.`);
} catch (error) { console.error(`Removal failed (${error.name}, code ${error.code || 'none'}). No credentials logged.`); process.exitCode = 1; }
finally { await client?.close(); }
