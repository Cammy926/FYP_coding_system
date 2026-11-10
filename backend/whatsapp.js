import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, unlink, writeFile, chmod, access, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ApiError, mutationQueue } from './lib.js';
import { stabilizeWhatsAppClient, recoverWhatsAppBrowser, restoreWhatsAppMessageKey, transientFrameError } from './whatsapp-client.js';

const require = createRequire(import.meta.url);
const authDirectory = fileURLToPath(new URL('.wwebjs_auth/', import.meta.url));
export const whatsappQRPath = path.join(authDirectory, 'link.png');
export const legacyWhatsAppClientId = 'auto-safety-report';

export async function renderWhatsAppQR(qr) {
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const code = new QRCode(-1, levels.L);code.addData(qr);code.make();
  const size = code.getModuleCount(), margin = 4, scale = 8, width = (size + margin * 2) * scale;
  const squares = code.modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" width="${scale}" height="${scale}"/>`] : [])).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><rect width="100%" height="100%" fill="white"/><g fill="black">${squares}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const exists = async p => { try { await access(p);return true; } catch { return false; } };

function phoneNumberFromWhatsAppId(id) {
  const match = /^([1-9]\d{6,14})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(id ?? '');
  return match ? '+' + match[1] : null;
}

export function createWhatsAppTransport({ enabled = true, terminalQR = false, executablePath, log = console, authPath = authDirectory, clientFactory, logoutTimeoutMs = 45000, connectionTimeoutMs = 90000 } = {}) {
  const events = new EventEmitter(), lifecycle = mutationQueue();
  let state = enabled ? 'idle' : 'disabled', client, ownsLock = false, closed = false, binding, generation = 0, initialization, qrBuffer, qrVersion = 0, connectionTimer, problem = null;
  const lockPath = path.join(authPath, '.client.lock'), imagePath = path.join(authPath, 'link.png');
  let linkedNumber = null, recovering = false;
  const change = next => {
    state = next;
    if (!['starting', 'authenticated'].includes(next)) recovering = false;
    if (next !== 'ready') linkedNumber = null;
    events.emit('change');
  };
  const clearConnectionTimer = () => { clearTimeout(connectionTimer);connectionTimer = null; };
  function watchConnection(epoch) {
    clearConnectionTimer();
    connectionTimer = setTimeout(() => {
      if (epoch !== generation || closed || !['starting', 'authenticated'].includes(state)) return;
      problem = 'connection_timeout';change('error');
      log.error('WhatsApp connection timed out. Retry connection on the Super Admin page; the saved login is preserved.');
    }, connectionTimeoutMs);
    connectionTimer.unref?.();
  }
  async function acquireLock() {
    if (ownsLock) return;
    await mkdir(authPath, { recursive: true, mode: 0o700 });
    try { const lock = await open(lockPath, 'wx', 0o600);ownsLock = true;await lock.writeFile(String(process.pid));await lock.close(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid WhatsApp lock. Inspect the local auth folder.');
      try { process.kill(pid, 0); }
      catch (e) { if (e.code === 'ESRCH') { await unlink(lockPath);return acquireLock(); }throw e; }
      throw new Error('WhatsApp is already open in another backend or checker. Stop that process first.');
    }
  }
  async function dispose() {
    generation++;clearConnectionTimer();qrBuffer = null;
    const old = client;client = null;
    await old?.destroy().catch(() => {});
    await initialization?.catch(() => {});initialization = null;
    if (old || ownsLock) await unlink(imagePath).catch(() => {});
    if (ownsLock) { await unlink(lockPath).catch(() => {});ownsLock = false; }
  }
  async function begin(clientId, replaceClient = false) {
    if (!/^[\w-]{1,100}$/.test(clientId)) throw new Error('Invalid WhatsApp client identity.');
    if (!replaceClient && client && binding === clientId && !['error', 'disconnected', 'auth_failure', 'authenticated'].includes(state)) return;
    await dispose();await acquireLock();
    binding = clientId;const epoch = ++generation;qrBuffer = null;problem = null;change('starting');watchConnection(epoch);
    const { default: whatsapp } = await import('whatsapp-web.js');
    const { default: qrcode } = await import('qrcode-terminal');
    if (!clientFactory && await recoverWhatsAppBrowser(path.join(authPath, 'session-' + clientId))) log.log('Closed the previous WhatsApp browser so the sender can reconnect.');
    const options = { authStrategy: new whatsapp.LocalAuth({ clientId, dataPath: authPath }),
      webVersionCache: { type: 'local', path: fileURLToPath(new URL('.wwebjs_cache/', import.meta.url)) },
      puppeteer: { headless: true, ...(executablePath ? { executablePath } : {}) } };
    const current = clientFactory ? clientFactory(options) : new whatsapp.Client(options);client = current;
    const valid = () => epoch === generation && !closed;
    const loggedOut = () => {
      if (!valid() || state === 'logging_out') return;
      clearConnectionTimer();qrBuffer = null;problem = 'logged_out';change('disconnected');
    };
    if (!clientFactory) stabilizeWhatsAppClient(current, { isCurrent: valid, onLoggedOut: loggedOut, onError: error => {
      if (!valid() || state === 'logging_out') return;
      if (restoreBrowserFrame(error, current, clientId)) return;
      clearConnectionTimer();problem = 'initialization_failed';change('error');
      log.error('WhatsApp messaging initialization failed after linking. Retry connection on the Super Admin page; the saved login is preserved.');
    } });
    current.on('qr', qr => {
      if (!valid() || state === 'logging_out') return;
      clearConnectionTimer();problem = null;qrBuffer = null;change('qr_required');
      if (terminalQR) { log.log('Scan with the SENDER account in WhatsApp → Linked devices → Link a device.');qrcode.generate(qr, { small: true }); }
      void renderWhatsAppQR(qr).then(async buffer => {
        if (!valid() || state !== 'qr_required') return;
        await writeFile(imagePath, buffer, { mode: 0o600 });await chmod(imagePath, 0o600);
        if (!valid() || state !== 'qr_required') { await unlink(imagePath).catch(() => {});return; }
        qrBuffer = buffer;qrVersion++;events.emit('change');log.log('WhatsApp QR ready on the Super Admin setup page.');
      }).catch(() => { if (valid()) { change('error');log.error('Could not generate the WhatsApp QR image. Retry the connection.'); } });
    });
    current.on('authenticated', () => { if (valid() && !['ready', 'authenticated', 'error', 'logging_out'].includes(state)) { qrBuffer = null;change('authenticated');watchConnection(epoch);void unlink(imagePath).catch(() => {}); } });
    current.on('ready', () => {
      if (!valid() || ['error', 'logging_out'].includes(state)) return;
      clearConnectionTimer();
      problem = null;
      qrBuffer = null;
      const wid = current.info?.wid;
      const id = wid?._serialized ?? (wid ? `${wid.user}@${wid.server}` : '');
      linkedNumber = phoneNumberFromWhatsAppId(id);
      change('ready');
      log.log('WhatsApp ready.');

      if (/^\d+@lid$/.test(id)) {
        void current.getContactLidAndPhone([id]).then(([contact]) => {
          if (!valid() || state !== 'ready' || current.info?.wid !== wid) return;
          linkedNumber = phoneNumberFromWhatsAppId(contact?.pn);
          if (linkedNumber) events.emit('change');
        }).catch(() => {});
      }
    });
    current.on('auth_failure', () => { if (valid()) { clearConnectionTimer();change('auth_failure'); } });
    current.on('disconnected', reason => {
      if (['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE'].includes(reason)) loggedOut();
      else if (valid() && state !== 'logging_out') { clearConnectionTimer();qrBuffer = null;change('disconnected'); }
    });
    initialization = current.initialize().catch(error => { if (valid() && state !== 'logging_out') { clearConnectionTimer();problem = 'initialization_failed';change('error');log.error('WhatsApp startup failed:', error.message); } });
  }
  function start({ clientId = legacyWhatsAppClientId } = {}) {
    return lifecycle(async () => {
      if (!enabled || closed) return;
      try { await begin(clientId); }
      catch (error) { clearConnectionTimer();problem = 'initialization_failed';change('error');log.error('WhatsApp connection failed:', error.message); }
    });
  }
  function restoreBrowserFrame(error, failedClient, clientId) {
    if (!transientFrameError(error) || closed || client !== failedClient || binding !== clientId) return false;
    if (recovering) return true;
    if (state !== 'ready') return false;
    recovering = true;
    change('starting');
    log.log('Restoring the WhatsApp browser connection.');
    // The Puppeteer page can be stale while Chrome and the login remain valid.
    // Reopen the same LocalAuth profile without remotely logging out.
    void lifecycle(async () => {
      if (closed || client !== failedClient || binding !== clientId || !recovering) return;
      try { await begin(clientId, true); }
      catch {
        clearConnectionTimer();problem = 'initialization_failed';change('error');
        log.error('Could not restore the WhatsApp browser connection.');
      }
    });
    return true;
  }
  async function waitForLoginState() {
    if (['ready', 'qr_required', 'auth_failure'].includes(state)) return;
    await new Promise((resolve, reject) => {
      const changed = () => {
        if (['ready', 'qr_required', 'auth_failure'].includes(state)) { cleanup();resolve(); }
        else if (['error', 'disconnected'].includes(state)) { cleanup();reject(new Error('Cannot verify WhatsApp logout.')); }
      };
      const timer = setTimeout(() => { cleanup();reject(new Error('WhatsApp logout connection timed out.')); }, logoutTimeoutMs);
      const cleanup = () => { clearTimeout(timer);events.off('change', changed); };
      events.on('change', changed);changed();
    });
  }
  function logout({ clientId = binding || legacyWhatsAppClientId } = {}) {
    return lifecycle(async () => {
      const profilePath = path.join(authPath, 'session-' + clientId);
      if (!/^[\w-]{1,100}$/.test(clientId)) throw new Error('Invalid WhatsApp client identity.');
      if (binding !== clientId || !client || ['error', 'disconnected'].includes(state)) {
        if (!await exists(profilePath)) { await dispose();binding = null;change(enabled ? 'idle' : 'disabled');return; }
        await begin(clientId);
      }
      await waitForLoginState();
      const needsLogout = state === 'ready';change('logging_out');
      if (needsLogout) {
        let timeout;
        try { await Promise.race([client.logout(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('WhatsApp logout timed out.')), logoutTimeoutMs); })]); }
        catch (error) { change('error');throw error; }
        finally { clearTimeout(timeout); }
      }
      // A displayed QR/auth failure means there is no authenticated sender.
      // Local credentials are removed only after remote logout or that check.
      await dispose();await rm(profilePath, { recursive: true, force: true });
      binding = null;change(enabled ? 'idle' : 'disabled');
    });
  }
  async function stop() { closed = true;await lifecycle(async () => { await dispose();change('stopped'); }); }
  function senderKey() {
    const wid = client?.info?.wid;
    const id = wid?._serialized ?? (wid?.user && wid?.server ? `${wid.user}@${wid.server}` : '');
    return !closed && state === 'ready' && id
      ? createHash('sha256').update(id.replace(/:\d+@/, '@').replace(/@s\.whatsapp\.net$/, '@c.us')).digest('hex')
      : null;
  }
  function inboxMessage(message) {
    const key = message?.id;
    let id = key?._serialized;
    if (!id && typeof key?.fromMe === 'boolean' && typeof key.id === 'string' && key.id) {
      // Newer WhatsApp Web models expose the key's parts without _serialized.
      const remote = typeof key.remote === 'string' ? key.remote : key.remote?._serialized;
      if (remote) id = `${key.fromMe}_${remote}_${key.id}`;
    }
    if (!id || !Number.isFinite(message.timestamp)) return null;
    return {
      id, sentAt: new Date(message.timestamp * 1000), outgoing: message.fromMe,
      body: message.body || (message.hasMedia ? 'Media attachment' : 'WhatsApp message'),
    };
  }
  async function openChat(phone, expectedBinding) {
    const current = client;
    const key = senderKey();
    const assertCurrent = () => {
      if (!key || client !== current || binding !== expectedBinding || senderKey() !== key) {
        throw new ApiError(409, 'The WhatsApp sender changed. Reopen the conversation before replying.');
      }
    };
    const usePage = async work => {
      assertCurrent();
      try { return await work(); }
      catch (error) {
        restoreBrowserFrame(error, current, expectedBinding);
        throw error;
      }
    };
    const recipient = await usePage(() => current.getNumberId(phone.slice(1)));
    assertCurrent();
    if (!/^\d+@(?:c\.us|lid|s\.whatsapp\.net)$/.test(recipient?._serialized)) {
      throw new Error('WhatsApp contact is unavailable');
    }
    let chat = await usePage(() => current.getChatById(recipient._serialized).catch(error => {
      if (transientFrameError(error)) throw error;
      return null;
    }));
    assertCurrent();
    if (!chat) {
      // Some WhatsApp Web builds fail to serialize the full chat model even
      // when its messages are readable. Use the raw direct chat's ID with the
      // library's Chat class, which fetches messages without that serializer.
      const directId = await usePage(() => current.pupPage.evaluate(async id => {
        const raw = await window.WWebJS.getChat(id, { getAsModel: false });
        return raw && !raw.groupMetadata ? raw.id?._serialized : null;
      }, recipient._serialized));
      if (/^\d+@(?:c\.us|lid|s\.whatsapp\.net)$/.test(directId)) {
        const { Chat } = require('whatsapp-web.js');
        chat = new Chat(current, { id: { _serialized: directId }, isGroup: false });
      }
    }
    assertCurrent();
    if (!chat || chat.isGroup) throw new Error('WhatsApp conversation is unavailable');
    const chatId = chat.id._serialized;
    return {
      senderKey: key,
      assertCurrent,
      async history(limit) {
        const messages = await usePage(() => chat.fetchMessages({ limit }));
        assertCurrent();
        return messages.map(inboxMessage).filter(Boolean).sort((a, b) => a.sentAt - b.sentAt);
      },
      async findOutgoing(id) {
        const message = await usePage(() => current.getMessageById(id));
        assertCurrent();
        if (message?.fromMe && (message.to === chatId || message.to === recipient._serialized)) return inboxMessage(message);
        return null;
      },
      reply: body => usePage(async () => {
        if (!clientFactory) await restoreWhatsAppMessageKey(current.pupPage);
        assertCurrent();
        // A send is never retried after an ambiguous browser failure.
        return inboxMessage(await current.sendMessage(chatId, body, { sendSeen: false, waitUntilMsgSent: true }));
      }),
    };
  }
  return { enabled, status: () => ({ enabled, state, ...(recovering ? { recovering: true } : {}) }), binding: () => binding,
    senderKey, openChat,
    senderNumber: () => !closed && client && state === 'ready' ? linkedNumber : null,
    setupStatus: () => ({ enabled, state, qrVersion, qrAvailable: !!qrBuffer, problem }),
    qr: () => state === 'qr_required' ? qrBuffer : null,
    onChange: callback => { events.on('change', callback);return () => events.off('change', callback); }, start, logout, stop,
    lookup: number => client.getNumberId(number), send: (recipient, message) => client.sendMessage(recipient._serialized, message),
  };
}
