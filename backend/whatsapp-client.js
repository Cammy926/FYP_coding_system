import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const transientFrameError = error =>
  /detached frame|frame was detached|Target closed|Execution context was destroyed|Cannot find context with specified id/i.test(String(error?.message || error));

// Call only while holding the transport's client lock. A previous crashed or
// revoked client may have left Chrome alive with this exact profile locked.
export async function recoverWhatsAppBrowser(profilePath, { connect } = {}) {
  let endpoint;
  try { endpoint = (await readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); }
  catch (error) { if (error.code === 'ENOENT') return false;throw error; }
  const port = Number(endpoint[0]), target = endpoint[1];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(target || '')) return false;
  if (!connect) {
    const require = createRequire(import.meta.url), whatsappRequire = createRequire(require.resolve('whatsapp-web.js'));
    connect = whatsappRequire('puppeteer').connect;
  }
  let browser;
  try {
    browser = await connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${target}`, protocolTimeout: 5000 });
    const session = await browser.target().createCDPSession();
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');await session.detach();
    if (!args.includes('--user-data-dir=' + path.resolve(profilePath))) throw new Error('The previous browser endpoint does not own this WhatsApp profile.');
    await browser.close();return true;
  } catch (error) {
    if (/ECONNREFUSED|ECONNRESET|socket hang up|Unexpected server response: 404/.test(String(error?.message))) return false;
    throw error;
  } finally { await browser?.disconnect(); }
}

// whatsapp-web.js uses newMsgKey._serialized to retrieve the exact result of
// sendMessage. Some WhatsApp Web builds expose that key through toString().
export function restoreWhatsAppMessageKey(page) {
  return page.evaluate(() => {
    const prototype = window.require('WAWebMsgKey')?.prototype;
    if (!prototype || '_serialized' in prototype || prototype.toString === Object.prototype.toString) return;
    const serialize = prototype.toString;
    Object.defineProperty(prototype, '_serialized', {
      configurable: true,
      get() { return serialize.call(this); },
      set(value) {
        // Keep WhatsApp's own value if the constructor supplies one.
        Object.defineProperty(this, '_serialized', { value, writable: true, configurable: true, enumerable: true });
      },
    });
  });
}

// Keep the compatibility workaround on this client's page, rather than editing
// node_modules. In 1.34.7, a disappearing iframe can interrupt exposeFunction;
// a restored session can also finish syncing before the sync listener is added.
export function stabilizeWhatsAppClient(client, { isCurrent, onError, onLoggedOut = () => {}, retryDelayMs = 200, loginPollMs = 500 } = {}) {
  const auth = client.authStrategy;
  const afterBrowserInitialized = auth.afterBrowserInitialized.bind(auth);
  let activePage, syncing, syncFinished = false, documentVersion = 0, injectedVersion = -1, injecting, loginPoll, lastQR;
  let wasReady = false;
  client.on?.('ready', () => { wasReady = true; });
  const loggedOut = () => { if (isCurrent()) { wasReady = false;onLoggedOut();watchLogin(); } };
  const stopLoginPoll = () => { clearInterval(loginPoll);loginPoll = null; };
  function watchLogin() {
    if (loginPoll) return;
    loginPoll = setInterval(() => {
      if (!isCurrent() || activePage?.isClosed()) { stopLoginPoll();return; }
      void client.inject().catch(error => { if (isCurrent()) onError(error); });
    }, loginPollMs);
    loginPoll.unref?.();
  }
  auth.afterBrowserInitialized = async () => {
    await afterBrowserInitialized();
    if (!isCurrent()) { await client.pupBrowser?.close();throw new Error('WhatsApp startup cancelled.'); }
    const page = client.pupPage;
    if (activePage === page) return;
    activePage = page;
    page.once('close', stopLoginPoll);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        documentVersion++;syncing = null;syncFinished = false;lastQR = null;
        if (wasReady && /\/login(?:\/|\?|$)/.test(frame.url())) loggedOut();
        watchLogin();
      }
    });
    // wwebjs otherwise deletes LocalAuth while Chrome still has it open, then
    // continues old navigation callbacks during reconnect. Own that transition
    // here; the native login page can display a new QR in the same browser.
    const pageOn = page.on.bind(page);
    page.on = (event, listener) => event !== 'framenavigated' ? pageOn(event, listener) : pageOn(event, frame => {
      if (!isCurrent() || frame !== page.mainFrame()) return;
      if (client.lastLoggedOut || frame.url().includes('post_logout=1')) { client.lastLoggedOut = false;loggedOut();return; }
      const version = documentVersion;
      void Promise.resolve().then(() => listener(frame)).catch(error => { if (isCurrent() && version === documentVersion) onError(error); });
    });
    const expose = page.exposeFunction.bind(page);
    page.exposeFunction = async (name, callback) => {
      let guarded = callback;
      if (name === 'onLogoutEvent') guarded = () => loggedOut();
      else if (name === 'onAppStateChangedEvent') guarded = state => {
        if (!isCurrent()) return;
        if (['UNPAIRED', 'UNPAIRED_IDLE'].includes(state)) { loggedOut();return; }
        return callback(state);
      };
      else if (name === 'onAppStateHasSyncedEvent') guarded = (...args) => {
        if (!isCurrent() || syncFinished) return;
        if (syncing) return syncing;
        const version = documentVersion;
        syncing = (async () => {
          try {
            const synced = await page.evaluate(() => {
              const socket = window.require('WAWebSocketModel')?.Socket;
              return socket?.state === 'CONNECTED' && socket.hasSynced === true;
            });
            if (!synced || !isCurrent() || version !== documentVersion) return;
            await callback(...args);if (version === documentVersion) syncFinished = true;
          } catch (error) { if (isCurrent() && version === documentVersion) onError(error); }
          finally { if (version === documentVersion) syncing = null; }
        })();
        return syncing;
      };
      for (let attempt = 0; ; attempt++) {
        if (!isCurrent()) throw new Error('WhatsApp startup cancelled.');
        try { return await expose(name, guarded); }
        catch (error) {
          if (!transientFrameError(error) || attempt === 4 || page.isClosed()) throw error;
          await pause(retryDelayMs);
          // Puppeteer may have registered the binding in the main frame before
          // a child frame disappeared. Registering it again would then fail.
          if (await page.evaluate(key => typeof window[key] === 'function', name).catch(() => false)) return;
        }
      }
    };
  };
  const inject = client.inject.bind(client);
  client.inject = async (...args) => {
    if (!isCurrent()) return;
    if (injecting) return injecting;
    const version = documentVersion;
    injecting = (async () => {
      try {
        const page = client.pupPage;
        const login = await page.evaluate(() => {
          let socket;
          try { socket = window.require?.('WAWebSocketModel')?.Socket; } catch {}
          const qr = document.querySelector('[data-ref]')?.getAttribute('data-ref');
          return { socketAvailable: !!socket, standalone: /^\/login(?:\/|$)/.test(location.pathname),
            qr: typeof qr === 'string' && qr.length > 100 && qr.length < 4096 && qr.split(',').length === 5 ? qr : null };
        });
        if (!isCurrent() || version !== documentVersion) return;
        if (!login.socketAvailable) {
          // Current WhatsApp builds use a standalone /login/ page. It already
          // renders the full pairing payload, but has no WAWebSocketModel yet.
          // Read that QR and wait for the authenticated app before wwebjs injects.
          if (login.standalone && login.qr && login.qr !== lastQR) { lastQR = login.qr;client.emit('qr', login.qr); }
          watchLogin();return;
        }
        stopLoginPoll();
        if (injectedVersion !== version) { await inject(...args);injectedVersion = version; }
        if (!isCurrent() || version !== documentVersion || syncFinished || syncing) return;
        // Run the library's full readiness callback; authentication or a
        // connected socket alone is never proof that messaging is ready.
        void page.evaluate(async () => {
          const socket = window.require('WAWebSocketModel')?.Socket;
          if (socket?.state === 'CONNECTED' && socket.hasSynced === true && typeof window.onAppStateHasSyncedEvent === 'function') await window.onAppStateHasSyncedEvent();
        }).catch(error => { if (isCurrent() && version === documentVersion) onError(error); });
      } catch (error) {
        if (isCurrent() && version === documentVersion) throw error;
      }
    })();
    try { await injecting; } finally { injecting = null; }
  };
}
