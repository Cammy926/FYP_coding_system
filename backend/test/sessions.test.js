import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../sessions.js';

test('memory sessions expire, revoke, and isolate disaster clear from manager logins', () => {
  let time = 1000;
  const sessions = createSessionStore(() => time);
  sessions.create({ _id: 'manager', userId: 'admin', expiresAt: new Date(5000) });
  sessions.create({ _id: 'unit', userId: '101', incidentId: 'disaster', expiresAt: new Date(5000) });
  sessions.create({ _id: 'expires', userId: '102', expiresAt: new Date(2000) });
  time = 2000;
  assert.equal(sessions.get('expires'), undefined);
  assert.ok(sessions.get('manager'));
  sessions.deleteIncident('disaster');
  assert.equal(sessions.get('unit'), undefined);
  assert.ok(sessions.get('manager'));
  assert.equal(createSessionStore().get('manager'), undefined);
  sessions.delete('manager');
  assert.equal(sessions.get('manager'), undefined);
});
