import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { connectDatabase, initializeDatabase } from '../db.js';
import { createApp } from '../app.js';
import { familyPhone, safetyMessage } from '../notifications.js';
import { hashPassword } from '../lib.js';
import { renderWhatsAppQR } from '../whatsapp.js';

// No WhatsApp connection or external messages: only the transport is replaced.
// API, persisted queue, locking, recovery, and cleanup run against real MongoDB.
test('WhatsApp queue integration', { timeout: 60000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'test-results', 'notifications-'));
  const probe = net.createServer();await new Promise(r => probe.listen(0, '127.0.0.1', r));const port = probe.address().port;await new Promise(r => probe.close(r));
  const mongo = spawn(path.join(root, 'runtime/mongodb/bin/mongod'), ['--dbpath', dataDir, '--bind_ip', '127.0.0.1', '--port', String(port), '--quiet', '--logpath', path.join(dataDir, 'mongo.log')], { stdio: 'ignore' });
  let binding = null, qrVersion = 0, connectCalls = 0, logoutCalls = 0, logoutError = false;
  const qrBuffer = await renderWhatsAppQR('FYP isolated fixture - not a real login');
  let client, server, app, base, state = 'disconnected', lookupError = false, registered = true, sendError = false, heldSend, clock = new Date();
  const listeners = new Set(), sent = [], cookies = new Map();
  const whatsapp = { enabled: true, status: () => ({ enabled: true, state }), onChange: callback => { listeners.add(callback);return () => listeners.delete(callback); },
    senderNumber: () => state === 'ready' ? '+12025550131' : null,
    binding: () => binding, setupStatus: () => ({ enabled: true, state, qrAvailable: state === 'qr_required', qrVersion }), qr: () => state === 'qr_required' ? qrBuffer : null,
    start: async ({ clientId }) => { if (binding === clientId && !['idle','disconnected','error'].includes(state)) return;connectCalls++;binding = clientId;qrVersion++;changeState('qr_required'); },
    logout: async () => { if (logoutError) throw new Error('logout unavailable');logoutCalls++;binding = null;changeState('idle'); },
    lookup: async number => { if (lookupError) throw new Error('network');return registered ? { _serialized: number + '@c.us' } : null; },
    send: async (recipient, text) => { sent.push({ recipient, text });if (heldSend) await heldSend;if (sendError) throw new Error('response lost');return { id: { _serialized: 'message-' + sent.length } }; },
  };
  const changeState = next => { state = next;for (const fn of listeners) fn(); };
  let store;
  async function start() {
    app = createApp(store, { rateLimits: false, whatsapp, notificationOptions: { intervalMs: 3600000, timeoutMs: 1000, now: () => clock } });
    await app.locals.notifications.start();server = app.listen(0, '127.0.0.1');await once(server, 'listening');base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function stop() { app?.locals.closeStreams();await app?.locals.notifications.stop();if (server) await new Promise(r => server.close(r)); }
  async function request(actor, route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(cookies.has(actor) ? { Cookie: cookies.get(actor) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const cookie = response.headers.get('set-cookie');if (cookie) cookies.set(actor, cookie.split(';')[0]);return { status: response.status, body: await response.json() };
  }
  async function login(actor) { const username = ['admin','superadmin'].includes(actor) ? actor + '1' : actor; const r = await request(actor, '/auth/login', 'POST', { username, password: username });assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const flush = async () => { await app.locals.notifications.kick();await app.locals.notifications.kick(); };
  async function safe(actor, number) { await login(actor);assert.equal((await request(actor, '/reports', 'POST', { status: 'safe' })).status, 201);return request(actor, '/reports/mine', 'PATCH', { familyPhone: number }); }
  try {
    let connection;
    for (let i = 0; i < 30; i++) { try { connection = await connectDatabase(`mongodb://127.0.0.1:${port}/`, 'notification_test');break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(connection);client = connection.client;store = await initializeDatabase(connection.db);
    await store.collection('incidents').insertOne({ _id: 'current', incidentId: 'n1', status: 'active', blockIdentityVersion: 1, name: 'Test fire', buildings: 1, blocks: [{ building: 0, accountPrefix: 'A', label: 'Block A', floors: 3, rooms: 3 }] });
    await store.collection('disaster_maps').insertOne({ _id: 'current', incidentId: 'n1', phase: 'active', name: 'Test fire' });
    const users = await Promise.all(['A-101', 'A-102', 'A-103', 'A-201', 'A-202', 'A-203', 'A-301'].map(async (username, i) => ({ _id: username, username, role: 'user', incidentId: 'n1', building: 0, floor: Math.floor(i / 3) + 1, room: i % 3 + 1, passwordHash: await hashPassword(username) })));
    await store.collection('users').insertMany(users);await start();await login('admin');await login('superadmin');
    await t.test('phone format, optional number, immutable message, and queue-after-submit only', async () => {
      assert.equal(familyPhone('9123 4567'), '+85291234567');assert.equal(familyPhone('+44 7700 900123'), '+447700900123');assert.equal(familyPhone(''), '');assert.throws(() => familyPhone('+0123456789'));
      const message = safetyMessage({ username: 'A-101', createdAt: new Date('2026-11-03T12:00:00Z') }, 'Test fire');assert.equal(message.split('\n')[0], 'Auto Safety Report System');assert.ok(message.includes('A-101'));assert.ok(message.includes('住戶已報平安'));assert.ok(message.includes('Test fire'));
      const health = await request('anon', '/health');assert.deepEqual(health.body.whatsapp, { enabled: true, state: 'disconnected' });
      await login('A-101');const pressed = await request('A-101', '/reports', 'POST', { status: 'safe' });assert.equal(pressed.body.report.notificationStatus, 'not_requested');assert.equal(sent.length, 0);
      assert.equal((await request('A-101', '/reports/mine', 'PATCH', { familyPhone: '+0123456789' })).status, 400);
      const queued = await request('A-101', '/reports/mine', 'PATCH', { familyPhone: '91234567' });assert.equal(queued.status, 200);assert.equal(queued.body.report.notificationStatus, 'pending');assert.equal(queued.body.report.familyPhone, '+85291234567');assert.ok(queued.body.report.detailsSubmittedAt);assert.equal(sent.length, 0);
      const retries = await Promise.all([1, 2].map(() => request('A-101', '/reports/mine', 'PATCH', { familyPhone: '+85291234567' })));assert.ok(retries.every(r => r.status === 200));assert.ok(retries.every(r => r.body.report.notificationRequestedAt === queued.body.report.notificationRequestedAt));
      assert.equal((await safe('A-102', '')).body.report.notificationStatus, 'skipped');
      await login('A-103');await request('A-103', '/reports', 'POST', { status: 'help' });assert.equal((await request('A-103', '/reports/mine', 'PATCH', {})).body.report.notificationStatus, 'not_applicable');
      await store.collection('safety_reports').insertOne({ _id: 'n1:old', incidentId: 'n1', username: 'old', status: 'safe', familyPhone: '+85291234567', detailsSubmittedAt: new Date(), notificationStatus: 'disabled' });
    });
    await t.test('queue survives restart; sends once on connection and publishes live status', async () => {
      await stop();await start();await login('A-101');await login('admin');await login('superadmin');
      assert.equal((await request('A-101', '/reports/mine')).body.report.notificationStatus, 'pending');
      const stream = await fetch(base + '/map/events', { headers: { Cookie: cookies.get('admin') } });const reader = stream.body.getReader();await reader.read();
      try {
        changeState('ready');await flush();
        let event = '';while (!event.includes('event: reports')) { const chunk = await reader.read();event += new TextDecoder().decode(chunk.value); }
        const saved = (await request('A-101', '/reports/mine')).body.report;assert.equal(saved.notificationStatus, 'sent');assert.equal(saved.notificationMessageId, 'message-1');assert.ok(saved.notificationSentAt);assert.equal(sent.length, 1);assert.equal(sent[0].recipient._serialized, '85291234567@c.us');
        assert.ok(sent[0].text.includes('A-101'));assert.ok(sent[0].text.includes('Test fire'));
        await request('A-101', '/reports/mine', 'PATCH', { familyPhone: '91234567' });await flush();assert.equal(sent.length, 1);
        assert.equal((await store.collection('safety_reports').findOne({ _id: 'n1:old' })).notificationStatus, 'disabled');
      } finally { await reader.cancel(); }
    });
    await t.test('lookup retries are bounded; unregistered numbers and uncertain sends preserve safety', async () => {
      registered = false;await safe('A-201', '+85290000001');await flush();assert.equal((await request('A-201', '/reports/mine')).body.report.notificationError, 'number_not_registered');assert.equal(sent.length, 1);registered = true;
      lookupError = true;await safe('A-202', '+85290000002');await flush();let pending = (await request('A-202', '/reports/mine')).body.report;assert.equal(pending.notificationStatus, 'pending');assert.equal(pending.notificationAttempts, 1);
      for (let i = 0; i < 2; i++) { clock = new Date(clock.getTime() + 120000);await flush(); }
      assert.equal((await request('A-202', '/reports/mine')).body.report.notificationStatus, 'failed');assert.equal(sent.length, 1);lookupError = false;
      sendError = true;await safe('A-203', '+85290000003');await flush();const uncertain = (await request('A-203', '/reports/mine')).body.report;assert.equal(uncertain.notificationStatus, 'unknown');assert.equal(uncertain.status, 'safe');assert.ok(uncertain.detailsSubmittedAt);assert.equal(sent.length, 2);
      await flush();assert.equal(sent.length, 2);sendError = false;
      await store.collection('safety_reports').updateOne({ _id: uncertain._id }, { $set: { notificationStatus: 'sending' } });
      await stop();await start();await login('A-203');await login('admin');await login('superadmin');
      assert.equal((await request('A-203', '/reports/mine')).body.report.notificationError, 'interrupted_send');await flush();assert.equal(sent.length, 2);
    });
    await t.test('a slow send leaves reporting responsive; Clear Setup drains it and cancels queued jobs', async () => {
      let release;heldSend = new Promise(r => release = r);
      await safe('A-301', '+85290000004');
      for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise(r => setTimeout(r, 5));assert.equal(sent.length, 3);
      await login('A-103');const response = await request('A-103', '/reports', 'POST', { status: 'help' });assert.equal(response.status, 200);
      const clearing = request('superadmin', '/incident', 'DELETE', { confirmation: 'CLEAR' });
      await new Promise(r => setTimeout(r, 20));assert.ok(await store.collection('incidents').findOne({ _id: 'current' }));release();heldSend = null;
      assert.equal((await clearing).status, 200);await flush();assert.equal(await store.collection('safety_reports').countDocuments({ incidentId: 'n1' }), 0);assert.equal(sent.length, 3);
      assert.ok(!(await connection.db.listCollections({}, { nameOnly: true }).toArray()).some(c => c.name === 'sessions'));
    });
    await t.test('Super Admin QR completes initialization, blocks other roles, and Clear confirms logout', async () => {
      await store.collection('disaster_maps').insertOne({_id:'current',name:'QR setup test',phase:'draft',revision:1,image:{data:'fixture'},blocks:[{building:0,label:'Block A',accountPrefix:'A',floors:1,rooms:2}],annotations:[{id:'a',type:'block',building:0,x:.5,y:.5}]});
      const setup=await request('superadmin','/incident','POST',{mapRevision:1});assert.equal(setup.status,201,JSON.stringify(setup.body));assert.equal(setup.body.incident.setupComplete,false);
      const incidentId=setup.body.incident.incidentId,correctBinding=binding;assert.ok(correctBinding.includes(incidentId));const calls=connectCalls;
      assert.equal((await request('anon','/whatsapp')).status,401);assert.equal((await request('anon','/whatsapp/qr?incidentId='+incidentId)).status,401);
      for(const actor of ['admin1','admin2','A-101']) assert.equal((await request(actor,'/auth/login','POST',{username:actor,password:actor})).status,403);
      assert.equal((await request('superadmin','/dashboard')).status,409);
      assert.equal((await request('superadmin','/floors/0/1','PATCH',{incidentId,status:'cleared',revision:0})).status,409);
      const qr=await fetch(base+'/whatsapp/qr?incidentId='+incidentId,{headers:{Cookie:cookies.get('superadmin')}});assert.equal(qr.status,200);assert.equal(qr.headers.get('content-type'),'image/png');assert.match(qr.headers.get('cache-control'),/no-store/);assert.ok((await qr.arrayBuffer()).byteLength>100);
      assert.equal((await request('superadmin','/whatsapp/qr?incidentId=previous')).status,409);
      assert.equal((await request('superadmin','/whatsapp/connect','POST',{incidentId:'previous'})).status,409);
      assert.equal((await request('superadmin','/whatsapp/connect','POST',{incidentId})).status,202);assert.equal(connectCalls,calls);
      binding='previous-sender';changeState('ready');assert.equal((await request('superadmin','/whatsapp')).body.setupComplete,false);
      assert.equal((await request('superadmin', '/incident')).body.whatsappSenderNumber, undefined);
      binding=correctBinding;changeState('qr_required');
      await stop();state='idle';binding=null;await initializeDatabase(client.db('notification_test'));await start();await login('superadmin');
      await app.locals.restoreWhatsApp();assert.equal(connectCalls,calls);assert.equal((await request('superadmin','/incident')).body.incident.setupComplete,false);
      assert.equal((await request('superadmin','/whatsapp/connect','POST',{incidentId})).status,202);assert.equal(binding,correctBinding);
      changeState('authenticated');assert.equal((await request('superadmin','/whatsapp')).body.setupComplete,false);changeState('ready');
      assert.equal((await request('superadmin','/whatsapp')).body.setupComplete,true);assert.ok((await store.collection('incidents').findOne({_id:'current'})).whatsappLinkedAt);
      await login('admin');await login('A-101');assert.equal((await request('admin','/whatsapp')).status,403);assert.equal((await request('A-101','/whatsapp/qr?incidentId='+incidentId)).status,403);
      assert.equal((await request('superadmin', '/incident')).body.whatsappSenderNumber, '+12025550131');
      assert.equal((await request('admin', '/incident')).body.whatsappSenderNumber, undefined);
      assert.equal((await request('A-101', '/incident')).body.whatsappSenderNumber, undefined);
      assert.deepEqual((await request('anon', '/health')).body.whatsapp, { enabled: true, state: 'ready' });
      changeState('disconnected');await login('A-102');assert.equal((await request('A-102','/reports','POST',{status:'help'})).status,201);
      assert.equal((await request('superadmin', '/incident')).body.whatsappSenderNumber, null);
      const preservedMap=await store.collection('disaster_maps').findOne({_id:'current'}),preservedReports=await store.collection('safety_reports').find({}).toArray();
      assert.equal((await request('superadmin','/whatsapp/connect','POST',{incidentId})).status,202);assert.equal((await request('superadmin','/whatsapp')).body.qrAvailable,true);
      assert.equal((await request('superadmin','/whatsapp')).body.setupComplete,true);assert.equal((await request('admin','/dashboard')).status,200);
      assert.deepEqual(await store.collection('disaster_maps').findOne({_id:'current'}),preservedMap);assert.deepEqual(await store.collection('safety_reports').find({}).toArray(),preservedReports);
      changeState('ready');
      logoutError=true;const failed=await request('superadmin','/incident','DELETE',{confirmation:'CLEAR'});assert.equal(failed.status,503);assert.match(failed.body.error,/preserved/);assert.equal((await store.collection('incidents').findOne({_id:'current'})).status,'active');assert.equal((await request('admin','/dashboard')).status,200);
      logoutError=false;const before=logoutCalls;assert.equal((await request('superadmin','/incident','DELETE',{confirmation:'CLEAR'})).status,200);assert.equal(logoutCalls,before+1);assert.equal(binding,null);assert.equal(state,'idle');assert.equal(await store.collection('incidents').countDocuments(),0);
    });
  } finally {
    await stop();await client?.close();
    if (mongo.exitCode === null) { const exited = once(mongo, 'exit');mongo.kill('SIGTERM');await exited; }
    await rm(dataDir, { recursive: true, force: true });
  }
});
