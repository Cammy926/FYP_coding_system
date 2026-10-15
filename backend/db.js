import { MongoClient } from 'mongodb';
import { hashPassword } from './lib.js';
import { createStore, COLLECTION_NAMES } from './store.js';
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
  for (const name of ['users', 'safety_reports', 'found_items']) await store.collection(name).createIndex({ incidentId: 1 });
  for (const role of ['superadmin', 'admin']) {
    if (!await store.collection('users').findOne({ _id: role })) {
      await store.collection('users').insertOne({ _id: role, username: role, role, passwordHash: await hashPassword(passwords[role] || role), createdAt: new Date() });
    }
  }
  const incident = await store.collection('incidents').findOne({ _id: 'current' });
  // Recover interrupted multi-record operations before login opens: setup
  // rolls back, and an interrupted deletion finishes on the next launch.
  if (incident && incident.status !== 'active') {
    if (incident.status === 'provisioning') await store.collection('disaster_maps').updateOne({ _id: 'current', incidentId: incident.incidentId }, { $set: { phase: 'draft', incidentId: null } });
    await deleteIncidentData(store, incident);
  }
  return store;
}
export async function deleteIncidentData(db, incident) {
  const query = { incidentId: incident.incidentId };
  for (const name of ['safety_reports', 'found_items', 'users', 'disaster_maps']) await db.collection(name).deleteMany(query);
  await db.collection('incidents').deleteOne({ _id: 'current', incidentId: incident.incidentId });
}
