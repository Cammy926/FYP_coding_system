import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhatsAppTransport } from '../whatsapp.js';

const exists = async p => { try { await access(p);return true; } catch { return false; } };
const until = async condition => { for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Transport state did not settle'); };

test('WhatsApp lifecycle preserves on stop, logs out on Clear, and isolates incident QR callbacks', async () => {
  const root=fileURLToPath(new URL('../../',import.meta.url));await mkdir(path.join(root,'test-results'),{recursive:true});
  const authPath=await mkdtemp(path.join(root,'test-results','wa-auth-'));
  const clients=[];let remoteLinked=false,logouts=0,failLogout=false,transport;
  const clientFactory=options=>{
    const fake=new EventEmitter();fake.options=options;options.authStrategy.setup(fake);
    fake.initialize=async()=>{await options.authStrategy.beforeBrowserInitialized();if(remoteLinked){fake.emit('authenticated');fake.emit('ready');}else fake.emit('qr','isolated QR fixture');};
    fake.destroy=async()=>{};
    fake.logout=async()=>{if(failLogout)throw new Error('offline');remoteLinked=false;logouts++;await options.authStrategy.logout();};
    clients.push(fake);return fake;
  };
  const make=()=>createWhatsAppTransport({authPath,clientFactory,log:{log(){},error(){}},logoutTimeoutMs:500});
  try{
    transport=make();assert.equal(transport.status().state,'idle');assert.equal(clients.length,0);
    await transport.start({clientId:'incident-one'});await until(()=>transport.setupStatus().qrAvailable);assert.ok(transport.qr().length>100);const old=clients.at(-1);
    remoteLinked=true;old.emit('authenticated');old.emit('ready');assert.equal(transport.status().state,'ready');assert.equal(transport.qr(),null);
    await transport.stop();assert.equal(logouts,0);assert.ok(await exists(path.join(authPath,'session-incident-one')));
    transport=make();await transport.start({clientId:'incident-one'});await until(()=>transport.status().state==='ready');
    failLogout=true;await assert.rejects(transport.logout(),/offline/);assert.ok(await exists(path.join(authPath,'session-incident-one')));assert.equal(remoteLinked,true);
    failLogout=false;await transport.logout();assert.equal(logouts,1);assert.equal(remoteLinked,false);assert.equal(transport.status().state,'idle');assert.equal(await exists(path.join(authPath,'session-incident-one')),false);
    await transport.start({clientId:'incident-two'});await until(()=>transport.setupStatus().qrAvailable);assert.equal(transport.binding(),'incident-two');
    old.emit('ready');assert.equal(transport.status().state,'qr_required');
    await transport.logout();assert.equal(logouts,1);assert.equal(transport.binding(),null);assert.equal(transport.qr(),null);assert.equal(await exists(path.join(authPath,'session-incident-two')),false);
  }finally{await transport?.stop();await rm(authPath,{recursive:true,force:true});}
});

test('stalled WhatsApp authentication times out and Retry restarts without discarding login', async () => {
  const root=fileURLToPath(new URL('../../',import.meta.url));await mkdir(path.join(root,'test-results'),{recursive:true});
  const authPath=await mkdtemp(path.join(root,'test-results','wa-timeout-')),clients=[];
  const clientFactory=options=>{
    const fake=new EventEmitter();fake.options=options;options.authStrategy.setup(fake);
    fake.initialize=async()=>{await options.authStrategy.beforeBrowserInitialized();fake.emit('authenticated');};
    fake.destroy=async()=>{};clients.push(fake);return fake;
  };
  const transport=createWhatsAppTransport({authPath,clientFactory,connectionTimeoutMs:100,log:{log(){},error(){}}});
  try{
    await transport.start({clientId:'stalled'});await until(()=>transport.status().state==='authenticated');
    const old=clients[0];await transport.start({clientId:'stalled'});await until(()=>clients.length===2&&transport.status().state==='authenticated');
    assert.ok(await exists(path.join(authPath,'session-stalled')));
    old.emit('ready');assert.equal(transport.status().state,'authenticated');
    await until(()=>transport.status().state==='error');assert.equal(transport.setupStatus().problem,'connection_timeout');
    clients[1].emit('ready');assert.equal(transport.status().state,'error');
    await transport.start({clientId:'stalled'});await until(()=>clients.length===3&&transport.status().state==='authenticated');
    clients[2].emit('ready');assert.equal(transport.status().state,'ready');assert.equal(transport.setupStatus().problem,null);
    clients[2].emit('authenticated');assert.equal(transport.status().state,'ready');
    await new Promise(resolve=>setTimeout(resolve,120));assert.equal(transport.status().state,'ready');
  }finally{await transport.stop();await rm(authPath,{recursive:true,force:true});}
});

test('phone logout can reconnect or Clear an already-unlinked sender without remote logout',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));const authPath=await mkdtemp(path.join(root,'test-results','wa-phone-'));
  const clients=[];let linked=true,remoteLogouts=0;
  const clientFactory=options=>{
    const fake=new EventEmitter();fake.options=options;options.authStrategy.setup(fake);
    fake.info = { wid: { _serialized: '12025550131@c.us' } };
    fake.initialize=async()=>{await options.authStrategy.beforeBrowserInitialized();if(linked){fake.emit('authenticated');fake.emit('ready');}else fake.emit('qr','phone logout QR fixture');};
    fake.destroy=async()=>{};fake.logout=async()=>{remoteLogouts++;};clients.push(fake);return fake;
  };
  const transport=createWhatsAppTransport({authPath,clientFactory,logoutTimeoutMs:500,log:{log(){},error(){}}});
  try{
    await transport.start({clientId:'phone'});await until(()=>transport.status().state==='ready');
    assert.equal(transport.senderNumber(), '+12025550131');
    assert.equal(Object.hasOwn(transport.status(), 'senderNumber'), false);
    linked=false;clients[0].emit('disconnected','LOGOUT');assert.equal(transport.status().state,'disconnected');assert.equal(transport.setupStatus().problem,'logged_out');
    assert.equal(transport.senderNumber(), null);
    await transport.start({clientId:'phone'});await until(()=>transport.setupStatus().qrAvailable);assert.equal(transport.binding(),'phone');
    clients[0].emit('ready');assert.equal(transport.status().state,'qr_required');
    clients[1].info.wid = { _serialized: '123456789012345@lid' };
    clients[1].getContactLidAndPhone = async () => [{ pn: '12025550142@c.us' }];
    linked=true;clients[1].emit('authenticated');clients[1].emit('ready');assert.equal(transport.status().state,'ready');
    assert.equal(transport.senderNumber(), null);
    await until(() => transport.senderNumber() === '+12025550142');
    linked=false;clients[1].emit('disconnected','UNPAIRED');await transport.logout();
    assert.equal(remoteLogouts,0);assert.equal(transport.status().state,'idle');assert.equal(await exists(path.join(authPath,'session-phone')),false);
  }finally{await transport.stop();await rm(authPath,{recursive:true,force:true});}
});


