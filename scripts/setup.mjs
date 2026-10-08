import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const has = async file => { try { await access(file); return true; } catch { return false; } };
const bundledPnpm = path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm');
let packageManager = spawnSync('npm',['--version'],{stdio:'ignore'}).status === 0 ? 'npm' : await has(bundledPnpm) ? bundledPnpm : null;
if (!packageManager) throw new Error('Install Node.js 22 or newer, including npm.');
for (const folder of ['backend','frontend']) {
  const result = spawnSync(packageManager,['install'],{cwd:path.join(root,folder),stdio:'inherit',env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH}});
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!await has(path.join(root,'backend/.env'))) await writeFile(path.join(root,'backend/.env'), await readFile(path.join(root,'backend/.env.example')), {mode:0o600});
if (!await has(path.join(root,'runtime/mongodb/bin/mongod'))) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Install MongoDB Community for your platform, start it on 127.0.0.1:27017, and then run start.command (or npm run dev).');
  console.log('Downloading MongoDB Community 8.0.32 for Apple Silicon…');
  const response = await fetch('https://fastdl.mongodb.org/osx/mongodb-macos-arm64-8.0.32.tgz');
  if (!response.ok) throw new Error(`MongoDB download failed (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== 'f81cb258434d548dca7244d599c82eb339043d8dedd0b1b807870c9d263117f2') throw new Error('MongoDB archive checksum did not match.');
  await mkdir(path.join(root,'runtime/mongodb'),{recursive:true});
  const archive = path.join(root,'runtime/mongodb-download.tgz'); await writeFile(archive,buffer);
  const result = spawnSync('tar',['-xzf',archive,'--strip-components=1','-C',path.join(root,'runtime/mongodb')],{stdio:'inherit'});
  await unlink(archive);
  if (result.status !== 0) throw new Error('Could not unpack MongoDB.');
}
console.log('Dependencies ready. Start with start.command or npm run dev.');
