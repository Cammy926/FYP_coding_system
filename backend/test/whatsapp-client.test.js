import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stabilizeWhatsAppClient, recoverWhatsAppBrowser, restoreWhatsAppMessageKey } from '../whatsapp-client.js';

const until = async condition => { for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Readiness did not settle'); };
function fixture({ synced=true, connected=true, partialBinding=false, failure, transientFailures=0, standalone=false }={}) {
  const socket={hasSynced:synced,state:connected?'CONNECTED':'OPENING'},location={pathname:standalone?'/login/':'/'},login={qr:'a'.repeat(130)+',noise,identity,secret,platform',available:!standalone};
  const window={require:()=>login.available?{Socket:socket}:null},document={querySelector:()=>login.qr?{getAttribute:()=>login.qr}:null},page=new EventEmitter(),errors=[];
  let calls=0,exposes=0,current=true,logouts=0;
  page.evaluate=async(fn,...args)=>vm.runInNewContext('('+fn.toString()+')(...args)',{window,location,document,args});
  page.isClosed=()=>false;page.mainFrame=()=>page;
  page.url=()=>`https://web.whatsapp.com${location.pathname}`;
  page.exposeFunction=async(name,callback)=>{
    exposes++;if(partialBinding)window[name]=callback;
    if(exposes<=transientFailures)throw new Error('Protocol error (Runtime.addBinding): Target closed');
    window[name]=callback;
  };
  const client=new EventEmitter();Object.assign(client,{pupPage:page,pupBrowser:{close:async()=>{}},authStrategy:{afterBrowserInitialized:async()=>{}},inject:async()=>{
    if(!window.onAppStateHasSyncedEvent)await page.exposeFunction('onAppStateHasSyncedEvent',async()=>{calls++;if(failure)throw failure;client.emit('ready');});
  }});
  const qrEvents=[];client.on('qr',value=>qrEvents.push(value));
  stabilizeWhatsAppClient(client,{isCurrent:()=>current,onError:e=>errors.push(e),onLoggedOut:()=>logouts++,retryDelayMs:1,loginPollMs:5});
  return {client,page,window,socket,errors,location,login,qrEvents,calls:()=>calls,exposes:()=>exposes,logouts:()=>logouts,cancel:()=>{current=false;page.emit('close');}};
}

test('restored WhatsApp sessions replay a missed sync through the full library callback once',async()=>{
  const f=fixture();await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();await until(()=>f.calls()===1);
  await f.window.onAppStateHasSyncedEvent();await f.client.inject();assert.equal(f.calls(),1);assert.deepEqual(f.errors,[]);
  f.page.emit('framenavigated',f.page);await f.client.inject();await until(()=>f.calls()===2);
});
test('sync changes do not finalize an unready or obsolete WhatsApp client',async()=>{
  const f=fixture({synced:false});await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();await f.window.onAppStateHasSyncedEvent();assert.equal(f.calls(),0);
  f.socket.hasSynced=true;f.socket.state='OPENING';await f.window.onAppStateHasSyncedEvent();assert.equal(f.calls(),0);
  f.socket.state='CONNECTED';f.cancel();await f.window.onAppStateHasSyncedEvent();assert.equal(f.calls(),0);
});
test('transient iframe binding failures retry, including a binding already registered in the main frame',async()=>{
  for(const partialBinding of [false,true]){
    const f=fixture({transientFailures:1,partialBinding});await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();await until(()=>f.calls()===1);
    assert.equal(f.exposes(),partialBinding?1:2);assert.deepEqual(f.errors,[]);
  }
});
test('readiness callback failures surface as a recoverable connection error',async()=>{
  const failure=new Error('injected runtime unavailable'),f=fixture({failure});await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();await until(()=>f.errors.length===1);
  assert.equal(f.errors[0],failure);
  const exhausted=fixture({transientFailures:5});await exhausted.client.authStrategy.afterBrowserInitialized();await assert.rejects(exhausted.client.inject(),/Target closed/);assert.equal(exhausted.exposes(),5);
});

test('fresh standalone WhatsApp login publishes and refreshes QR without a Socket module, then initializes after scan',async()=>{
  const f=fixture({standalone:true});
  try {
    await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();
    assert.deepEqual(f.qrEvents,[f.login.qr]);assert.equal(f.calls(),0);assert.deepEqual(f.errors,[]);
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.qrEvents.length,1);
    f.login.qr='b'.repeat(130)+',noise,identity,secret,platform';await until(()=>f.qrEvents.length===2);
    f.login.qr=null;f.login.available=true;f.location.pathname='/';f.page.emit('framenavigated',f.page);
    await until(()=>f.calls()===1);assert.deepEqual(f.errors,[]);
    await f.client.inject();assert.equal(f.calls(),1);
  } finally {f.cancel();}
});