test('inbox reads and replies to the native WhatsApp chat and rejects an old sender connection', async () => {
  const resultsPath = fileURLToPath(new URL('../../test-results/', import.meta.url));
  await mkdir(resultsPath, { recursive: true });
  const authPath = await mkdtemp(path.join(resultsPath, 'wa-inbox-'));
  const sends = [];
  const phoneId = '12025550150@c.us';
  const chatId = '123456789012345@lid';
  const automatic = { id: { _serialized: 'original' }, body: 'Safety notification', to: chatId, fromMe: true, timestamp: 10 };
  const inbound = { id: { _serialized: 'incoming' }, body: 'Is everyone safe?', fromMe: false, timestamp: 11 };
  let client;
  const transport = createWhatsAppTransport({
    authPath, log: { log() {}, error() {} },
    clientFactory(options) {
      client = new EventEmitter();
      client.info = { wid: { _serialized: '12025550131@c.us' } };
      client.initialize = async () => client.emit('ready');
      client.destroy = async () => {};
      client.getNumberId = async number => {
        assert.equal(number, '12025550150');
        return { _serialized: phoneId };
      };
      client.getChatById = async id => {
        assert.equal(id, phoneId);
        return { id: { _serialized: chatId }, fetchMessages: async ({ limit }) => {
          assert.equal(limit, 50);
          return [inbound, automatic];
        } };
      };
      client.getMessageById = async () => automatic;
      client.sendMessage = async (id, body, options) => {
        sends.push({ id, body, options });
        return { id: { _serialized: 'reply' }, body, fromMe: true, timestamp: 12 };
      };
      return client;
    },
  });
  try {
    await transport.start({ clientId: 'inbox-test' });
    const chat = await transport.openChat('+12025550150', 'inbox-test');
    assert.equal(chat.senderKey, transport.senderKey());
    assert.deepEqual((await chat.history(50)).map(message => message.id), ['original', 'incoming']);
    assert.equal((await chat.findOutgoing('original')).body, 'Safety notification');
    assert.equal((await chat.reply('A-101 checked in.')).id, 'reply');
    assert.deepEqual(sends, [{ id: chatId, body: 'A-101 checked in.', options: { sendSeen: false, waitUntilMsgSent: true } }]);
    // The live client can resolve a contact while its full chat serializer
    // fails. The raw ID should still open the native message history.
    client.getChatById = async () => { throw new Error('chat serialization failed'); };
    client.pupPage = { evaluate: async (_work, id, searchOptions) => {
      if (!searchOptions) {
        assert.equal(id, phoneId);
        return chatId;
      }
      assert.equal(id, chatId);
      assert.deepEqual(searchOptions, { limit: 50 });
      return [inbound, automatic].map(message => ({
        ...message, id: { id: message.id._serialized, remote: chatId, fromMe: message.fromMe }, t: message.timestamp,
      }));
    } };
    const recovered = await transport.openChat('+12025550150', 'inbox-test');
    assert.deepEqual((await recovered.history(50)).map(message => [message.id, message.outgoing]),
      [[`true_${chatId}_original`, true], [`false_${chatId}_incoming`, false]]);
    client.emit('disconnected', 'LOGOUT');
    await assert.rejects(recovered.reply('Stale send'), /sender changed/);
    assert.equal(sends.length, 1);
  } finally {
    await transport.stop();
    await rm(authPath, { recursive: true, force: true });
  }
});

