import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectDatabase } from '../db.js';
import { createStore } from '../store.js';
import { seedManagerAccounts, MANAGER_ACCOUNTS } from '../manager-accounts.js';
import { verifyPassword } from '../lib.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
let client;
try {
  const connection = await connectDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB || 'auto_safety_report');
  client = connection.client;
  const store = createStore(connection.db), users = store.collection('users');
  const legacy = await users.find({ _id: { $in: ['superadmin', 'admin'] } }).toArray();
  if (legacy.length) {
    const directory = fileURLToPath(new URL('../.backups/', import.meta.url));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${directory}/manager-accounts-${Date.now()}.json`, JSON.stringify(legacy), { mode: 0o600, flag: 'wx' });
  }
  const passwords = Object.fromEntries(MANAGER_ACCOUNTS.map(({username}) => [username, process.env[username.toUpperCase() + '_PASSWORD'] || username]));
  await seedManagerAccounts(store, passwords);
  for (const { username, role } of MANAGER_ACCOUNTS) {
    const account = await users.findOne({ _id: username });
    if (account.role !== role || !await verifyPassword(passwords[username], account.passwordHash)) throw new Error('Account verification failed');
    console.log(`${username}: ${role}, password verified`);
  }
  console.log('Four manager accounts ready. Original manager records backed up privately when present.');
} catch (error) {
  console.error(`Manager setup failed (${error.name}, code ${error.code || 'none'}). No database credentials are logged.`);
  process.exitCode = 1;
} finally { await client?.close(); }