test('phone logout returns a fresh QR and reconnects without destructive old navigation callbacks',async()=>{
  const f=fixture();let oldLogoutCalls=0;
  try {
    await f.client.authStrategy.afterBrowserInitialized();await f.client.inject();await until(()=>f.calls()===1);
    await f.page.exposeFunction('onLogoutEvent',()=>{oldLogoutCalls++;throw new Error('Unsafe profile deletion');});
    await f.page.exposeFunction('onAppStateChangedEvent',()=>{oldLogoutCalls++;});
    f.page.on('framenavigated',async frame=>{if(frame.url().includes('post_logout=1')){oldLogoutCalls++;throw new Error('Unsafe profile deletion');}await f.client.inject();});
    await f.window.onAppStateChangedEvent('UNPAIRED');await f.window.onLogoutEvent();
    f.login.available=false;f.location.pathname='/login/?post_logout=1';f.page.emit('framenavigated',f.page);
    await until(()=>f.qrEvents.length===1);assert.ok(f.logouts()>0);assert.equal(oldLogoutCalls,0);assert.deepEqual(f.errors,[]);
    f.login.qr=null;f.login.available=true;f.location.pathname='/';f.page.emit('framenavigated',f.page);
    await until(()=>f.calls()===2);assert.deepEqual(f.errors,[]);assert.equal(oldLogoutCalls,0);
  }finally{f.cancel();}
});

test('browser recovery closes only a browser using the exact managed WhatsApp profile',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'fyp-orphan-'));let closed=0,disconnected=0;
  try {
    assert.equal(await recoverWhatsAppBrowser(directory),false);
    await writeFile(path.join(directory,'DevToolsActivePort'),'54321\n/devtools/browser/test-browser\n');
    const connect=async()=>({target:()=>({createCDPSession:async()=>({send:async()=>({arguments:['--user-data-dir='+directory]}),detach:async()=>{}})}),close:async()=>{closed++;},disconnect:async()=>{disconnected++;}});
    assert.equal(await recoverWhatsAppBrowser(directory,{connect}),true);assert.equal(closed,1);assert.equal(disconnected,1);
    const unrelated=async()=>({target:()=>({createCDPSession:async()=>({send:async()=>({arguments:['--user-data-dir=/some/other/profile']}),detach:async()=>{}})}),close:async()=>{closed++;},disconnect:async()=>{disconnected++;}});
    await assert.rejects(recoverWhatsAppBrowser(directory,{connect:unrelated}),/does not own/);assert.equal(closed,1);assert.equal(disconnected,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('reply confirmation can look up the exact WhatsApp key when _serialized is absent', async () => {
  class MessageKey {
    constructor(id) { this.id = id; }
    toString() { return this.id; }
  }
  const window = { require: name => {
    assert.equal(name, 'WAWebMsgKey');
    return MessageKey;
  } };
  const page = { evaluate: fn => vm.runInNewContext('(' + fn.toString() + ')()', { window }) };
  const key = new MessageKey('true_contact@lid_providerId');
  const stored = new Map([[String(key), { id: key }]]);
  assert.equal(stored.get(key._serialized), undefined);
  await restoreWhatsAppMessageKey(page);
  await restoreWhatsAppMessageKey(page);
  assert.equal(stored.get(key._serialized).id, key);
  key._serialized = 'native-value';
  assert.equal(key._serialized, 'native-value');
});
