import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { connectDatabase, initializeDatabase } from '../db.js';
import { createStore } from '../store.js';
import { copyRecords, legacyStore, LEGACY_COLLECTION } from '../migration.js';
import { ensureLocalMongo, stopLocalMongo } from '../local-mongo.js';

// Copies this application's legacy local records; never removes source records.
// Existing cloud identities are not overwritten.
const sourceConfig=dotenv.parse(await readFile(fileURLToPath(new URL('../.env.local', import.meta.url))));
const targetConfig=dotenv.parse(await readFile(fileURLToPath(new URL('../.env', import.meta.url))));
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(sourceConfig.MONGODB_URI || '')) throw new Error('Migration source must be the saved local configuration.');
if (sourceConfig.MONGODB_URI === targetConfig.MONGODB_URI) throw new Error('Source and destination servers must be different.');
let sourceClient,targetClient,owned;
try {
  owned=await ensureLocalMongo(sourceConfig.MONGODB_URI);
  const source=await connectDatabase(sourceConfig.MONGODB_URI,sourceConfig.MONGODB_DB || 'auto_safety_report');sourceClient=source.client;
  const target=await connectDatabase(targetConfig.MONGODB_URI,targetConfig.MONGODB_DB || 'auto_safety_report');targetClient=target.client;
  const store=createStore(target.db);
  const sourceNames=(await source.db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name);
  const legacyName=sourceConfig.MONGODB_COLLECTION || LEGACY_COLLECTION;
  const sourceStore=sourceNames.includes('user') ? createStore(source.db) : sourceNames.includes(legacyName) ? legacyStore(source.db,legacyName) : source.db;
  const result=await copyRecords(sourceStore,store);
  await initializeDatabase(target.db,{admin:targetConfig.ADMIN_PASSWORD,superadmin:targetConfig.SUPERADMIN_PASSWORD});
  console.log(`Copied ${result.copied} records to ${store.databaseName} in separate collections. Local source retained.`);
} catch(error) { console.error(`Migration failed (${error.name}, code ${error.code || 'none'}). No URI is logged. Local source retained.`);process.exitCode=1; }
finally { await sourceClient?.close();await targetClient?.close();await stopLocalMongo(owned); }
