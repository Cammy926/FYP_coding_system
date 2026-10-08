import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { ensureLocalMongo, stopLocalMongo, portOpen } from '../local-mongo.js';

test('standalone backend starts local MongoDB, reuses existing servers, and preserves data', { timeout: 45000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  const isolated = await mkdtemp(path.join(root, 'test-results', 'standalone-'));
  await mkdir(path.join(isolated, 'runtime/mongodb'), { recursive: true });
  await symlink(path.join(root, 'runtime/mongodb/bin'), path.join(isolated, 'runtime/mongodb/bin'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const uri = `mongodb://127.0.0.1:${port}/`;
  let owned, client;
  try {
    assert.equal(await ensureLocalMongo('mongodb://example.invalid:10255/'), null);
    owned = await ensureLocalMongo(uri, { projectRoot: isolated });
    assert.ok(owned); assert.equal(await portOpen(port), true);
    assert.equal(await ensureLocalMongo(uri, { projectRoot: isolated }), null);
    await stopLocalMongo(null); assert.equal(await portOpen(port), true);
    client = new MongoClient(uri); await client.connect();
    await client.db('startup_test').collection('saved').insertOne({ _id: 'test', message: 'persists' });
    await client.close(); client = null;
    await stopLocalMongo(owned); owned = null; assert.equal(await portOpen(port), false);
    owned = await ensureLocalMongo(uri, { projectRoot: isolated });
    client = new MongoClient(uri); await client.connect();
    assert.equal((await client.db('startup_test').collection('saved').findOne({ _id: 'test' })).message, 'persists');
  } finally { await client?.close(); await stopLocalMongo(owned); await rm(isolated, { recursive: true, force: true }); }
});
