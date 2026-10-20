import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BSON } from 'mongodb';
import { hashPassword } from './lib.js';
import { codeFromLabel, blockUnitName } from '../shared/blocks.js';

// Run before HTTP starts. Older maps assigned account prefixes by array order.
// Keep map positions/layouts and floor-search records; move accounts/reports by
// their actual username. Every changed database gets a private recovery copy.
export async function repairBlockAccounts(store, { backupDirectory = fileURLToPath(new URL('.backups/', import.meta.url)) } = {}) {
  const incident = await store.collection('incidents').findOne({ _id: 'current' });
  if (!incident || incident.status !== 'active' || incident.blockIdentityVersion === 1) return null;
  const map = await store.collection('disaster_maps').findOne({ _id: 'current', phase: 'active', incidentId: incident.incidentId });
  if (!map) return null;
  const fail = message => { const error = new Error(message); error.code = 'BLOCK_IDENTITY_REPAIR'; throw error; };
  const prefixes = new Set();
  const blocks = map.blocks.map(block => {
    const accountPrefix = block.accountPrefix ?? (map.blocks.length === 1 ? '' : codeFromLabel(block.label) || String.fromCharCode(65 + block.building));
    if (prefixes.has(accountPrefix)) fail('Block account prefixes are ambiguous. No automatic repair was made.');
    prefixes.add(accountPrefix);
    return { ...block, accountPrefix };
  });
  const query = { incidentId: incident.incidentId };
  const users = await store.collection('users').find(query).toArray();
  const reports = await store.collection('safety_reports').find(query).toArray();
  const expected = new Map();
  for (const block of blocks) for (let floor = 1; floor <= block.floors; floor++) for (let room = 1; room <= block.rooms; room++) {
    const username = blockUnitName(block, floor, room);
    expected.set(username, { building: block.building, floor, room });
  }
  // A report outside its named block's layout needs review; never hide/delete it.
  for (const report of reports) {
    if (!expected.has(report.username || report.userId)) fail('A saved report is outside its named block layout. Review the block layout before repairing accounts; no reports were deleted.');
  }
  if (users.some(user => user._id !== user.username || user.role !== 'user')) fail('Unexpected account identity. No automatic repair was made.');
  const existingUsers = new Map(users.map(user => [user.username, user]));
  const usernames = [...expected.keys()];
  for (let i = 0; i < usernames.length; i += 500) {
    const conflicts = await store.collection('users').find({ _id: { $in: usernames.slice(i, i + 500) } }, { projection: { _id: 1 } }).toArray();
    if (conflicts.some(user => !existingUsers.has(user._id))) fail('An account belongs to another incident. No automatic repair was made.');
  }
  const snapshot = { database: store.databaseName, savedAt: new Date(), incident, map, users, reports,
    floorSearches: await store.collection('floor_searches').find(query).toArray(),
    foundItems: await store.collection('found_items').find(query).toArray() };
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDirectory, `block-accounts-${Date.now()}-${randomUUID()}.json`);
  await writeFile(backupPath, BSON.EJSON.stringify(snapshot, { relaxed: false }), { mode: 0o600, flag: 'wx' });
  let movedAccounts = 0, createdAccounts = 0, movedReports = 0;
  for (const [username, location] of expected) {
    const user = existingUsers.get(username);
    if (user) {
      if (Object.entries(location).some(([key, value]) => user[key] !== value)) {
        await store.collection('users').updateOne({ _id: username, ...query }, { $set: location });
        movedAccounts++;
      }
    } else {
      await store.collection('users').insertOne({ _id: username, username, role: 'user', ...query, ...location, passwordHash: await hashPassword(username), createdAt: new Date() });
      createdAccounts++;
    }
  }
  for (const report of reports) {
    const username = report.username || report.userId, location = expected.get(username);
    if (Object.entries(location).some(([key, value]) => report[key] !== value)) {
      await store.collection('safety_reports').updateOne({ _id: report._id, ...query }, { $set: { ...location, username } });
      movedReports++;
    }
  }
  // These accounts have no report (checked above) and do not exist in the
  // corrected layout. Their original records remain in the recovery snapshot.
  for (const user of users) if (!expected.has(user.username)) await store.collection('users').deleteOne({ _id: user._id, ...query });
  await store.collection('disaster_maps').updateOne({ _id: map._id, ...query }, { $set: { blocks, updatedAt: new Date() }, $inc: { revision: 1 } });
  // Last write marks completion. A restart during repair can safely rerun it.
  await store.collection('incidents').updateOne({ _id: incident._id, ...query }, { $set: { blocks, blockIdentityVersion: 1 } });
  return { movedAccounts, createdAccounts, movedReports, backupPath };
}