test('a detached WhatsApp frame restores the same sender profile and makes the chat readable again', async () => {
  const resultsPath = fileURLToPath(new URL('../../test-results/', import.meta.url));
  await mkdir(resultsPath, { recursive: true });
  const authPath = await mkdtemp(path.join(resultsPath, 'wa-frame-recovery-'));
  const clients = [];
  const chatId = '12025550150@c.us';
  let remoteLogouts = 0;
  let finishRecovery;
  const readyToRecover = new Promise(resolve => { finishRecovery = resolve; });
  const transport = createWhatsAppTransport({
    authPath, log: { log() {}, error() {} },
    clientFactory(options) {
      const client = new EventEmitter();
      const index = clients.push(client);
      client.options = options;
      client.info = { wid: { _serialized: '12025550131@c.us' } };
      client.initialize = async () => {
        if (index > 1) {
          client.emit('authenticated');
          await readyToRecover;
        }
        client.emit('ready');
      };
      client.destroy = async () => {};
      client.logout = async () => { remoteLogouts++; };
      client.getNumberId = async () => {
        if (index === 1) throw new Error("Attempted to use detached Frame 'old-page'.");
        return { _serialized: chatId };
      };
      client.getChatById = async () => ({
        id: { _serialized: chatId },
        fetchMessages: async () => [{ id: { _serialized: 'incoming' }, body: 'Test reply', fromMe: false, timestamp: 12 }],
      });
      return client;
    },
  });
  try {
    await transport.start({ clientId: 'frame-recovery' });
    const senderKey = transport.senderKey();
    const reads = await Promise.allSettled([
      transport.openChat('+12025550150', 'frame-recovery'),
      transport.openChat('+12025550150', 'frame-recovery'),
    ]);
    assert.ok(reads.every(result => result.status === 'rejected'));
    await until(() => clients.length === 2 && transport.status().state === 'authenticated');
    assert.equal(transport.status().recovering, true);
    assert.equal(clients[0].options.authStrategy.clientId, clients[1].options.authStrategy.clientId);
    assert.equal(remoteLogouts, 0);
    finishRecovery();
    await until(() => transport.status().state === 'ready');
    assert.equal(transport.status().recovering, undefined);
    assert.equal(transport.senderKey(), senderKey);
    const chat = await transport.openChat('+12025550150', 'frame-recovery');
    assert.equal((await chat.history(50))[0].id, 'incoming');
  } finally {
    finishRecovery();
    await transport.stop();
    await rm(authPath, { recursive: true, force: true });
  }
});
