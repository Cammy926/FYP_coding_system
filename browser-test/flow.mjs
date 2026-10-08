import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
 await admin.getByLabel('Disaster name').fill('Two-step browser test');
 await admin.getByLabel('Buildings',{exact:true}).fill('1');await admin.getByLabel('Floors per building').fill('2');await admin.getByLabel('Rooms per floor').fill('2');
 await admin.getByRole('button',{name:'Create disaster & unit accounts',exact:true}).click();
 await assertReady(admin.getByRole('heading',{name:'Two-step browser test',exact:true}));
 const {context:safeContext,page:safe}=await pageFor('101',{width:390,height:844});
 await assertReady(safe.getByRole('heading',{name:'Are you safe?',exact:true}));
 assert.equal(await safe.locator('.status-choices button').count(),2);assert.equal(await safe.locator('main input, main textarea').count(),0);
 assert.ok((await safe.getByRole('button',{name:'Safe',exact:true}).boundingBox()).height>=150);
 await safe.screenshot({path:path.join(root,'test-results','resident-choice-mobile.png'),fullPage:true});
 await safe.getByRole('button',{name:'Safe',exact:true}).click();
 await assertReady(safe.getByLabel(/Family member’s WhatsApp phone number/));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:1,help:0,none:3});
 await refreshAdmin(admin);const safeDetail=await detail(admin,'101','Safe');assert.ok((await safeDetail.innerText()).includes('N/A'));
 await safe.getByRole('button',{name:'Submit',exact:true}).click();
 await assertReady(safe.getByRole('heading',{name:'Remain in a safe area',exact:true}));
 assert.equal(await safe.getByRole('link',{name:'In an emergency, call 999'}).getAttribute('href'),'tel:999');
 assert.ok((await safe.locator('.report-confirmation').innerText()).includes('Please remain in a safe area.'));
 await safe.screenshot({path:path.join(root,'test-results','safe-confirmation-mobile.png'),fullPage:true});
 const {context:helpContext,page:help}=await pageFor('102');
 await help.getByRole('button',{name:'I need help',exact:true}).click();
 await assertReady(help.getByLabel(/What is happening/));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:1,help:1,none:2});
 await admin.getByRole('button',{name:'Unit 102: Needs help',exact:true}).waitFor({state:'visible'});const helpDetail=await detail(admin,'102','Needs help');assert.equal((await helpDetail.locator('dd').allTextContents()).filter(s=>s==='N/A').length,3);
 await help.getByLabel(/What is happening/).fill('Two people cannot walk');await help.getByLabel(/Where are you now/).fill('Building A third-floor stairwell');await help.getByLabel(/Your phone number/).fill('+852 9123 4567');
 // Background refresh must not replace the in-progress optional form.
 await help.waitForResponse(response=>response.url().endsWith('/api/reports/mine')&&response.request().method()==='GET',{timeout:10000});
 assert.equal(await help.getByLabel(/Where are you now/).inputValue(),'Building A third-floor stairwell');
 await help.screenshot({path:path.join(root,'test-results','help-details-desktop.png'),fullPage:true});
 await help.getByRole('button',{name:'Submit',exact:true}).click();
 await assertReady(help.getByRole('heading',{name:'Please stay calm',exact:true}));
 assert.equal(await help.getByRole('link',{name:'In an emergency, call 999'}).getAttribute('href'),'tel:999');
 await refreshAdmin(admin);const complete=await detail(admin,'102','Needs help');
 assert.ok((await complete.innerText()).includes('Two people cannot walk'));assert.ok((await complete.innerText()).includes('Building A third-floor stairwell'));assert.ok((await complete.innerText()).includes('+85291234567'));
 const {context:blankContext,page:blank}=await pageFor('201',{width:390,height:844});
 // Leave immediately after the click, before submitting or seeing the form.
 await blank.getByRole('button',{name:'I need help',exact:true}).click();await blank.close();
 let saved;
 for(let i=0;i<40;i++){saved=await db.collection('safety_reports').findOne({username:'201'});if(saved)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(saved);assert.equal(saved.status,'help');assert.equal(saved.detailsSubmittedAt,null);
 const resumed=await blankContext.newPage();await resumed.goto(base);await assertReady(resumed.getByLabel(/What is happening/));
 assert.equal(await resumed.locator('main [required]').count(),0);
 await resumed.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(resumed.getByRole('heading',{name:'Please stay calm',exact:true}));
 await refreshAdmin(admin);const blankDetail=await detail(admin,'201','Needs help');assert.equal((await blankDetail.locator('dd').allTextContents()).filter(s=>s==='N/A').length,3);
 await admin.screenshot({path:path.join(root,'test-results','admin-blank-help-desktop.png'),fullPage:true});
 const {page:phoneSafe}=await pageFor('202');await phoneSafe.getByRole('button',{name:'Safe',exact:true}).click();await assertReady(phoneSafe.getByLabel(/Family member’s WhatsApp phone number/));
 await phoneSafe.getByLabel(/Family member’s WhatsApp phone number/).fill('+852 9234 5678');await phoneSafe.getByRole('button',{name:'Submit',exact:true}).click();await assertReady(phoneSafe.getByRole('heading',{name:'Remain in a safe area',exact:true}));
 assert.deepEqual((await dashboard(adminContext)).counts,{safe:2,help:2,none:0});
 await safe.reload();await assertReady(safe.getByRole('heading',{name:'Remain in a safe area',exact:true}));assert.equal(await safe.locator('.status-choices').count(),0);
 assert.equal(await db.collection('safety_reports').countDocuments(),4);
 assert.ok(!(await connection.db.listCollections({}, {nameOnly:true}).toArray()).some(c=>c.name==='sessions'));
 assert.deepEqual(errors,[]);
 console.log('Browser flows passed: two-button mobile page, immediate admin updates, optional blank Safe/Help, location/contact details, draft retention, closing after one click, resume after reload, N/A displays, and 999 confirmations.');
 console.log('Screenshots saved to '+path.join(root,'test-results'));
} finally {
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await client?.close();
 if(mongo.exitCode===null){const exit=once(mongo,'exit');mongo.kill('SIGTERM');await exit;}
 await rm(directory,{recursive:true,force:true});
}
