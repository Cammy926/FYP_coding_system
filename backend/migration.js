import { isDeepStrictEqual } from 'node:util';
import { COLLECTION_NAMES } from './store.js';

export const LEGACY_COLLECTION = 'FYP-SafetySystem';
const recordTypes = { users: 'user', incidents: 'incident', safety_reports: 'safety_report', found_items: 'found_item', sessions: 'session' };
export function legacyStore(db, collectionName = LEGACY_COLLECTION) {
  const collection = db.collection(collectionName);
  return { collection: name => ({ find: () => ({ toArray: async () => {
    if (!recordTypes[name]) return [];
    const records = await collection.find({ recordType: recordTypes[name] }).toArray();
    return records.map(({ recordType, recordId, ...fields }) => ({ ...fields, _id: recordId ?? fields._id.slice(fields._id.indexOf(':') + 1) }));
  } }) }) };
}

// Call with the backend stopped. Check all identities before copying, never
// overwrite different records, verify every field, and retain the source.
export async function copyRecords(source, destination) {
  const records = [];
  const counts = {};
  for (const name of Object.keys(COLLECTION_NAMES)) {
    const documents = await source.collection(name).find({}).toArray();
    counts[COLLECTION_NAMES[name]] = documents.length;
    for (const document of documents) {
      const existing = await destination.collection(name).findOne({ _id: document._id });
      if (existing && !isDeepStrictEqual(existing, document)) throw new Error(`Conflicting record in ${COLLECTION_NAMES[name]}; migration stopped without overwriting it.`);
      records.push({ name, document, existing: !!existing });
    }
  }
  let copied = 0;
  for (const { name, document, existing } of records) {
    if (!existing) { await destination.collection(name).insertOne(document); copied++; }
    const saved = await destination.collection(name).findOne({ _id: document._id });
    if (!isDeepStrictEqual(saved, document)) throw new Error(`Verification failed for ${COLLECTION_NAMES[name]}. Source retained.`);
  }
  return { copied, counts };
}

export async function migrateLegacyCollection(db, destination) {
  const collection = db.collection(LEGACY_COLLECTION);
  const unknown = await collection.countDocuments({ recordType: { $nin: Object.values(recordTypes) } });
  if (unknown) throw new Error('Legacy collection contains unknown record types; source retained.');
  return copyRecords(legacyStore(db), destination);
}
