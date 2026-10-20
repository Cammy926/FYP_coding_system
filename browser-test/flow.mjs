import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { connectDatabase, initializeDatabase } from '../backend/db.js';
import { createApp } from '../backend/app.js';
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
let client,server,browser;
try {
 let connection;
 for(let i=0;i<40;i++) {try{connection=await connectDatabase(`mongodb://127.0.0.1:${mongoPort}/`,'browser_safety_test');break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
 assert.ok(connection);client=connection.client;
 const db=await initializeDatabase(connection.db);const origins=[];
 const api=createApp(db,{origins,rateLimits:false});
 const app=express();app.use((req,res,next)=>req.path.startsWith('/api/')?api(req,res,next):next());app.use(express.static(path.join(root,'frontend/dist')));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;origins.push(base);
 browser=await chromium.launch({channel:'chrome',headless:true});
 const errors=[];
 async function pageFor(username,viewport={width:1280,height:1000}) {
  const context=await browser.newContext({viewport});const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  await page.getByLabel('Account name').fill(username);await page.getByLabel('Password',{exact:true}).fill(username);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();return {context,page};
 }
 async function refreshAdmin(page) {await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible'});}
 async function dashboard(context) {const response=await context.request.get(base+'/api/dashboard');assert.equal(response.status(),200);return response.json();}
 async function detail(page,unit,status) {await page.getByRole('button',{name:`Unit ${unit}: ${status}`,exact:true}).click();return page.locator('.unit-detail');}
 async function assertReady(locator) {await locator.waitFor({state:'visible'});}
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
 await admin.getByRole('button',{name:'Initialize',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Map safety test',exact:true}));
 const {page:observer}=await pageFor('admin');await assertReady(observer.getByRole('button',{name:'Open Block A',exact:true}));assert.equal(await observer.getByRole('button',{name:'Edit map',exact:true}).count(),0);
 assert.equal(await db.collection('users').countDocuments(),9);
 await admin.getByRole('button',{name:'Edit map',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Edit disaster map',exact:true}));
 await admin.getByRole('button',{name:'Text / emoji',exact:true}).click();point=await canvasPoint(admin,.63,.72);await admin.mouse.click(point.x,point.y);await admin.getByLabel('Text or emoji',{exact:true}).fill('🍔 Food point');await admin.getByRole('button',{name:'Add note',exact:true}).click();
 await assertReady(observer.locator('.map-note').filter({hasText:'🍔 Food point'}));
 await admin.getByRole('button',{name:'Edit Block A',exact:true}).click();assert.equal(await admin.getByLabel('Floors in this block',{exact:true}).isDisabled(),true);await admin.getByLabel('Block label',{exact:true}).fill('Block A updated');await admin.getByRole('button',{name:'Place block',exact:true}).click();await assertReady(observer.getByRole('button',{name:'Open Block A updated',exact:true}));
 await admin.getByRole('button',{name:'Edit Block A updated',exact:true}).click();await admin.getByLabel('Block label',{exact:true}).fill('Block A');await admin.getByRole('button',{name:'Place block',exact:true}).click();await assertReady(observer.getByRole('button',{name:'Open Block A',exact:true}));
 await admin.getByRole('button',{name:'Select / move',exact:true}).click();const marker=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();const destination=await canvasPoint(admin,.58,.62);await admin.mouse.move(marker.x+marker.width/2,marker.y+marker.height/2);await admin.mouse.down();await admin.mouse.move(destination.x,destination.y,{steps:6});await admin.mouse.up();
 await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.left)>57);
 assert.equal(await admin.getByRole('button',{name:'Delete selected',exact:true}).isDisabled(),true);
 await admin.getByRole('button',{name:'Undo',exact:true}).click();await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.left)<55);
 // Resize the visible label, without touching the building's floor/unit layout.
 await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 const legacyBox=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();
 await admin.getByLabel('Block width (% of map)',{exact:true}).fill('24');await admin.getByLabel('Block width (% of map)',{exact:true}).press('Tab');
 await admin.getByLabel('Block height (% of map)',{exact:true}).fill('12');await admin.getByLabel('Block height (% of map)',{exact:true}).press('Tab');
 await observer.waitForFunction(()=>document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.width==='24%');
 const expanded=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(expanded.width>legacyBox.width*1.5);assert.ok(expanded.height>legacyBox.height);
 const handle=await admin.getByRole('button',{name:'Resize Block A',exact:true}).boundingBox();await admin.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await admin.mouse.down();await admin.mouse.move(handle.x+handle.width/2-55,handle.y+handle.height/2-15,{steps:6});await admin.mouse.up();
 const shrunk=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(shrunk.width<expanded.width-40);assert.ok(shrunk.height<expanded.height-10);
 await admin.getByRole('button',{name:'Resize Block A',exact:true}).focus();await admin.keyboard.press('ArrowRight');
 await observer.waitForFunction(()=>parseFloat(document.querySelector('[aria-label="Open Block A"]').closest('.map-block-frame').style.width)<23);
 // Click the label body away from the handle and verify it still moves.
 const beforeMove=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();await admin.mouse.move(beforeMove.x+beforeMove.width/2,beforeMove.y+beforeMove.height/2);await admin.mouse.down();await admin.mouse.move(beforeMove.x+beforeMove.width/2+12,beforeMove.y+beforeMove.height/2+8,{steps:4});await admin.mouse.up();
 await admin.waitForFunction(()=>document.querySelector('.save-state').textContent==='All changes saved');
 const savedMap=(await (await adminContext.request.get(base+'/api/map')).json()).map;const markerSize=savedMap.annotations.find(a=>a.type==='block'&&a.building===1);
 assert.ok(markerSize.w>.04&&markerSize.h>.03);assert.deepEqual(savedMap.blocks.map(b=>[b.floors,b.rooms]),[[3,1],[2,2]]);assert.equal(await db.collection('users').countDocuments(),9);
 await admin.screenshot({path:path.join(root,'test-results','block-resize-editor.png'),fullPage:true});
 await admin.reload();await admin.getByRole('button',{name:'Edit map',exact:true}).click();await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 const reloaded=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(Math.abs(reloaded.width-markerSize.w*(await admin.locator('.map-workspace .floor-plan').boundingBox()).width)<2);
 // Change only the words' size, retain the existing block dimensions and layout.
 const fontInput=admin.getByLabel('Label font size (px)',{exact:true});
 const labelGeometry=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();
 await fontInput.fill('28');await fontInput.press('Tab');
 await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='28px');
 assert.equal(await admin.getByRole('button',{name:'Select Block A',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'28px');
 assert.equal(await observer.getByRole('button',{name:'Open Block D',exact:true}).evaluate(el=>el.style.fontSize),'');
 const afterFont=await admin.getByRole('button',{name:'Select Block A',exact:true}).boundingBox();assert.ok(Math.abs(afterFont.width-labelGeometry.width)<1);assert.ok(Math.abs(afterFont.height-labelGeometry.height)<1);
 await fontInput.fill('16');await fontInput.press('Tab');await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='16px');
 await admin.getByRole('button',{name:'Undo',exact:true}).click();await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='28px');
 await admin.getByRole('button',{name:'Select Block A',exact:true}).click();
 await fontInput.fill('');await fontInput.press('Tab');await observer.waitForFunction(()=>document.querySelector('[aria-label="Open Block A"]').style.fontSize==='');
 await fontInput.fill('24');await fontInput.press('Tab');await observer.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="Open Block A"]')).fontSize==='24px');
 await admin.waitForFunction(()=>document.querySelector('.save-state').textContent==='All changes saved');
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
 assert.ok((await safe.locator('.report-confirmation').innerText()).includes('Please remain in a safe area.'));
 await safe.screenshot({path:path.join(root,'test-results','safe-confirmation-mobile.png'),fullPage:true});
 const {context:helpContext,page:help}=await pageFor('A-102');
 await help.getByRole('button',{name:'I need help',exact:true}).click();
 await assertReady(help.getByLabel(/What is happening/));
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
 const resumed=await blankContext.newPage();await resumed.goto(base);await assertReady(resumed.getByLabel(/What is happening/));
 assert.equal(await resumed.locator('main [required]').count(),0);
 await resumed.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(resumed.getByRole('heading',{name:'Please stay calm',exact:true}));
 await admin.getByRole('button',{name:'Back to disaster map',exact:true}).click();await admin.getByRole('button',{name:'Open Block D',exact:true}).click();
 await refreshAdmin(admin);const blankDetail=await detail(admin,'D-201','Needs help');assert.equal((await blankDetail.locator('dd').allTextContents()).filter(s=>s==='N/A').length,3);
 await admin.screenshot({path:path.join(root,'test-results','admin-blank-help-desktop.png'),fullPage:true});
 const {page:phoneSafe}=await pageFor('A-201');await phoneSafe.getByRole('button',{name:'Safe',exact:true}).click();await assertReady(phoneSafe.getByLabel(/Family member’s WhatsApp phone number/));
 await phoneSafe.getByLabel(/Family member’s WhatsApp phone number/).fill('+852 9234 5678');await phoneSafe.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(phoneSafe.getByRole('heading',{name:'Remain in a safe area',exact:true}));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:2,help:2,none:3});
 await safe.reload();await assertReady(safe.getByRole('heading',{name:'Remain in a safe area',exact:true}));assert.equal(await safe.locator('.status-choices').count(),0);
 // Desktop navigation is on the left, while phone navigation stays horizontal.
 await admin.getByRole('button',{name:'Back to disaster map',exact:true}).click();await admin.getByRole('button',{name:'Open Block A',exact:true}).click();
 const desktopNav=admin.getByRole('navigation',{name:'Main navigation'});const navBox=await desktopNav.boundingBox();const mainBox=await admin.locator('main').boundingBox();assert.ok(navBox.x+navBox.width<=mainBox.x+1);
 const navButtons=desktopNav.getByRole('button');const firstNav=await navButtons.nth(0).boundingBox(),secondNav=await navButtons.nth(1).boundingBox();assert.ok(secondNav.y>firstNav.y);assert.ok(Math.abs(firstNav.x-secondNav.x)<1);
 const phoneNav=safe.getByRole('navigation',{name:'Main navigation'}).getByRole('button');const phoneFirst=await phoneNav.nth(0).boundingBox(),phoneSecond=await phoneNav.nth(1).boundingBox();assert.ok(phoneSecond.x>phoneFirst.x);assert.ok(Math.abs(phoneFirst.y-phoneSecond.y)<1);
 await observer.setViewportSize({width:1280,height:1000});await observer.getByRole('button',{name:'Open Block A',exact:true}).click();
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
 await admin.screenshot({path:path.join(root,'test-results','floor-search-desktop.png'),fullPage:true});
 await observer.setViewportSize({width:390,height:844});await observer.reload();await observer.getByRole('button',{name:'Open Block A',exact:true}).click();
 await observer.waitForFunction(()=>document.querySelector('.floor-control[data-floor="1"]')?.classList.contains('searched'));
 assert.ok((await observer.locator('.floor-control[data-floor="2"]').innerText()).includes('Fire blocks the stairwell'));
 await observer.screenshot({path:path.join(root,'test-results','floor-search-mobile.png'),fullPage:true});
 await desktopNav.getByRole('button',{name:'Lost & Found',exact:true}).click();await assertReady(admin.getByRole('heading',{name:'Lost & Found',exact:true}));
 await desktopNav.getByRole('button',{name:'報平安 · Safety',exact:true}).click();await admin.getByRole('button',{name:'Open Block A',exact:true}).click();await admin.waitForFunction(()=>document.querySelector('.floor-control[data-floor="1"]')?.classList.contains('searched'));
 assert.equal(await db.collection('safety_reports').countDocuments(),4);
 assert.ok(!(await connection.db.listCollections({}, {nameOnly:true}).toArray()).some(c=>c.name==='sessions'));
 assert.deepEqual(errors,[]);
 console.log('Block identity regression passed: Block D placed before Block A; D accounts and A accounts report only to their named blocks, with matching grid labels and CSV prefixes.');
 console.log('Floor search and navigation passed: desktop left sidebar, mobile bottom bar, Admin clear, live sync to Super Admin, inaccessible notes, stale-edit conflicts, separate progress, original safety reports, reload persistence, and navigation between sections.');
 console.log('Label font-size passed: increase/decrease, live admin view, undo, automatic reset, reload persistence, and unchanged block dimensions.');
 console.log('Block resize passed: grow/shrink controls, corner drag, keyboard adjustment, move after resize, live view updates, reload persistence, unchanged floor/unit counts and accounts.');
 console.log('Map browser flows passed: PNG upload, unequal blocks, drawing/deletion/emoji, Super Admin initialization, restricted Admin view, live updates, mobile map, and building-specific grids.');
 console.log('Browser flows passed: two-button mobile page, immediate admin updates, optional blank Safe/Help, location/contact details, draft retention, closing after one click, resume after reload, N/A displays, and 999 confirmations.');
 console.log('Screenshots saved to '+path.join(root,'test-results'));
} finally {
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await client?.close();
 if(mongo.exitCode===null){const exit=once(mongo,'exit');mongo.kill('SIGTERM');await exit;}
 await rm(directory,{recursive:true,force:true});
}
