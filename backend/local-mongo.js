import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
export async function stopLocalMongo(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}
// Remote databases remain remote. A running local MongoDB is reused and never
// stopped by this backend. Only a process launched here belongs to this backend.
export async function ensureLocalMongo(uri, { projectRoot = root } = {}) {
  let connection;
  try { connection = new URL(uri); } catch { return null; }
  if (connection.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.username || connection.password) return null;
  const port = Number(connection.port || 27017);
  if (await portOpen(port)) return null;
  const binary = path.join(projectRoot, 'runtime/mongodb/bin/mongod');
  try { await access(binary); }
  catch { throw new Error('Local MongoDB is missing. From the project folder run: node scripts/setup.mjs'); }
  await mkdir(path.join(projectRoot, 'data/mongodb'), { recursive: true });
  await mkdir(path.join(projectRoot, 'logs'), { recursive: true });
  const child = spawn(binary, [
    '--dbpath', path.join(projectRoot, 'data/mongodb'),
    '--bind_ip', '127.0.0.1', '--port', String(port),
    '--logpath', path.join(projectRoot, 'logs/mongodb.log'), '--logappend',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  let failure;
  child.on('error', error => { failure = error; });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure) throw new Error(`Local MongoDB could not start (${failure.code}). Check logs/mongodb.log.`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Local MongoDB stopped during startup. Check logs/mongodb.log.');
      if (await portOpen(port)) {
        console.log(`Local MongoDB ready: mongodb://127.0.0.1:${port}`);
        return child;
      }
      await delay(500);
    }
    throw new Error('Local MongoDB did not become ready. Check logs/mongodb.log.');
  } catch (error) { await stopLocalMongo(child); throw error; }
}
