import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const portOpen = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
function stop(code = 0) {
  if (stopping) return; stopping = true;
  console.log('\nStopping local servers. Your MongoDB data remains saved.');
  for (const child of children) child.kill('SIGTERM');
  const exited = children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)));
  Promise.all(exited).then(() => process.exit(code));
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 10000).unref();
}
function run(label, command, args, cwd, output = 'inherit') {
  const child = spawn(command, args, { cwd, stdio: output }); children.push(child);
  child.once('error', error => { console.error(`${label} failed to start: ${error.code}.`); stop(1); });
  child.once('exit', code => { if (!stopping) { console.error(`${label} stopped (code ${code}).`); stop(code || 1); } });
  return child;
}
try {
  for (const filename of ['frontend/node_modules/vite/bin/vite.js', 'backend/node_modules/express/package.json']) await access(path.join(root, filename));
  const env = await readFile(path.join(root,'backend/.env'),'utf8');
  const local = /^MONGODB_URI=["']?mongodb:\/\/(127\.0\.0\.1|localhost):27017\//m.test(env);
  if (await portOpen(3001) || await portOpen(5173)) throw new Error('Port 3001 or 5173 is already in use. Stop the previous system before starting another copy.');
  if (local && !await portOpen(27017)) {
    const binary = path.join(root,'runtime/mongodb/bin/mongod'); await access(binary);
    await mkdir(path.join(root,'data/mongodb'),{recursive:true}); await mkdir(path.join(root,'logs'),{recursive:true});
    run('MongoDB', binary, ['--dbpath',path.join(root,'data/mongodb'),'--bind_ip','127.0.0.1','--port','27017','--logpath',path.join(root,'logs/mongodb.log'),'--logappend'],root,['ignore','ignore','inherit']);
    let ready = false;
    for (let i=0;i<60;i++) { if (stopping) break; if (await portOpen(27017)) { ready = true; break; } await delay(500); }
    if (!ready) throw new Error('MongoDB did not start. Check logs/mongodb.log.');
    console.log('Local MongoDB ready · Compass: mongodb://127.0.0.1:27017');
  }
  run('Backend',process.execPath,['server.js'],path.join(root,'backend'));
  let ready = false;
  for (let i=0;i<60;i++) {
    if (stopping) break;
    try { const response = await fetch('http://127.0.0.1:3001/api/health'); if (response.ok) { ready = true; break; } } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('Backend did not start. See its message above and check backend/.env.');
  run('Frontend',process.execPath,[path.join(root,'frontend/node_modules/vite/bin/vite.js'),'--host','127.0.0.1'],path.join(root,'frontend'));
  for (let i=0;i<30 && !await portOpen(5173);i++) await delay(300);
  if (!stopping) {
    console.log('\nOpen http://localhost:5173 · Press Control+C to stop.');
    if (process.platform === 'darwin' && !process.env.NO_BROWSER) spawn('open',['http://localhost:5173'],{stdio:'ignore'}).on('error',()=>{});
  }
} catch (error) { console.error(error.message); console.error('If dependencies are missing, double-click setup.command.'); stop(1); }
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop());
