import { hashPassword } from './lib.js';

export const MANAGER_ACCOUNTS = [
  { username: 'superadmin1', role: 'superadmin' },
  { username: 'superadmin2', role: 'superadmin' },
  { username: 'admin1', role: 'admin' },
  { username: 'admin2', role: 'admin' },
];

export async function seedManagerAccounts(store, passwords = {}) {
  const users = store.collection('users');
  for (const { username, role } of MANAGER_ACCOUNTS) {
    const existing = await users.findOne({ _id: username });
    if (existing) {
      if (existing.username !== username || existing.role !== role || existing.incidentId) {
        throw new Error(`Manager account conflict: ${username}`);
      }
      continue; // Preserve existing passwords on subsequent startups.
    }
    await users.updateOne({ _id: username }, { $setOnInsert: {
      username, role, passwordHash: await hashPassword(passwords[username] || username), createdAt: new Date(),
    } }, { upsert: true });
  }
  // Retire only the original, unnumbered manager accounts after all four exist.
  for (const role of ['superadmin', 'admin']) {
    await users.deleteOne({ _id: role, username: role, role, incidentId: { $exists: false } });
  }
}
