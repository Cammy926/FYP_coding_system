import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { connectDatabase, initializeDatabase } from '../backend/db.js';
import { createApp } from '../backend/app.js';
import { renderWhatsAppQR } from '../backend/whatsapp.js';
const require = createRequire('/Users/tamcalix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const projectRequire = createRequire(new URL('../backend/package.json',import.meta.url));
const express = projectRequire('express');
const root=path.resolve(new URL('../',import.meta.url).pathname);
await mkdir(path.join(root,'test-results'),{recursive:true});
const directory=await mkdtemp(path.join(root,'test-results','browser-mongo-'));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const mongoPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const mongo=spawn(path.join(root,'runtime/mongodb/bin/mongod'),['--dbpath',directory,'--bind_ip','127.0.0.1','--port',String(mongoPort),'--quiet','--logpath',path.join(directory,'mongo.log')],{stdio:'ignore'});
let client,server,browser,api;
try {
 let connection;
 for(let i=0;i<40;i++) {try{connection=await connectDatabase(`mongodb://127.0.0.1:${mongoPort}/`,'browser_safety_test');break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
 assert.ok(connection);client=connection.client;
 const db=await initializeDatabase(connection.db);const origins=[];
 const testMessages=[],chatHistory=[],replyMessages=[],waListeners=new Set();let waState='idle',waBinding=null,waVersion=0,waLogouts=0;
 let waNumber = '+12025550131', waRecovering = false;
 const qrImage=await renderWhatsAppQR('FYP browser fixture - not a WhatsApp login');
 const waChange=state=>{waState=state;for(const listener of waListeners)listener();};
 const whatsapp={enabled:true,status:()=>({enabled:true,state:waState,...(waRecovering ? { recovering:true } : {})}),binding:()=>waBinding,setupStatus:()=>({enabled:true,state:waState,qrAvailable:waState==='qr_required',qrVersion:waVersion}),qr:()=>waState==='qr_required'?qrImage:null,
 senderNumber:()=>waState==='ready'?waNumber:null,
 senderKey:()=>waNumber,
 async openChat(phone, binding) {
   const senderKey = waNumber;
   const assertCurrent = () => assert.ok(waBinding === binding && waNumber === senderKey && waState === 'ready');
   const history = () => chatHistory.filter(message => message.phone === phone && message.senderKey === senderKey);
   assertCurrent();
   return {
     senderKey, assertCurrent,
     history: async limit => history().slice(-limit),
     findOutgoing: async id => history().find(message => message.id === id && message.outgoing),
     async reply(body) {
       assertCurrent();
       replyMessages.push({ phone, body });
       const sent = { id: 'reply-' + replyMessages.length, phone, senderKey, body, outgoing: true, sentAt: new Date() };
       chatHistory.push(sent);
       return sent;
     },
   };
 },
 onChange:listener=>{waListeners.add(listener);return()=>waListeners.delete(listener);},start:async({clientId})=>{if(waBinding===clientId&&!['idle','error','authenticated','disconnected','auth_failure'].includes(waState))return;waBinding=clientId;waVersion++;waChange('qr_required');},logout:async()=>{waLogouts++;waBinding=null;waChange('idle');},
 lookup:async number=>({_serialized:number+'@c.us'}),
 async send(recipient, message) {
   testMessages.push({ recipient, message });
   const id = 'browser-test-' + testMessages.length;
   const timestamp = Math.floor(Date.now() / 1000);
   chatHistory.push({
     id, phone: '+' + recipient._serialized.split('@')[0], senderKey: waNumber,
     body: message, outgoing: true, sentAt: new Date(timestamp * 1000),
   });
   return { id: { _serialized: id }, timestamp };
 }};
 api=createApp(db,{origins,rateLimits:false,whatsapp});await api.locals.notifications.start();
 const app=express();app.use((req,res,next)=>req.path.startsWith('/api/')?api(req,res,next):next());app.use(express.static(path.join(root,'frontend/dist')));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;origins.push(base);
 browser=await chromium.launch({channel:'chrome',headless:true});
 const errors=[];
 async function pageFor(username,viewport={width:1280,height:1000}) {
  if (['admin','superadmin'].includes(username)) username += '1';
  const context=await browser.newContext({viewport});const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  await page.getByLabel('Account name').fill(username);await page.getByLabel('Password',{exact:true}).fill(username);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();return {context,page};
 }
 async function refreshAdmin(page) {await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible'});}
 async function dashboard(context) {const response=await context.request.get(base+'/api/dashboard');assert.equal(response.status(),200);return response.json();}
 async function detail(page,unit,status) {await page.getByRole('button',{name:`Unit ${unit}: ${status}`,exact:true}).click();return page.locator('.unit-detail');}
 async function assertReady(locator) {await locator.waitFor({state:'visible'});}
 async function saveEditor(page) {
  const response=page.waitForResponse(r=>r.url()===base+'/api/map'&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await response).status(),200);
  await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='All changes saved');
 }
 async function addMapNote(page,text) {
  await page.getByRole('button',{name:'Text / emoji',exact:true}).click();const p=await canvasPoint(page,.63,.72);await page.mouse.click(p.x,p.y);
  await page.getByLabel('Text or emoji',{exact:true}).fill(text);await page.getByRole('button',{name:'Add note',exact:true}).click();
 }
 const {context:adminContext,page:admin}=await pageFor('superadmin');
 await assertReady(admin.getByRole('heading',{name:'Upload the disaster area map',exact:true}));
 const {page:blocked}=await pageFor('admin');await assertReady(blocked.getByRole('alert'));assert.ok((await blocked.getByRole('alert').innerText()).includes('Only Super Admin'));
 await admin.getByLabel('Disaster map PNG').setInputFiles(path.join(root,'backend/test/fixtures/disaster-map.png'));
 await assertReady(admin.getByRole('heading',{name:'Set up the disaster area',exact:true}));
 await admin.getByLabel('Disaster name',{exact:true}).fill('Map safety test');await admin.getByLabel('Disaster name',{exact:true}).press('Tab');
 async function canvasPoint(page,x,y) {const bounds=await page.locator('.map-workspace .floor-plan').boundingBox();return {x:bounds.x+bounds.width*x,y:bounds.y+bounds.height*y};}
 async function place(page,label,floors,rooms,x,y) {
  await page.getByRole('button',{name:'Building block',exact:true}).click();const point=await canvasPoint(page,x,y);await page.mouse.click(point.x,point.y);
  await page.getByLabel('Block label',{exact:true}).fill(label);await page.getByLabel('Floors in this block',{exact:true}).fill(String(floors));await page.getByLabel('Units per floor',{exact:true}).fill(String(rooms));await page.getByRole('button',{name:'Place block',exact:true}).click();
 }
 await place(admin,'Block D',3,1,.44,.36);await place(admin,'Block A',2,2,.54,.64);
 await admin.getByRole('button',{name:'Pen',exact:true}).click();let p1=await canvasPoint(admin,.30,.2),p2=await canvasPoint(admin,.76,.80);await admin.mouse.move(p1.x,p1.y);await admin.mouse.down();await admin.mouse.move(p2.x,p2.y,{steps:8});await admin.mouse.up();
 await admin.getByRole('button',{name:'Delete selected',exact:true}).click();assert.equal(await admin.locator('.floor-plan polyline').count(),0);
 await admin.getByRole('button',{name:'Boundary',exact:true}).click();p1=await canvasPoint(admin,.28,.12);p2=await canvasPoint(admin,.75,.80);await admin.mouse.move(p1.x,p1.y);await admin.mouse.down();await admin.mouse.move(p2.x,p2.y,{steps:5});await admin.mouse.up();
 await admin.getByRole('button',{name:'Text / emoji',exact:true}).click();let point=await canvasPoint(admin,.70,.35);await admin.mouse.click(point.x,point.y);await admin.getByRole('button',{name:'Insert 🚑',exact:true}).click();await admin.getByRole('button',{name:'Add note',exact:true}).click();
 await admin.getByRole('button',{name:'Initialize',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Connect the WhatsApp sender',exact:true}));
 await admin.getByRole('img',{name:'WhatsApp sender connection QR code'}).waitFor({state:'visible'});
 assert.equal(await admin.getByRole('button',{name:'Clear Setup',exact:true}).count(),0);
 assert.equal((await blocked.request.get(base+'/api/whatsapp/qr?incidentId=old')).status(),401);
 await blocked.getByRole('button',{name:'Sign in',exact:true}).click();await assertReady(blocked.getByRole('alert'));assert.ok((await blocked.getByRole('alert').innerText()).includes('Only Super Admin'));
 await admin.screenshot({path:path.join(root,'test-results','whatsapp-initialization-desktop.png'),fullPage:true});
 await admin.reload();await assertReady(admin.getByRole('heading',{name:'Connect the WhatsApp sender',exact:true}));
 waChange('authenticated');
 await assertReady(admin.getByText('Account linked. Finishing connection…',{exact:true}));
 await admin.getByRole('button',{name:'Retry connection',exact:true}).click();
 await admin.getByRole('img',{name:'WhatsApp sender connection QR code'}).waitFor({state:'visible'});
 assert.equal((await db.collection('incidents').findOne({_id:'current'})).setupComplete,false);
 assert.equal(await admin.getByRole('button',{name:'Clear Setup',exact:true}).count(),0);
 waChange('authenticated');waChange('error');
 await assertReady(admin.getByText('Connection unavailable. Please retry below. Your map and saved login are preserved.',{exact:true}));
 await admin.getByRole('button',{name:'Retry connection',exact:true}).click();
 await admin.getByRole('img',{name:'WhatsApp sender connection QR code'}).waitFor({state:'visible'});
 waChange('authenticated');waChange('ready');
 await assertReady(admin.getByRole('heading',{name:'Map safety test',exact:true}));
 await assertReady(admin.locator('.map-refresh .whatsapp-sender').getByText('+12025550131', { exact: true }));
 assert.equal(await admin.locator('.whatsapp-sender').isDisabled(), true);
 assert.equal(await admin.locator('.whatsapp-sender-dot').evaluate(dot => getComputedStyle(dot).backgroundColor), 'rgb(8, 124, 96)');
 assert.ok(await admin.getByRole('button', { name: 'Refresh', exact: true }).evaluate(button => button.previousElementSibling?.classList.contains('whatsapp-sender')));
 assert.equal((await db.collection('incidents').findOne({_id:'current'})).setupComplete,true);
 const {page:observer}=await pageFor('admin');await assertReady(observer.getByRole('button',{name:'Open Block A',exact:true}));assert.equal(await observer.getByRole('button',{name:'Edit map',exact:true}).count(),0);
 assert.equal(await observer.locator('.whatsapp-sender').count(), 0);
 assert.equal(await db.collection('users').countDocuments(),11);
 const reconnectMap=await db.collection('disaster_maps').findOne({_id:'current'}),reconnectIncident=await db.collection('incidents').findOne({_id:'current'});
 waChange('disconnected');
 await assertReady(admin.locator('.whatsapp-sender').getByText('Not connected', { exact: true }));
 assert.equal(await admin.getByRole('button', { name: 'Reconnect WhatsApp', exact: true }).count(), 0);
 assert.equal(await admin.locator('.whatsapp-sender').isEnabled(), true);
 assert.equal(await admin.locator('.whatsapp-sender-dot').evaluate(dot => getComputedStyle(dot).backgroundColor), 'rgb(186, 66, 66)');
 assert.equal(await admin.getByText('The WhatsApp sender is connected.', { exact: true }).count(), 0);
 const {context:offlineResidentContext,page:offlineResident}=await pageFor('A-101');await assertReady(offlineResident.getByRole('heading',{name:'Are you safe?',exact:true}));await offlineResidentContext.close();
 await admin.screenshot({path:path.join(root,'test-results','whatsapp-sender-disconnected.png'),fullPage:true});
 await admin.locator('.whatsapp-sender-dot').click();await assertReady(admin.getByRole('img',{name:'WhatsApp sender connection QR code'}));await assertReady(admin.getByRole('heading',{name:'Scan to reconnect WhatsApp',exact:true}));
 assert.equal((await db.collection('incidents').findOne({_id:'current'})).setupComplete,true);assert.equal((await dashboard(adminContext)).counts.none,7);
 assert.deepEqual(await db.collection('disaster_maps').findOne({_id:'current'}),reconnectMap);assert.deepEqual(await db.collection('incidents').findOne({_id:'current'}),reconnectIncident);assert.equal(await db.collection('users').countDocuments(),11);
 waNumber = '+12025550142';
 waChange('authenticated');waChange('ready');await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 await assertReady(admin.locator('.whatsapp-sender').getByText('+12025550142', { exact: true }));
 assert.equal(await admin.locator('.whatsapp-sender-dot').evaluate(dot => getComputedStyle(dot).backgroundColor), 'rgb(8, 124, 96)');
 waChange('error');
 await assertReady(admin.locator('.whatsapp-sender').getByText('Not connected', { exact: true }));
 await admin.locator('.whatsapp-sender').focus();
 await admin.keyboard.press('Enter');
 await assertReady(admin.getByRole('heading',{name:'Scan to reconnect WhatsApp',exact:true}));
 await assertReady(admin.getByRole('img',{name:'WhatsApp sender connection QR code'}));
 waChange('authenticated');waChange('ready');
 await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 await assertReady(admin.locator('.whatsapp-sender').getByText('+12025550142', { exact: true }));
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Edit disaster map',exact:true}));
 let editRequests=0;admin.on('request',r=>{if(r.method()==='PATCH'&&r.url()===base+'/api/map')editRequests++;});
 const beforeEdit=(await db.collection('disaster_maps').findOne({_id:'current'})).revision;
 assert.equal(await admin.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await addMapNote(admin,'🍔 Food point');await assertReady(admin.getByText('Unsaved changes',{exact:true}));
 await admin.waitForTimeout(600);await observer.reload();await assertReady(observer.getByRole('button',{name:'Open Block A',exact:true}));
 assert.equal(editRequests,0);assert.equal((await db.collection('disaster_maps').findOne({_id:'current'})).revision,beforeEdit);
 assert.equal(await observer.locator('.map-note').filter({hasText:'🍔 Food point'}).count(),0);
 await admin.getByRole('button',{name:'View disaster map',exact:true}).click();await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 assert.equal(await admin.locator('.map-note').filter({hasText:'🍔 Food point'}).count(),0);assert.equal(editRequests,0);
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await addMapNote(admin,'🍔 Food point');await saveEditor(admin);
 await assertReady(observer.locator('.map-note').filter({hasText:'🍔 Food point'}));
 assert.equal(editRequests,1);assert.equal((await db.collection('disaster_maps').findOne({_id:'current'})).revision,beforeEdit+1);
 await addMapNote(admin,'Unsaved reload note');admin.once('dialog',dialog=>dialog.accept());await admin.reload();await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 assert.equal(await admin.locator('.map-note').filter({hasText:'Unsaved reload note'}).count(),0);assert.equal(editRequests,1);
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await addMapNote(admin,'Unsaved navigation note');
 await admin.locator('.bottom-nav').getByRole('button',{name:'Lost & Found',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Lost & Found',exact:true}));
 await admin.locator('.bottom-nav').getByRole('button',{name:'報平安 · Safety',exact:true}).click();await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 assert.equal(await admin.locator('.map-note').filter({hasText:'Unsaved navigation note'}).count(),0);assert.equal(editRequests,1);
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await addMapNote(admin,'Unsaved logout note');await admin.getByRole('button',{name:'Log out',exact:true}).click();
 await admin.getByLabel('Account name').fill('superadmin1');await admin.getByLabel('Password',{exact:true}).fill('superadmin1');await admin.getByRole('button',{name:'Sign in',exact:true}).click();await assertReady(admin.getByRole('button',{name:'Edit map',exact:true}));
 assert.equal(editRequests,1);assert.equal(await admin.locator('.map-note').filter({hasText:'Unsaved logout note'}).count(),0);
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await addMapNote(admin,'🚑 Aid station');
 await admin.route('**/api/map',async route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary save failure'})}):route.continue(),{times:1});
 await admin.getByRole('button',{name:'Save',exact:true}).click();await assertReady(admin.getByRole('alert'));assert.ok((await admin.getByRole('alert').innerText()).includes('Temporary save failure'));
 assert.equal(await admin.locator('.map-note').filter({hasText:'🚑 Aid station'}).count(),1);assert.equal(await observer.locator('.map-note').filter({hasText:'🚑 Aid station'}).count(),0);
 await admin.getByRole('button',{name:'Retry save',exact:true}).click();await admin.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='All changes saved');await assertReady(observer.locator('.map-note').filter({hasText:'🚑 Aid station'}));
 const {context:staleMapContext,page:staleMap}=await pageFor('superadmin');await staleMap.getByRole('button',{name:'Edit map',exact:true}).click();await addMapNote(staleMap,'Stale map note');
 await admin.getByRole('button',{name:'Edit Block A',exact:true}).click();assert.equal(await admin.getByLabel('Floors in this block',{exact:true}).isDisabled(),true);await admin.getByLabel('Block label',{exact:true}).fill('Block A updated');await admin.getByRole('button',{name:'Place block',exact:true}).click();await saveEditor(admin);await assertReady(observer.getByRole('button',{name:'Open Block A updated',exact:true}));
 await staleMap.getByRole('button',{name:'Save',exact:true}).click();await assertReady(staleMap.getByRole('alert'));assert.ok((await staleMap.getByRole('alert').innerText()).includes('another window'));
 assert.equal((await db.collection('disaster_maps').findOne({_id:'current'})).annotations.some(a=>a.text==='Stale map note'),false);
 await staleMap.getByRole('button',{name:'Reload saved map',exact:true}).click();await assertReady(staleMap.getByRole('button',{name:'Select Block A updated',exact:true}));assert.equal(await staleMap.locator('.map-note').filter({hasText:'Stale map note'}).count(),0);await staleMapContext.close();
 await admin.getByRole('button',{name:'Edit Block A updated',exact:true}).click();await admin.getByLabel('Block label',{exact:true}).fill('Block A');await admin.getByRole('button',{name:'Place block',exact:true}).click();await saveEditor(admin);await assertReady(observer.getByRole('button',{name:'Open Block A',exact:true}));
 await admin.getByRole('button',{name:'Select / move',exact:true}).click();const marker=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();const destination=await canvasPoint(admin,.58,.62);await admin.mouse.move(marker.x+marker.width/2,marker.y+marker.height/2);await admin.mouse.down();await admin.mouse.move(destination.x,destination.y,{steps:6});await admin.mouse.up();
 await saveEditor(admin);await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.left)>57);
 assert.equal(await admin.getByRole('button',{name:'Delete selected',exact:true}).isDisabled(),true);
 await admin.getByRole('button',{name:'Undo',exact:true}).click();await saveEditor(admin);await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.left)<55);
 // Resize the visible label, without touching the building's floor/unit layout.
 await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 const legacyBox=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();
 await admin.getByLabel('Block width (% of map)',{exact:true}).fill('24');await admin.getByLabel('Block width (% of map)',{exact:true}).press('Tab');
 await admin.getByLabel('Block height (% of map)',{exact:true}).fill('12');await admin.getByLabel('Block height (% of map)',{exact:true}).press('Tab');
 await saveEditor(admin);await observer.waitForFunction(()=>document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.width==='24%');
 const expanded=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(expanded.width>legacyBox.width*1.5);assert.ok(expanded.height>legacyBox.height);
 const handle=await admin.getByRole('button',{name:'Resize Block A',exact:true}).boundingBox();await admin.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await admin.mouse.down();await admin.mouse.move(handle.x+handle.width/2-55,handle.y+handle.height/2-15,{steps:6});await admin.mouse.up();
 const shrunk=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(shrunk.width<expanded.width-40);assert.ok(shrunk.height<expanded.height-10);
 await admin.getByRole('button',{name:'Resize Block A',exact:true}).focus();await admin.keyboard.press('ArrowRight');
 await saveEditor(admin);await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.width)<23);
 // Click the label body away from the handle and verify it still moves.
 const beforeMove=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();await admin.mouse.move(beforeMove.x+beforeMove.width/2,beforeMove.y+beforeMove.height/2);await admin.mouse.down();await admin.mouse.move(beforeMove.x+beforeMove.width/2+12,beforeMove.y+beforeMove.height/2+8,{steps:4});await admin.mouse.up();
 await saveEditor(admin);
 const savedMap=(await (await adminContext.request.get(base+'/api/map')).json()).map;const markerSize=savedMap.annotations.find(a=>a.type==='block'&&a.building===1);
 assert.ok(markerSize.w>.04&&markerSize.h>.03);assert.deepEqual(savedMap.blocks.map(b=>[b.floors,b.rooms]),[[3,1],[2,2]]);assert.equal(await db.collection('users').countDocuments(),11);
 await admin.screenshot({path:path.join(root,'test-results','block-resize-editor.png'),fullPage:true});
 await admin.reload();await admin.getByRole('button',{name:'Edit map',exact:true}).click();await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 const reloaded=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(Math.abs(reloaded.width-markerSize.w*(await admin.locator('.map-workspace .floor-plan').boundingBox()).width)<2);
 // Change only the words' size, retain the existing block dimensions and layout.
 const fontInput=admin.getByLabel('Label font size (px)',{exact:true});
 const labelGeometry=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();
 await fontInput.fill('28');await fontInput.press('Tab');
 await saveEditor(admin);await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='28px');
 assert.equal(await admin.getByRole('button',{name:'Select Block A',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'28px');
 assert.equal(await observer.getByRole('button',{name:'Open Block D',exact:true}).evaluate(el=>el.style.fontSize),'');
 const afterFont=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(Math.abs(afterFont.width-labelGeometry.width)<1);assert.ok(Math.abs(afterFont.height-labelGeometry.height)<1);
 await fontInput.fill('16');await fontInput.press('Tab');await saveEditor(admin);await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='16px');
 await admin.getByRole('button',{name:'Undo',exact:true}).click();await saveEditor(admin);await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='28px');
 await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 await fontInput.fill('');await fontInput.press('Tab');await saveEditor(admin);await observer.waitForFunction(()=>document.querySelector('[aria-label="Open Block A"]').style.fontSize==='');
 await fontInput.fill('24');await fontInput.press('Tab');await saveEditor(admin);await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='24px');
 const fontMap=(await(await adminContext.request.get(base+'/api/map')).json()).map;const fontMarker=fontMap.annotations.find(a=>a.type==='block'&&a.building===1);assert.equal(fontMarker.fontSize,24);assert.equal(fontMarker.w,markerSize.w);assert.equal(fontMarker.h,markerSize.h);
 await admin.reload();await admin.getByRole('button',{name:'Edit map',exact:true}).click();await admin.getByRole('button',{name:'Select Block A',exact:true}).click();assert.equal(await admin.getByLabel('Label font size (px)',{exact:true}).inputValue(),'24');
 assert.equal(await admin.getByRole('button',{name:'Select Block A',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'24px');
 await admin.screenshot({path:path.join(root,'test-results','building-label-font-size.png'),fullPage:true});
 await admin.screenshot({path:path.join(root,'test-results','map-editor-desktop.png'),fullPage:true});
 await admin.getByRole('button',{name:'View disaster map',exact:true}).click();
 await admin.screenshot({path:path.join(root,'test-results','map-view-desktop.png'),fullPage:true});
 await observer.setViewportSize({width:390,height:844});await observer.reload();await assertReady(observer.locator('.map-note').filter({hasText:'🍔 Food point'}));assert.equal(await observer.locator('.topbar').count(),1);await observer.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await observer.screenshot({path:path.join(root,'test-results','map-view-mobile.png'),fullPage:true});
 await admin.getByRole('button',{name:'Open Block A',exact:true}).click();
 const downloadPromise=admin.waitForEvent('download');await admin.getByRole('button',{name:'Unit accounts',exact:true}).click();
 const accountDownload=await downloadPromise;const csv=await readFile(await accountDownload.path(),'utf8');
 assert.ok(csv.includes('"A-101","A-101","A","1","1"'));assert.ok(csv.includes('"D-201","D-201","D","2","1"'));assert.ok(!csv.includes('B-'));
 assert.equal(await admin.getByRole('button',{name:'Unit D-101: No response',exact:true}).count(),0);
 const {context:safeContext,page:safe}=await pageFor('A-101',{width:390,height:844});
 await assertReady(safe.getByRole('heading',{name:'Are you safe?',exact:true}));
 assert.equal(await safe.locator('.status-choices button').count(),2);assert.equal(await safe.locator('main input, main textarea').count(),0);
 assert.ok((await safe.getByRole('button',{name:'Safe',exact:true}).boundingBox()).height>=150);
 await safe.screenshot({path:path.join(root,'test-results','resident-choice-mobile.png'),fullPage:true});
 await safe.getByRole('button',{name:'Safe',exact:true}).click();
 await assertReady(safe.getByLabel(/Family member’s WhatsApp phone number/));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:1,help:0,none:6});
 await refreshAdmin(admin);const safeDetail=await detail(admin,'A-101','Safe');assert.ok((await safeDetail.innerText()).includes('N/A'));
 await safe.getByRole('button',{name:'Submit',exact:true}).click();
 await assertReady(safe.getByRole('heading',{name:'Remain in a safe area',exact:true}));
 assert.equal(await safe.getByRole('link',{name:'In an emergency, call 999'}).getAttribute('href'),'tel:999');
 assert.ok((await safe.locator('.report-confirmation').innerText()).includes('Please keep calm and remain in a safe area.'));
 await safe.screenshot({path:path.join(root,'test-results','safe-confirmation-mobile.png'),fullPage:true});
 const {context:helpContext,page:help}=await pageFor('A-102');
 await help.getByRole('button',{name:'I need help',exact:true}).click();
 await assertReady(help.getByRole('heading',{name:'What injuries do you have?',exact:true}));
 assert.equal(await help.locator('.injury-choices button').count(),4);assert.equal(await help.locator('main input, main textarea').count(),0);
 for(const text of ['Cuts, wounds or bleeding.','A broken bone or injured joint.','Skin hurt by fire, heat or hot water.','Breathed in smoke.']) assert.ok((await help.locator('.injury-step').innerText()).includes(text));
 await observer.setViewportSize({width:1280,height:1000});await observer.getByRole('button',{name:'Open Block A',exact:true}).click();
 const helpCellBeforeDetails=admin.getByRole('button',{name:'Unit A-102: Needs help',exact:true});
 const observerCell=observer.getByRole('button',{name:'Unit A-102: Needs help',exact:true});
 await help.getByRole('button',{name:'Wounds & bleeding',exact:true}).click();
 await help.waitForFunction(()=>document.querySelector('[aria-label="Wounds & bleeding"]').getAttribute('aria-pressed')==='true');
 await helpCellBeforeDetails.locator('[data-injury="bleeding"]').waitFor({state:'visible',timeout:2000});
 await observerCell.locator('[data-injury="bleeding"]').waitFor({state:'visible',timeout:2000});
 assert.equal(await admin.locator('.injury-count[data-injury="bleeding"] strong').innerText(),'1');
 // Hold an older background poll while a newer injury choice saves.
 const staleReport=(await(await helpContext.request.get(base+'/api/reports/mine')).json()).report;
 let releasePoll,markPollStarted;const pollHeld=new Promise(resolve=>markPollStarted=resolve),pollRelease=new Promise(resolve=>releasePoll=resolve);
 await help.route('**/api/reports/mine',async route=>{markPollStarted();await pollRelease;await route.fulfill({json:{report:staleReport}});});
 await Promise.race([pollHeld,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Resident poll did not start')),7000))]);
 await help.getByRole('button',{name:'Fractures / dislocations',exact:true}).click();
 await help.waitForFunction(()=>document.querySelector('[aria-label="Fractures / dislocations"]').getAttribute('aria-pressed')==='true');
 const staleResponse=help.waitForResponse(response=>response.url().endsWith('/api/reports/mine')&&response.request().method()==='GET');releasePoll();await staleResponse;
 await help.unroute('**/api/reports/mine');await help.waitForFunction(()=>!document.querySelector('.injury-step button:disabled'));
 assert.equal(await help.getByRole('button',{name:'Fractures / dislocations',exact:true}).getAttribute('aria-pressed'),'true');
 // A failed tap stays on this step, keeps saved choices, and can be retried.
 await help.route('**/api/reports/mine/injuries',route=>route.fulfill({status:503,json:{error:'Temporary save problem. Please try again.'}}),{times:1});
 await help.getByRole('button',{name:'Burns / scalds',exact:true}).click();await assertReady(help.getByRole('alert'));
 assert.equal(await help.getByRole('button',{name:'Burns / scalds',exact:true}).getAttribute('aria-pressed'),'false');
 assert.equal(await help.getByRole('button',{pressed:true}).count(),2);await help.getByRole('button',{name:'Dismiss error',exact:true}).click();
 for(const name of ['Burns / scalds','Smoke inhalation']) {
   await help.getByRole('button',{name,exact:true}).click();await help.waitForFunction(()=>!document.querySelector('.injury-step button:disabled'));
 }
 assert.equal(await help.getByRole('button',{pressed:true}).count(),4);
 for(const [name,id] of [['Burns / scalds','burns'],['Smoke inhalation','smoke_inhalation']]) {
   await help.getByRole('button',{name,exact:true}).click();
   await help.waitForFunction(label=>document.querySelector(`[aria-label="${label}"]`).getAttribute('aria-pressed')==='false',name);
   await admin.waitForFunction(injury=>document.querySelector(`.injury-count[data-injury="${injury}"] strong`).textContent==='0',id);
 }
 assert.equal(await help.getByRole('button',{pressed:true}).count(),2);
 await help.screenshot({path:path.join(root,'test-results','injury-selection-desktop.png'),fullPage:true});
 await help.setViewportSize({width:390,height:844});await help.reload();
 await assertReady(help.getByRole('heading',{name:'What injuries do you have?',exact:true}));
 assert.equal(await help.getByRole('button',{name:'Wounds & bleeding',exact:true}).getAttribute('aria-pressed'),'true');
 assert.equal(await help.getByRole('button',{name:'Fractures / dislocations',exact:true}).getAttribute('aria-pressed'),'true');
 assert.ok(await help.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await help.screenshot({path:path.join(root,'test-results','injury-selection-mobile.png'),fullPage:true});
 await help.getByRole('button',{name:'Continue',exact:true}).click();await assertReady(help.getByLabel(/What is happening/));
 await help.reload();await assertReady(help.getByLabel(/What is happening/));
 await help.getByRole('button',{name:'Change injury selection',exact:true}).click();await assertReady(help.getByRole('heading',{name:'What injuries do you have?',exact:true}));
 await help.getByRole('button',{name:'Continue',exact:true}).click();await assertReady(help.getByLabel(/What is happening/));
 await help.setViewportSize({width:1280,height:1000});
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:1,help:1,none:5});
 await admin.getByRole('button',{name:'Unit A-102: Needs help',exact:true}).waitFor({state:'visible'});const helpDetail=await detail(admin,'A-102','Needs help');assert.equal((await helpDetail.locator('dd').allTextContents()).filter(s=>s==='N/A').length,3);
 await help.getByLabel(/What is happening/).fill('Two people cannot walk');await help.getByLabel(/Where are you now/).fill('Building A third-floor stairwell');await help.getByLabel(/Your phone number/).fill('+852 9123 4567');
 // Background refresh must not replace the in-progress optional form.
 await help.waitForResponse(response=>response.url().endsWith('/api/reports/mine')&&response.request().method()==='GET',{timeout:10000});
 assert.equal(await help.getByLabel(/Where are you now/).inputValue(),'Building A third-floor stairwell');
 await help.screenshot({path:path.join(root,'test-results','help-details-desktop.png'),fullPage:true});
 await help.getByRole('button',{name:'Submit',exact:true}).click();
 await assertReady(help.getByRole('heading',{name:'Please stay calm',exact:true}));
 assert.equal(await help.getByRole('link',{name:'In an emergency, call 999'}).getAttribute('href'),'tel:999');
 await refreshAdmin(admin);const complete=await detail(admin,'A-102','Needs help');
 assert.ok((await complete.innerText()).includes('Two people cannot walk'));assert.ok((await complete.innerText()).includes('Building A third-floor stairwell'));assert.ok((await complete.innerText()).includes('+85291234567'));
 const {context:blankContext,page:blank}=await pageFor('D-201',{width:390,height:844});
 // Leave immediately after the click, before submitting or seeing the form.
 await blank.getByRole('button',{name:'I need help',exact:true}).click();await blank.close();
 let saved;
 for(let i=0;i<40;i++){saved=await db.collection('safety_reports').findOne({username:'D-201'});if(saved)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(saved);assert.equal(saved.status,'help');assert.equal(saved.detailsSubmittedAt,null);
 const firstResume=await blankContext.newPage();await firstResume.goto(base);await assertReady(firstResume.getByRole('heading',{name:'What injuries do you have?',exact:true}));
 await firstResume.getByRole('button',{name:'Smoke inhalation',exact:true}).click();await firstResume.close();
 for(let i=0;i<40;i++){saved=await db.collection('safety_reports').findOne({username:'D-201'});if(saved.injuries?.includes('smoke_inhalation'))break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.deepEqual(saved.injuries,['smoke_inhalation']);assert.equal(saved.detailsSubmittedAt,null);assert.equal(saved.situation,'');
 const resumed=await blankContext.newPage();await resumed.goto(base);await assertReady(resumed.getByRole('heading',{name:'What injuries do you have?',exact:true}));
 assert.equal(await resumed.getByRole('button',{name:'Smoke inhalation',exact:true}).getAttribute('aria-pressed'),'true');
 await resumed.getByRole('button',{name:'Continue',exact:true}).click();await assertReady(resumed.getByLabel(/What is happening/));
 assert.equal(await resumed.locator('main [required]').count(),0);
 await resumed.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(resumed.getByRole('heading',{name:'Please stay calm',exact:true}));
 await admin.getByRole('button',{name:'Back to disaster map',exact:true}).click();await admin.getByRole('button',{name:'Open Block D',exact:true}).click();
 await refreshAdmin(admin);const blankDetail=await detail(admin,'D-201','Needs help');assert.equal((await blankDetail.locator('dd').allTextContents()).filter(s=>s==='N/A').length,3);
 await admin.screenshot({path:path.join(root,'test-results','admin-blank-help-desktop.png'),fullPage:true});
 const {page:phoneSafe}=await pageFor('A-201');await phoneSafe.getByRole('button',{name:'Safe',exact:true}).click();await assertReady(phoneSafe.getByLabel(/Family member’s WhatsApp phone number/));
 await phoneSafe.getByLabel(/Family member’s WhatsApp phone number/).fill('+852 9234 5678');await phoneSafe.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(phoneSafe.getByRole('heading',{name:'Remain in a safe area',exact:true}));
 await phoneSafe.waitForFunction(()=>document.querySelector('.notification-state')?.dataset.notificationStatus==='sent',{},{timeout:10000});
 assert.equal(await phoneSafe.locator('.notification-state').innerText(),'Notification sent to WhatsApp. Please keep calm and remain in a safe area.');
 assert.equal(await phoneSafe.locator('.report-confirmation > p').count(),1);
 assert.equal(testMessages.length,1);assert.equal(testMessages[0].recipient._serialized,'85292345678@c.us');assert.ok(testMessages[0].message.includes('A-201'));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:2,help:2,none:3});
 await safe.reload();await assertReady(safe.getByRole('heading',{name:'Remain in a safe area',exact:true}));assert.equal(await safe.locator('.status-choices').count(),0);
 // The inbox is scoped to the current disaster and the connected sender's chats.
 const incidentId = (await db.collection('incidents').findOne({ _id: 'current' })).incidentId;
 const recipient = '+85292345678';
 const inboxPath = '/api/whatsapp/chats';
 const conversationPath = inboxPath + '/' + encodeURIComponent(recipient);
 const inboxQuery = '?incidentId=' + incidentId;
 const phoneContext = phoneSafe.context();
 assert.equal((await phoneContext.request.get(base + inboxPath + inboxQuery)).status(), 403);
 assert.equal(await phoneSafe.getByRole('button', { name: 'WhatsApp Inbox' }).count(), 0);
 const firstMessage = chatHistory[0];
 chatHistory.unshift({ ...firstMessage, id: 'older-chat', body: 'Unrelated earlier conversation', outgoing: false,
   sentAt: new Date(firstMessage.sentAt.getTime() - 1000) });
 const { page: replyingAdmin, context: replyingContext } = await pageFor('admin2', { width: 390, height: 844 });
 await replyingAdmin.getByRole('button', { name: 'WhatsApp Inbox' }).click();
 const chatButton = replyingAdmin.getByRole('button', { name: /\+85292345678.*A-201/ });
 await chatButton.click();
 await assertReady(replyingAdmin.getByText('Automatic safety message · Unit A-201', { exact: true }));
 assert.equal(await replyingAdmin.getByText('Unrelated earlier conversation').count(), 0);
 chatHistory.push({ ...firstMessage, id: 'incoming-family', body: 'Which unit has checked in?', outgoing: false,
   sentAt: new Date(firstMessage.sentAt.getTime() + 100) });
 await assertReady(replyingAdmin.getByText('Which unit has checked in?', { exact: true }));
 await replyingAdmin.getByLabel('Reply message').fill('Unit A-201 has checked in.');
 await replyingAdmin.getByRole('button', { name: 'Send reply' }).click();
 await assertReady(replyingAdmin.getByText('Unit A-201 has checked in.', { exact: true }));
 assert.deepEqual(replyMessages, [{ phone: recipient, body: 'Unit A-201 has checked in.' }]);
 const adminChat = await (await replyingContext.request.get(base + conversationPath + inboxQuery)).json();
 assert.ok(adminChat.messages.every(message => !Object.hasOwn(message, 'repliedBy')));
 assert.equal(await replyingAdmin.getByText('Replied by admin2').count(), 0);
 assert.equal((await replyingContext.request.get(base + '/api/whatsapp/qr' + inboxQuery)).status(), 403);
 const malicious = { message: 'Try a different number', requestId: randomUUID(), incidentId };
 assert.equal((await replyingContext.request.post(base + inboxPath + '/%2B12025550199/reply', { data: malicious })).status(), 404);

 const { page: inboxManager, context: inboxManagerContext } = await pageFor('superadmin2');
 await inboxManager.getByRole('button', { name: 'WhatsApp Inbox' }).click();
 await inboxManager.getByRole('button', { name: /\+85292345678.*A-201/ }).click();
 const privateLabel = inboxManager.getByText('Replied by admin2', { exact: true });
 await assertReady(privateLabel);
 assert.ok(await privateLabel.evaluate(label => {
   const time = label.previousElementSibling;
   return time?.tagName === 'TIME' && label.getBoundingClientRect().top >= time.getBoundingClientRect().bottom;
 }));
 // Simulate the provider sending successfully but returning no message ID.
 await db.collection('whatsapp_replies').updateOne({ incidentId, messageId: 'reply-1' }, {
   $set: { state: 'unknown' }, $unset: { messageId: '', sentAt: '' },
 });
 const repaired = await (await inboxManagerContext.request.get(base + conversationPath + inboxQuery)).json();
 assert.equal(repaired.messages.find(message => message.id === 'reply-1').repliedBy, 'admin2');
 assert.equal(repaired.messages.filter(message => message.id === 'reply-1').length, 1);
 assert.equal((await db.collection('whatsapp_replies').findOne({ incidentId, messageId: 'reply-1' })).state, 'sent');
 const afterRepair = await (await replyingContext.request.get(base + conversationPath + inboxQuery)).json();
 assert.ok(afterRepair.messages.every(message => !Object.hasOwn(message, 'repliedBy')));
 await inboxManager.getByLabel('Reply message').fill('Thank you for checking in.');
 await inboxManager.getByRole('button', { name: 'Send reply' }).click();
 await assertReady(inboxManager.getByText('Replied by superadmin2', { exact: true }));
 assert.equal(replyMessages[1].body, 'Thank you for checking in.');
 await inboxManager.screenshot({ path: path.join(root, 'test-results', 'whatsapp-inbox-desktop.png') });

 const duplicate = { message: 'One send only', requestId: randomUUID(), incidentId, repliedBy: 'superadmin1' };
 const duplicateResult = await replyingContext.request.post(base + conversationPath + '/reply', { data: duplicate });
 assert.equal(duplicateResult.status(), 201);
 assert.equal((await replyingContext.request.post(base + conversationPath + '/reply', { data: duplicate })).status(), 201);
 assert.equal(replyMessages.filter(message => message.body === 'One send only').length, 1);
 const audit = await db.collection('whatsapp_replies').findOne({ _id: incidentId + ':' + duplicate.requestId });
 assert.equal(audit.repliedBy, 'admin2');
 const readChat = async () => (await inboxManagerContext.request.get(base + conversationPath + inboxQuery)).json();
 // A legacy notification can anchor history by its original WhatsApp message ID.
 await db.collection('safety_reports').updateOne({ username: 'A-201' }, { $unset: { notificationSenderKey: '', notificationWhatsAppAt: '' } });
 const legacyChat = await readChat();
 assert.equal(legacyChat.messages[0].kind, 'automatic');
 assert.equal(legacyChat.messages[0].unit, 'A-201');
 assert.equal(legacyChat.canReply, true);
 // The provider may send the automatic notification without returning its ID.
 await db.collection('safety_reports').updateOne({ username: 'A-201' }, {
   $set: { notificationSenderKey: firstMessage.senderKey, notificationMessageId: '' },
 });
 const recoveredChat = await readChat();
 assert.equal(recoveredChat.messages[0].id, firstMessage.id);
 assert.equal(recoveredChat.messages[0].kind, 'automatic');
 assert.equal(recoveredChat.messages.filter(message => message.body === firstMessage.body).length, 1);
 assert.ok(recoveredChat.messages.some(message => message.id === 'incoming-family'));
 waNumber = '+12025550133';
 assert.equal((await readChat()).canReply, false);
 waNumber = firstMessage.senderKey;

 // Disconnect and reconnect through the inbox, preserving the active disaster.
 waChange('disconnected');
 await assertReady(replyingAdmin.getByText('Ask a Super Admin to reconnect the sender before you can read or send messages.'));
 assert.equal(await replyingAdmin.getByRole('button', { name: 'Send reply' }).count(), 0);
 assert.equal(await replyingAdmin.getByRole('img', { name: 'WhatsApp sender connection QR code' }).count(), 0);
 await assertReady(inboxManager.getByRole('img', { name: 'WhatsApp sender connection QR code' }));
 waChange('authenticated'); waChange('ready');
 await assertReady(inboxManager.getByRole('heading', { name: 'WhatsApp Inbox' }));
 await inboxManager.getByRole('button', { name: /\+85292345678.*A-201/ }).click();
 await assertReady(inboxManager.getByText('Replied by admin2', { exact: true }).first());
 // Sign out of the app, then reopen the same chat under a fresh session.
 await replyingAdmin.getByRole('button', { name: 'Log out', exact: true }).click();
 await replyingAdmin.getByLabel('Account name').fill('admin2');
 await replyingAdmin.getByLabel('Password', { exact: true }).fill('admin2');
 await replyingAdmin.getByRole('button', { name: 'Sign in', exact: true }).click();
 await replyingAdmin.getByRole('button', { name: 'WhatsApp Inbox' }).click();
 await chatButton.click();
 await assertReady(replyingAdmin.getByText('Unit A-201 has checked in.', { exact: true }));
 waRecovering = true;
 waChange('starting');
 await assertReady(replyingAdmin.getByText('Restoring the WhatsApp connection. The inbox will reload automatically.'));
 await assertReady(inboxManager.getByText('Restoring the WhatsApp connection. The inbox will reload automatically.'));
 assert.equal(await inboxManager.getByRole('img', { name: 'WhatsApp sender connection QR code' }).count(), 0);
 assert.equal(await replyingAdmin.getByRole('button', { name: 'Send reply' }).isDisabled(), true);
 waRecovering = false;
 waChange('ready');
 await inboxManager.getByRole('button', { name: 'Refresh chats' }).click();
 await inboxManager.getByText('Restoring the WhatsApp connection. The inbox will reload automatically.').waitFor({ state: 'hidden' });
 await assertReady(inboxManager.getByText('Replied by admin2', { exact: true }).first());
 await inboxManagerContext.close();
 await replyingContext.close();
 // Desktop navigation is on the left, while phone navigation stays horizontal.
 await admin.getByRole('button',{name:'Back to disaster map',exact:true}).click();await admin.getByRole('button',{name:'Open Block A',exact:true}).click();
 const desktopNav=admin.getByRole('navigation',{name:'Main navigation'});const navBox=await desktopNav.boundingBox();const mainBox=await admin.locator('main').boundingBox();assert.ok(navBox.x+navBox.width<=mainBox.x+1);
 const navButtons=desktopNav.getByRole('button');const firstNav=await navButtons.nth(0).boundingBox(),secondNav=await navButtons.nth(1).boundingBox();assert.ok(secondNav.y>firstNav.y);assert.ok(Math.abs(firstNav.x-secondNav.x)<1);
 const phoneNav=safe.getByRole('navigation',{name:'Main navigation'}).getByRole('button');const phoneFirst=await phoneNav.nth(0).boundingBox(),phoneSecond=await phoneNav.nth(1).boundingBox();assert.ok(phoneSecond.x>phoneFirst.x);assert.ok(Math.abs(phoneFirst.y-phoneSecond.y)<1);
 await observer.setViewportSize({width:1280,height:1000});await observer.reload();await observer.getByRole('button',{name:'Open Block A',exact:true}).click();
 const safeCell=admin.getByRole('button',{name:'Unit A-101: Safe',exact:true}),helpCell=admin.getByRole('button',{name:'Unit A-102: Needs help',exact:true});
 const originalSafeColor=await safeCell.evaluate(el=>getComputedStyle(el).backgroundColor);
 // A normal Admin clears a floor; Super Admin sees it without pressing Refresh.
 await observer.getByRole('button',{name:'Clear floor 1',exact:true}).click();
 await admin.waitForFunction(()=>document.querySelector('.floor-control[data-floor="1"]')?.classList.contains('searched'));
 assert.ok((await admin.locator('.floor-progress').innerText()).includes('1 / 2'));
 assert.ok(await safeCell.evaluate(el=>el.classList.contains('searched')));assert.ok(await helpCell.evaluate(el=>el.classList.contains('searched')));
 await admin.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Unit A-101: Safe"]')).backgroundColor==='rgb(71, 117, 104)');
 assert.notEqual(await safeCell.evaluate(el=>getComputedStyle(el).backgroundColor),originalSafeColor);
 assert.notEqual(await safeCell.evaluate(el=>getComputedStyle(el).backgroundColor),await helpCell.evaluate(el=>getComputedStyle(el).backgroundColor));
 // Keep a second editor open with an old revision, then change the same floor.
 await observer.getByRole('button',{name:'Edit search status for floor 2',exact:true}).click();
 await admin.getByRole('button',{name:'Edit search status for floor 2',exact:true}).click();let dialog=admin.getByRole('dialog',{name:'Floor 2 search status'});
 await dialog.getByLabel('Search status',{exact:true}).selectOption('inaccessible');await dialog.getByLabel('Floor note',{exact:true}).fill('Fire blocks the stairwell');await dialog.getByRole('button',{name:'Save floor status',exact:true}).click();
 await observer.waitForFunction(()=>document.querySelector('.floor-control[data-floor="2"]')?.classList.contains('inaccessible'));
 const stale=observer.getByRole('dialog',{name:'Floor 2 search status'});await stale.getByLabel('Search status',{exact:true}).selectOption('cleared');await stale.getByLabel('Floor note',{exact:true}).fill('');await stale.getByRole('button',{name:'Save floor status',exact:true}).click();
 await assertReady(stale.getByRole('alert'));assert.ok((await stale.getByRole('alert').innerText()).includes('Another responder updated'));
 await stale.getByRole('button',{name:'Reload latest status',exact:true}).click();assert.equal(await stale.getByLabel('Floor note',{exact:true}).inputValue(),'Fire blocks the stairwell');await stale.getByRole('button',{name:'Cancel',exact:true}).click();
 const floorDashboard=await dashboard(adminContext);assert.deepEqual(floorDashboard.searchProgress,{cleared:1,inaccessible:1,pending:3,total:5});assert.deepEqual(floorDashboard.counts,{safe:2,help:2,none:3});
 const blockDDashboard=await(await adminContext.request.get(base+'/api/dashboard?building=0')).json();assert.deepEqual(blockDDashboard.searchProgress,{cleared:0,inaccessible:0,pending:3,total:3});
 assert.deepEqual((await dashboard(adminContext)).injuryCounts,{bleeding:1,fracture:1,burns:0,smoke_inhalation:1});
 assert.deepEqual((await(await adminContext.request.get(base+'/api/dashboard?building=1')).json()).injuryCounts,{bleeding:1,fracture:1,burns:0,smoke_inhalation:0});
 assert.deepEqual(blockDDashboard.injuryCounts,{bleeding:0,fracture:0,burns:0,smoke_inhalation:1});
 assert.equal(await helpCell.locator('.injury-badge').count(),2);assert.ok((await helpCell.getAttribute('aria-describedby')).startsWith('injuries-'));
 await admin.screenshot({path:path.join(root,'test-results','injury-dashboard-desktop.png'),fullPage:true});
 await admin.screenshot({path:path.join(root,'test-results','floor-search-desktop.png'),fullPage:true});
 await observer.setViewportSize({width:390,height:844});await observer.reload();await observer.getByRole('button',{name:'Open Block A',exact:true}).click();
 await observer.waitForFunction(()=>document.querySelector('.floor-control[data-floor="1"]')?.classList.contains('searched'));
 assert.ok((await observer.locator('.floor-control[data-floor="2"]').innerText()).includes('Fire blocks the stairwell'));
 await observer.screenshot({path:path.join(root,'test-results','floor-search-mobile.png'),fullPage:true});
 await desktopNav.getByRole('button',{name:'Lost & Found',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Lost & Found',exact:true}));
 await desktopNav.getByRole('button',{name:'報平安 · Safety',exact:true}).click();await admin.getByRole('button',{name:'Open Block A',exact:true}).click();await admin.waitForFunction(()=>document.querySelector('.floor-control[data-floor="1"]')?.classList.contains('searched'));
 assert.equal(await db.collection('safety_reports').countDocuments(),4);
 assert.ok(!(await connection.db.listCollections({}, {nameOnly:true}).toArray()).some(c=>c.name==='sessions'));
 const firstBinding=waBinding;
 await admin.getByRole('button',{name:'Back to disaster map',exact:true}).click();await admin.getByRole('button',{name:'Clear Setup',exact:true}).click();await admin.getByLabel('Type CLEAR to confirm').fill('CLEAR');await admin.getByRole('button',{name:'Delete disaster data',exact:true}).click();
 await assertReady(admin.getByRole('heading',{name:'Upload the disaster area map',exact:true}));assert.equal(waLogouts,1);assert.equal(waBinding,null);
 await admin.getByLabel('Disaster map PNG').setInputFiles(path.join(root,'backend/test/fixtures/disaster-map.png'));await assertReady(admin.getByRole('heading',{name:'Set up the disaster area',exact:true}));
 await place(admin,'Block D',1,1,.5,.5);await admin.getByRole('button',{name:'Initialize',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Connect the WhatsApp sender',exact:true}));assert.notEqual(waBinding,firstBinding);
 assert.equal(await admin.getByRole('button',{name:'Clear Setup',exact:true}).count(),0);
 waChange('authenticated');waChange('ready');await assertReady(admin.getByRole('button',{name:'Open Block D',exact:true}));
 await admin.getByRole('button',{name:'Clear Setup',exact:true}).click();await admin.getByLabel('Type CLEAR to confirm').fill('CLEAR');await admin.getByRole('button',{name:'Delete disaster data',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Upload the disaster area map',exact:true}));assert.equal(waLogouts,2);assert.equal(await db.collection('whatsapp_replies').countDocuments(),0);
 assert.deepEqual(errors,[]);
 console.log('WhatsApp initialization flow passed: no Clear on the QR page; authenticated stall and error can retry; automatic completion, blocked Admin login before readiness, reload recovery, map Clear logout and fresh disaster QR.');
 console.log('Phone logout recovery passed: Reconnect displays a fresh QR, completed setup and map/accounts remain intact, resident reporting stays available, and a successful scan returns to the existing map.');
 console.log('WhatsApp browser integration passed with an isolated fake sender: optional blank phone skips, Help does not notify, Safe + phone sends once, and the confirmation reports sent without claiming delivery.');
 console.log('WhatsApp inbox passed: incident scope, existing notifications, live family messages, both reply roles, private attribution, reconnect, and Clear Setup cleanup.');
 console.log('Injury reporting passed: four illustrated buttons with descriptions, multiple choices, immediate MongoDB saves and live updates to both manager roles, deselection, stale poll protection, failed-save retry, reload, Continue, optional details, close after a single injury tap, per-block counters, grid badges, and preserved floor status.');
 console.log('Block identity regression passed: Block D placed before Block A; D accounts and A accounts report only to their named blocks, with matching grid labels and CSV prefixes.');
 console.log('Floor search and navigation passed: desktop left sidebar, mobile bottom bar, Admin clear, live sync to Super Admin, inaccessible notes, stale-edit conflicts, separate progress, original safety reports, reload persistence, and navigation between sections.');
 console.log('Label font-size passed: increase/decrease, live admin view, undo, automatic reset, reload persistence, and unchanged block dimensions.');
 console.log('Block resize passed: grow/shrink controls, corner drag, keyboard adjustment, move after resize, live view updates, reload persistence, unchanged floor/unit counts and accounts.');
 console.log('Manual map Save passed: edits stay private until Save, publish live afterward, reload/view/navigation/logout discard unsaved edits, failed saves retain drafts for retry, and stale saves cannot overwrite a newer map.');
 console.log('Map browser flows passed: PNG upload, unequal blocks, drawing/deletion/emoji, Super Admin initialization, restricted Admin view, live updates, mobile map, and building-specific grids.');
 console.log('Browser flows passed: two-button mobile page, immediate admin updates, optional blank Safe/Help, location/contact details, draft retention, closing after one click, resume after reload, N/A displays, and 999 confirmations.');
 console.log('Screenshots saved to '+path.join(root,'test-results'));
} finally {
 await browser?.close();api?.locals.closeStreams();await api?.locals.notifications.stop();if(server)await new Promise(resolve=>server.close(resolve));await client?.close();
 if(mongo.exitCode===null){const exit=once(mongo,'exit');mongo.kill('SIGTERM');await exit;}
 await rm(directory,{recursive:true,force:true});
}
