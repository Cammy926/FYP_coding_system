import { MongoClient } from 'mongodb';
import { seedManagerAccounts } from './manager-accounts.js';
import { createStore, COLLECTION_NAMES } from './store.js';
import { repairBlockAccounts } from './block-accounts.js';
export const COLLECTIONS = Object.keys(COLLECTION_NAMES);
export async function connectDatabase(uri, name) {
  if (!uri) throw new Error('MONGODB_URI is missing in backend/.env.');
  if (!/^[a-zA-Z0-9_-]+$/.test(name || '')) throw new Error('MONGODB_DB must be a simple database name.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, connectTimeoutMS: 12000, maxPoolSize: 8, retryWrites: false });
  try { await client.connect(); await client.db(name).command({ ping: 1 }); }
  catch (error) { await client.close(); throw error; }
  return { client, db: client.db(name) };
}
export async function initializeDatabase(db, passwords = {}) {
  const store = createStore(db);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const name of Object.values(COLLECTION_NAMES)) {
    if (!existing.has(name)) {
      try { await db.createCollection(name); } catch (e) { if (e.code !== 48) throw e; }
    }
  }
  for (const name of ['users', 'safety_reports', 'found_items', 'floor_searches', 'whatsapp_replies']) await store.collection(name).createIndex({ incidentId: 1 });
  // Cosmos DB requires an index on the queue's ordering field, even when the
  // current query returns no pending records.
  await store.collection('safety_reports').createIndex({ notificationRequestedAt: 1 });
  await seedManagerAccounts(store, passwords);
  const incident = await store.collection('incidents').findOne({ _id: 'current' });
  // Recover interrupted multi-record operations before login opens: setup
  // rolls back, and an interrupted deletion finishes on the next launch.
  if (incident && incident.status !== 'active') {
    if (incident.status === 'provisioning') await store.collection('disaster_maps').updateOne({ _id: 'current', incidentId: incident.incidentId }, { $set: { phase: 'draft', incidentId: null } });
    await deleteIncidentData(store, incident);
  }
  await repairBlockAccounts(store);
  return store;
}
export async function deleteIncidentData(db, incident) {
  const query = { incidentId: incident.incidentId };
  for (const name of ['safety_reports', 'found_items', 'users', 'disaster_maps', 'floor_searches', 'whatsapp_replies']) await db.collection(name).deleteMany(query);
  await db.collection('incidents').deleteOne({ _id: 'current', incidentId: incident.incidentId });
}
