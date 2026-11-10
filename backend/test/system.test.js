import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { connectDatabase, initializeDatabase } from '../db.js';
import { createApp } from '../app.js';
import { hashPassword } from '../lib.js';
import { repairBlockAccounts } from '../block-accounts.js';
import { readFile, readdir } from 'node:fs/promises';
import { COLLECTION_NAMES, createStore } from '../store.js';
import { migrateLegacyCollection } from '../migration.js';

// Real MongoDB, isolated data directory and random port. Never touches .env or the
// user's auto_safety_report database. Uses the project's portable MongoDB binary.
test('Auto Safety Report end-to-end API and persistence', { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(path.join(root,'test-results'),{recursive:true});
  const dataDir = await mkdtemp(path.join(root,'test-results','mongo-'));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const mongoPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const binary = process.env.MONGOD_BINARY || path.join(root,'runtime/mongodb/bin/mongod');
  const mongo = spawn(binary,['--dbpath',dataDir,'--bind_ip','127.0.0.1','--port',String(mongoPort),'--quiet','--logpath',path.join(dataDir,'mongo.log')],{stdio:'ignore'});
  let mongoFailure;
  mongo.on('error',e => { mongoFailure=e; });
  let client, server, base;
  const cookies = new Map();let currentIncidentId;
  async function request(actor, route, method='GET', body, extraHeaders={}) {
    if(route.startsWith('/api/floors/') && body) body={incidentId:currentIncidentId,...body};
    const response = await fetch(base+route, { method, headers: { 'Content-Type':'application/json', ...(cookies.has(actor) ? { Cookie:cookies.get(actor) } : {}), ...extraHeaders }, ...(body !== undefined ? { body:JSON.stringify(body) } : {}) });
    const cookie = response.headers.get('set-cookie'); if (cookie) cookies.set(actor,cookie.split(';')[0]);
    const result={ status:response.status, body: await response.json().catch(()=>null) };
    if(route==='/api/incident' && method==='POST' && response.status===201) currentIncidentId=result.body.incident.incidentId;
    return result;
  }
  async function logIn(actor, username=actor) {
    if (['admin', 'superadmin'].includes(username)) username += '1';
    const result=await request(actor,'/api/auth/login','POST',{username,password:username});assert.equal(result.status,200,JSON.stringify(result.body));return result;
  }
  const startHttp = async db => { server=createApp(db,{rateLimits:false}).listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`; };
  try {
    let connection;
    for (let attempt=0;attempt<40;attempt++) {
      if (mongoFailure) throw mongoFailure;
      try { connection=await connectDatabase(`mongodb://127.0.0.1:${mongoPort}/?serverSelectionTimeoutMS=500`,'test_safety');break; } catch { await new Promise(resolve=>setTimeout(resolve,250)); }
    }
    assert.ok(connection,'Isolated MongoDB must start. Run setup.command first.');
    client=connection.client;const rawDb=connection.db;
    const db=await initializeDatabase(rawDb);await startHttp(db);
    const png='data:image/png;base64,'+(await sharp({create:{width:200,height:120,channels:3,background:'#d7e8d9'}}).png().toBuffer()).toString('base64');
    async function setupMap(blocks, name='Integration test') {
      const uploaded=await request('superadmin','/api/map','POST',{image:png});assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));
      const annotations=blocks.map((block,i)=>({id:'marker-'+i,type:'block',building:i,x:.2+i*.3,y:.4}));
      const saved=await request('superadmin','/api/map','PATCH',{revision:uploaded.body.map.revision,name,blocks,annotations});assert.equal(saved.status,200,JSON.stringify(saved.body));
      return saved.body.map;
    }
    await t.test('four manager accounts migrate safely and keep passwords on restart', async () => {
      const raw = client.db('manager_account_migration');
      const users = raw.collection('user');
      await users.insertMany(await Promise.all(['superadmin','admin'].map(async role => ({_id:role,username:role,role,passwordHash:await hashPassword(role)}))));
      const seeded = await initializeDatabase(raw);
      assert.deepEqual((await seeded.collection('users').find({}).toArray()).map(u=>u.username).sort(), ['admin1','admin2','superadmin1','superadmin2']);
      const hashes = (await seeded.collection('users').find({}).toArray()).map(u=>u.passwordHash);
      await initializeDatabase(raw);
      assert.deepEqual((await seeded.collection('users').find({}).toArray()).map(u=>u.passwordHash),hashes);
      for (const username of ['superadmin1','superadmin2']) {
        const response = await request(username,'/api/auth/login','POST',{username,password:username});
        assert.equal(response.status,200);assert.equal(response.body.user.role,'superadmin');
        assert.equal((await request(username,'/api/map')).status,200);
      }
      for (const username of ['admin1','admin2']) assert.equal((await request(username,'/api/auth/login','POST',{username,password:username})).status,403);
      for (const username of ['superadmin','admin']) assert.equal((await request('retired','/api/auth/login','POST',{username,password:username})).status,401);
    });
    await t.test('only Super Admin can log in before initialization; origin and image validation', async () => {
      assert.equal((await request('anonymous','/api/dashboard')).status,401);
      assert.equal((await request('anonymous','/api/auth/login','POST',{username:'admin',password:'wrong'})).status,401);
      assert.equal((await request('anonymous','/api/auth/login','POST',{username:{'$ne':null},password:'admin'})).status,400);
      assert.equal((await request('anonymous','/api/auth/login','POST',{username:'admin1',password:'admin1'},{Origin:'https://untrusted.example'})).status,403);
      assert.equal((await request('admin','/api/auth/login','POST',{username:'admin1',password:'admin1'})).status,403);
      await logIn('superadmin');assert.equal((await request('superadmin','/api/incident')).body.incident,null);
      assert.equal((await request('superadmin','/api/reports','POST',{status:'safe'})).status,403);
      assert.equal((await request('superadmin','/api/incident','POST',{})).status,400);
      assert.equal((await request('superadmin','/api/map','POST',{image:'data:image/png;base64,YWJj'})).status,400);
    });
    await t.test('PNG map initializes unequal building layouts; Admin cannot initialize or edit', async () => {
      const map=await setupMap([{building:0,label:'Block A',floors:3,rooms:2},{building:1,label:'Block B',floors:4,rooms:3}]);
      const missing=await request('superadmin','/api/map','PATCH',{...map,annotations:[]});assert.equal(missing.status,200);
      assert.equal((await request('superadmin','/api/incident','POST',{mapRevision:missing.body.map.revision})).status,400);
      const restored=await request('superadmin','/api/map','PATCH',{...map,revision:missing.body.map.revision});assert.equal(restored.status,200);
      const results=await Promise.all([1,2].map(()=>request('superadmin','/api/incident','POST',{mapRevision:restored.body.map.revision})));
      assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);await logIn('admin');
      await logIn('admin2');assert.equal((await request('admin2','/api/dashboard')).status,200);assert.equal((await request('admin2','/api/map','POST',{image:png})).status,403);
      const accounts=await request('admin','/api/incident/accounts');assert.equal(accounts.body.accounts.length,18);
      assert.ok(accounts.body.accounts.some(u=>u.username==='A-201'));assert.ok(accounts.body.accounts.some(u=>u.username==='B-403'));assert.ok(!accounts.body.accounts.some(u=>u.username==='A-401'));
      assert.ok(accounts.body.accounts.every(u=>!('passwordHash' in u)));
      assert.deepEqual((await request('admin','/api/dashboard')).body.counts,{safe:0,help:0,none:18});
      assert.equal((await request('admin','/api/incident','POST',{})).status,403);
      assert.equal((await request('admin','/api/map','PATCH',map)).status,403);
      assert.equal((await request('admin','/api/map','POST',{image:png})).status,403);
      assert.equal((await request('admin','/api/map')).body.map.image.data,undefined);
      const image=await fetch(base+'/api/map/image',{headers:{Cookie:cookies.get('admin')}});assert.equal(image.status,200);assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format,'png');
      await logIn('resident','A-201');await logIn('resident2','B-302');
      for(const route of ['/api/dashboard','/api/map','/api/incident/accounts']) assert.equal((await request('resident',route)).status,403);
      assert.equal((await request('resident','/api/incident','DELETE',{confirmation:'CLEAR'})).status,403);
    });
    await t.test('one button saves status immediately, retries are safe, and unfinished details survive restart', async () => {
      assert.equal((await request('resident','/api/reports/mine','PATCH',{})).status,409);
      assert.equal((await request('resident','/api/reports','POST',{status:'unknown'})).status,400);
      const safe=await request('resident','/api/reports','POST',{status:'safe',username:'B-302',building:1});
      assert.equal(safe.status,201);assert.equal(safe.body.report.username,'A-201');assert.equal(safe.body.report.notificationStatus,'disabled');
      assert.equal(safe.body.report.detailsSubmittedAt,null);assert.equal(safe.body.report.familyPhone,'');
      assert.equal((await request('resident','/api/reports','POST',{status:'help'})).status,409);
      const submissions=await Promise.all([1,2].map(()=>request('resident2','/api/reports','POST',{status:'help'})));
      assert.deepEqual(submissions.map(r=>r.status).sort(),[200,201]);
      const help=submissions[0].body.report;
      assert.equal(help.situation,'');assert.equal(help.location,'');assert.equal(help.contact,'');assert.equal(help.detailsSubmittedAt,null);
      const overview=await request('admin','/api/dashboard');
      assert.deepEqual(overview.body.counts,{safe:1,help:1,none:16});
      assert.equal(overview.body.reports.find(r=>r.status==='help').detailsSubmittedAt,null);
      await new Promise(resolve=>server.close(resolve));await initializeDatabase(rawDb);await startHttp(db);
      assert.equal((await request('resident','/api/auth/me')).status,401);
      await logIn('resident','A-201');await logIn('resident2','B-302');await logIn('admin');await logIn('superadmin');
      assert.equal((await request('resident2','/api/reports/mine')).body.report.detailsSubmittedAt,null);
      const retry=await request('resident','/api/reports','POST',{status:'safe'});
      assert.equal(retry.status,200);assert.equal(retry.body.report.createdAt,safe.body.report.createdAt);
      assert.equal(await db.collection('safety_reports').countDocuments(),2);
    });
    await t.test('injury taps save independently, sync live, support multiple choices, and survive restart', async () => {
      const route='/api/reports/mine/injuries';
      assert.equal((await request('anonymous',route,'PATCH',{injury:'bleeding',selected:true})).status,401);
      for(const actor of ['admin','superadmin']) assert.equal((await request(actor,route,'PATCH',{injury:'bleeding',selected:true})).status,403);
      assert.equal((await request('resident',route,'PATCH',{injury:'bleeding',selected:true})).status,409);
      await logIn('unreported','A-301');assert.equal((await request('unreported',route,'PATCH',{injury:'bleeding',selected:true})).status,409);
      for(const body of [{},{injury:'unknown',selected:true},{injury:'bleeding',selected:'yes'},{injury:{$ne:null},selected:true},{completeStep:true,injury:'bleeding'},{injuries:['bleeding']}]) assert.equal((await request('resident2',route,'PATCH',body)).status,400);
      const before=(await request('resident2','/api/reports/mine')).body.report;assert.deepEqual(before.injuries,[]);assert.equal(before.injuryStepCompletedAt,null);
      const stream=await fetch(base+'/api/map/events',{headers:{Cookie:cookies.get('admin')}}),reader=stream.body.getReader();await reader.read();
      try {
        const first=await request('resident2',route,'PATCH',{injury:'bleeding',selected:true,userId:'A-201',building:0});
        assert.equal(first.status,200);assert.equal(first.body.report.username,'B-302');assert.equal(first.body.report.building,1);assert.equal(first.body.report.detailsSubmittedAt,null);
        assert.deepEqual(first.body.report.injuries,['bleeding']);assert.equal(first.body.report.revision,before.revision+1);
        const event=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Report event missing')),2000))]);assert.ok(new TextDecoder().decode(event.value).includes('event: reports'));
        const raw=await db.collection('safety_reports').findOne({_id:first.body.report._id});assert.deepEqual(raw.injuries,['bleeding']);assert.equal(raw.situation,'');
        const retry=await request('resident2',route,'PATCH',{injury:'bleeding',selected:true});assert.equal(retry.body.report.revision,first.body.report.revision);
        const concurrent=await Promise.all(['fracture','smoke_inhalation'].map(injury=>request('resident2',route,'PATCH',{injury,selected:true})));assert.ok(concurrent.every(r=>r.status===200));
        for(const selected of [true,false]) assert.equal((await request('resident2',route,'PATCH',{injury:'burns',selected})).status,200);
        const current=(await request('resident2','/api/reports/mine')).body.report;assert.deepEqual(current.injuries.sort(),['bleeding','fracture','smoke_inhalation']);
        const counts={bleeding:1,fracture:1,burns:0,smoke_inhalation:1};
        assert.deepEqual((await request('admin','/api/dashboard')).body.injuryCounts,counts);
        assert.deepEqual((await request('superadmin','/api/dashboard?building=1')).body.injuryCounts,counts);
        assert.deepEqual((await request('admin','/api/dashboard?building=0')).body.injuryCounts,{bleeding:0,fracture:0,burns:0,smoke_inhalation:0});
        assert.deepEqual((await request('admin','/api/dashboard')).body.counts,{safe:1,help:1,none:16});
        const next=await request('resident2',route,'PATCH',{completeStep:true});assert.equal(next.status,200);assert.ok(next.body.report.injuryStepCompletedAt);assert.equal(next.body.report.detailsSubmittedAt,null);
        assert.equal((await request('resident2',route,'PATCH',{completeStep:true})).body.report.injuryStepCompletedAt,next.body.report.injuryStepCompletedAt);
      } finally {await reader.cancel();}
      await new Promise(resolve=>server.close(resolve));await initializeDatabase(rawDb);await startHttp(db);
      await logIn('resident','A-201');await logIn('resident2','B-302');await logIn('admin');await logIn('superadmin');
      const persisted=(await request('resident2','/api/reports/mine')).body.report;assert.deepEqual(persisted.injuries.sort(),['bleeding','fracture','smoke_inhalation']);assert.ok(persisted.injuryStepCompletedAt);assert.equal(persisted.detailsSubmittedAt,null);
      // A help report from the previous release has no injury fields.
      await logIn('legacyPending','A-301');await request('legacyPending','/api/reports','POST',{status:'help'});
      const legacy=(await request('legacyPending','/api/reports/mine')).body.report;
      await db.collection('safety_reports').updateOne({_id:legacy._id},{$unset:{injuries:'',injuryStepCompletedAt:'',revision:''}});
      const upgraded=await request('legacyPending',route,'PATCH',{injury:'burns',selected:true});assert.equal(upgraded.status,200);assert.deepEqual(upgraded.body.report.injuries,['burns']);assert.equal(upgraded.body.report.revision,1);
      await request('legacyPending',route,'PATCH',{injury:'burns',selected:false});
      const skipped=await request('legacyPending',route,'PATCH',{completeStep:true});assert.equal(skipped.status,200);assert.deepEqual(skipped.body.report.injuries,[]);
      await db.collection('safety_reports').deleteOne({_id:legacy._id});
    });
    await t.test('optional details finalize the signed-in report without changing status or counts', async () => {
      assert.equal((await request('admin','/api/reports/mine','PATCH',{})).status,403);
      assert.equal((await request('resident2','/api/reports/mine','PATCH',{status:'safe'})).status,400);
      assert.equal((await request('resident2','/api/reports/mine','PATCH',{contact:'invalid'})).status,400);
      assert.equal((await request('resident2','/api/reports/mine','PATCH',{location:{'$ne':null}})).status,400);
      assert.equal((await request('resident2','/api/reports/mine')).body.report.detailsSubmittedAt,null);
      const blank=await request('resident','/api/reports/mine','PATCH',{familyPhone:'   '});
      assert.equal(blank.status,200);assert.equal(blank.body.report.familyPhone,'');assert.ok(blank.body.report.detailsSubmittedAt);
      assert.equal((await request('resident','/api/reports/mine','PATCH',{})).status,200);
      assert.equal((await request('resident','/api/reports/mine','PATCH',{familyPhone:'91234567'})).status,409);
      const help=await request('resident2','/api/reports/mine','PATCH',{situation:'Two people need assistance',location:'Building B stairwell',contact:'+852 9123 4567',userId:'A-201'});
      assert.equal(help.status,200);assert.equal(help.body.report.username,'B-302');assert.equal(help.body.report.status,'help');
      assert.deepEqual(help.body.report.injuries.sort(),['bleeding','fracture','smoke_inhalation']);
      assert.equal((await request('resident2','/api/reports/mine/injuries','PATCH',{injury:'burns',selected:true})).status,409);
      assert.equal((await request('resident2','/api/reports/mine','PATCH',{injuries:['burns']})).status,400);
      assert.equal(help.body.report.contact,'+85291234567');assert.equal(help.body.report.location,'Building B stairwell');
      assert.equal((await request('resident2','/api/reports/mine','PATCH',{situation:'Changed'})).status,409);
      await logIn('blankHelp','A-101');
      assert.equal((await request('blankHelp','/api/reports','POST',{status:'help'})).status,201);
      for(const injury of ['bleeding','burns']) assert.equal((await request('blankHelp','/api/reports/mine/injuries','PATCH',{injury,selected:true})).status,200);
      const submitted=await request('blankHelp','/api/reports/mine','PATCH',{});
      assert.equal(submitted.status,200);assert.ok(submitted.body.report.detailsSubmittedAt);
      for(const field of ['situation','location','contact']) assert.equal(submitted.body.report[field],'');
      await logIn('phoneSafe','A-102');
      await request('phoneSafe','/api/reports','POST',{status:'safe'});
      const withPhone=await request('phoneSafe','/api/reports/mine','PATCH',{familyPhone:'+852 9234 5678'});
      assert.equal(withPhone.status,200);assert.equal(withPhone.body.report.familyPhone,'+85292345678');assert.equal(withPhone.body.report.notificationStatus,'disabled');
      assert.deepEqual((await request('admin','/api/dashboard')).body.counts,{safe:2,help:2,none:14});
      assert.equal(await db.collection('safety_reports').countDocuments(),4);
      assert.deepEqual((await request('admin','/api/dashboard')).body.injuryCounts,{bleeding:2,fracture:1,burns:1,smoke_inhalation:1});
      assert.deepEqual((await request('admin','/api/dashboard?building=0')).body.injuryCounts,{bleeding:1,fracture:0,burns:1,smoke_inhalation:0});
    });
    await t.test('map autosave publishes updates, rejects conflicts, and filters block dashboards', async () => {
      const original=(await request('admin','/api/map')).body.map;
      const stream=await fetch(base+'/api/map/events',{headers:{Cookie:cookies.get('admin')}});assert.equal(stream.status,200);
      const reader=stream.body.getReader();await reader.read();let updated;
      try {
        const body={...original,annotations:[...original.annotations,{id:'note-1',type:'text',text:'🚑 Rescue point',x:.4,y:.6,color:'#ff0000',fontSize:22},{id:'pen-1',type:'pen',points:[{x:.1,y:.1},{x:.8,y:.8}],color:'#ff0000',width:4},{id:'boundary-1',type:'rectangle',x:.1,y:.1,w:.7,h:.7,color:'#0033ff',width:3}]};
        updated=await request('superadmin','/api/map','PATCH',body);assert.equal(updated.status,200,JSON.stringify(updated.body));
        const event=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Map update missing')),3000))]);assert.ok(new TextDecoder().decode(event.value).includes('event: map'));
        assert.equal((await request('superadmin','/api/map','PATCH',body)).status,409);
      } finally {await reader.cancel();}
      let current=updated.body.map;assert.equal((await request('admin','/api/map')).body.map.revision,current.revision);
      assert.equal((await request('superadmin','/api/map','PATCH',{...current,blocks:current.blocks.map(b=>({...b,floors:b.floors+1}))})).status,409);
      assert.equal((await request('superadmin','/api/map','PATCH',{...current,annotations:current.annotations.filter(a=>a.type!=='block')})).status,400);
      const a=await request('admin','/api/dashboard?building=0'),b=await request('admin','/api/dashboard?building=1');
      assert.deepEqual(a.body.counts,{safe:2,help:1,none:3});assert.deepEqual(b.body.counts,{safe:0,help:1,none:11});
      assert.ok(a.body.reports.every(r=>r.building===0));assert.ok(b.body.reports.every(r=>r.building===1));
      assert.equal((await request('admin','/api/dashboard?building=99')).status,400);
      assert.equal((await request('admin','/api/dashboard?building=-1')).status,400);
      assert.equal((await request('superadmin','/api/map','PATCH',{...current,annotations:[{id:'bad',type:'text',text:'Bad',x:9,y:0,color:'#ff0000',fontSize:20}]})).status,400);
      const accountsBefore=await db.collection('users').countDocuments();
      const resized=await request('superadmin','/api/map','PATCH',{...current,annotations:current.annotations.map(a=>a.type==='block' && a.building===0?{...a,w:.24,h:.12}:a)});
      assert.equal(resized.status,200,JSON.stringify(resized.body));current=resized.body.map;
      const sized=current.annotations.find(a=>a.type==='block'&&a.building===0);assert.equal(sized.w,.24);assert.equal(sized.h,.12);
      assert.equal(current.annotations.find(a=>a.type==='block'&&a.building===1).w,undefined);
      for(const dimensions of [{w:0,h:.1},{w:1.1,h:.1},{w:.2},{w:.2,h:.1,x:.99}]) {
        const invalid=await request('superadmin','/api/map','PATCH',{...current,annotations:current.annotations.map(a=>a.id===sized.id?{...a,...dimensions,...(!('h' in dimensions)?{h:undefined}:{})}:a)});assert.equal(invalid.status,400);
      }
      const fontUpdate=await request('superadmin','/api/map','PATCH',{...current,annotations:current.annotations.map(a=>a.id===sized.id?{...a,fontSize:28}:a)});
      assert.equal(fontUpdate.status,200,JSON.stringify(fontUpdate.body));current=fontUpdate.body.map;
      const label=current.annotations.find(a=>a.id===sized.id);assert.equal(label.fontSize,28);assert.equal(label.w,.24);assert.equal(label.h,.12);
      assert.equal(current.annotations.find(a=>a.type==='block'&&a.building===1).fontSize,undefined);
      for(const fontSize of [0,7,73,'large',null]) {
        assert.equal((await request('superadmin','/api/map','PATCH',{...current,annotations:current.annotations.map(a=>a.id===sized.id?{...a,fontSize}:a)})).status,400);
      }
      assert.equal(await db.collection('users').countDocuments(),accountsBefore);
      assert.deepEqual((await db.collection('incidents').findOne({_id:'current'})).blocks,current.blocks);
      await initializeDatabase(rawDb);const persisted=await db.collection('disaster_maps').findOne({_id:'current'});assert.equal(persisted.annotations.find(a=>a.id===sized.id).w,.24);assert.equal(persisted.annotations.find(a=>a.id===sized.id).fontSize,28);assert.equal(persisted.annotations.length,5);assert.equal(await db.collection('safety_reports').countDocuments(),4);
    });
    await t.test('floor search progress syncs live, preserves reports, and rejects stale or unauthorized edits', async () => {
      const reportsBefore=await db.collection('safety_reports').find({}).toArray();
      assert.equal((await request('admin','/api/floors/0/1','PATCH',{status:'cleared',revision:0,incidentId:'old-disaster'})).status,409);
      assert.equal((await request('admin','/api/floors/0/1','PATCH',{status:'cleared',revision:0,incidentId:undefined})).status,400);
      assert.equal((await request('resident','/api/floors/0/1','PATCH',{status:'cleared',revision:0})).status,403);
      assert.equal((await request('anonymous','/api/floors/0/1','PATCH',{status:'cleared',revision:0})).status,401);
      for(const [path,body] of [['/api/floors/0/0',{status:'cleared',revision:0}],['/api/floors/0/4',{status:'cleared',revision:0}],['/api/floors/9/1',{status:'cleared',revision:0}],['/api/floors/0/1',{status:'inaccessible',revision:0}],['/api/floors/0/1',{status:'done',revision:0}],['/api/floors/0/1',{status:'cleared',revision:'0'}],['/api/floors/0/1',{status:'inaccessible',revision:0,note:'x'.repeat(301)}]]) assert.equal((await request('admin',path,'PATCH',body)).status,400);
      const stream=await fetch(base+'/api/map/events',{headers:{Cookie:cookies.get('superadmin')}});const reader=stream.body.getReader();await reader.read();let cleared;
      try {
        cleared=await request('admin','/api/floors/0/1','PATCH',{status:'cleared',revision:0});assert.equal(cleared.status,200);assert.equal(cleared.body.floorSearch.updatedBy,'admin1');
        const event=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Floor update event missing')),3000))]);assert.ok(new TextDecoder().decode(event.value).includes('event: floor-search'));
      } finally {await reader.cancel();}
      assert.equal((await request('superadmin','/api/floors/0/1','PATCH',{status:'cleared',revision:0})).status,200);
      assert.equal(await db.collection('floor_searches').countDocuments(),1);
      const a=await request('superadmin','/api/dashboard?building=0');assert.deepEqual(a.body.searchProgress,{cleared:1,inaccessible:0,pending:2,total:3});assert.equal(a.body.floorSearches[0].floor,1);
      const blocked=await request('superadmin','/api/floors/1/1','PATCH',{status:'inaccessible',revision:0,note:'Fire blocks the stairwell'});assert.equal(blocked.status,200);
      const b=await request('admin','/api/dashboard?building=1');assert.deepEqual(b.body.searchProgress,{cleared:0,inaccessible:1,pending:3,total:4});assert.equal(b.body.floorSearches[0].note,'Fire blocks the stairwell');
      assert.deepEqual((await request('admin','/api/dashboard')).body.searchProgress,{cleared:1,inaccessible:1,pending:5,total:7});
      assert.equal((await request('superadmin','/api/floors/0/1','PATCH',{status:'inaccessible',revision:0,note:'Old information'})).status,409);
      const reopened=await request('superadmin','/api/floors/0/1','PATCH',{status:'not_started',revision:cleared.body.floorSearch.revision,note:'Search again'});assert.equal(reopened.status,200);assert.equal(reopened.body.floorSearch.revision,2);
      const race=await Promise.all([request('admin','/api/floors/0/2','PATCH',{status:'cleared',revision:0}),request('superadmin','/api/floors/0/2','PATCH',{status:'inaccessible',revision:0,note:'Collapsed access'})]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
      assert.deepEqual(await db.collection('safety_reports').find({}).toArray(),reportsBefore);
      assert.deepEqual((await request('admin','/api/dashboard')).body.counts,{safe:2,help:2,none:14});
      await new Promise(resolve=>server.close(resolve));await initializeDatabase(rawDb);await startHttp(db);
      await logIn('admin');await logIn('superadmin');await logIn('resident','A-201');await logIn('resident2','B-302');
      const persisted=await request('admin','/api/dashboard?building=1');assert.equal(persisted.body.floorSearches[0].note,'Fire blocks the stairwell');assert.equal(persisted.body.searchProgress.inaccessible,1);
    });
    await t.test('found items validate real images, preserve details, and search literal words', async () => {
      const details={description:'Mickey Mouse toy',place:'Building A lobby',category:'Toys',contact:'finder@example.com'};
      assert.equal((await request('resident','/api/items','POST',{...details,photo:'data:image/png;base64,YWJj'})).status,400);
      const image=await sharp({create:{width:20,height:20,channels:3,background:'#fa524f'}}).png().toBuffer();
      const saved=await request('resident','/api/items','POST',{...details,photo:'data:image/png;base64,'+image.toString('base64')});assert.equal(saved.status,201);
      const id=saved.body.item._id;
      assert.equal((await request('admin','/api/items?q=MICKEY%20toy')).body.items.length,1);
      assert.equal((await request('admin','/api/items?q=.*')).body.items.length,0);
      assert.equal((await request('resident2','/api/items/'+id)).body.item.contact,details.contact);
      const photo=await fetch(base+'/api/items/'+id+'/photo',{headers:{Cookie:cookies.get('resident2')}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');
      assert.ok((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).width>0);
      assert.equal((await request('admin','/api/items/missing')).status,404);
    });
    await t.test('logout revokes the session without erasing reports', async () => {
      const oldCookie=cookies.get('resident');
      assert.equal((await request('resident','/api/auth/logout','POST')).status,200);
      cookies.set('resident',oldCookie);assert.equal((await request('resident','/api/auth/me')).status,401);
      await logIn('resident','A-201');assert.equal((await request('resident','/api/reports/mine')).body.report.status,'safe');
    });
    await t.test('Super Admin-only clear removes incident data and invalidates residents', async () => {
      assert.equal((await request('admin','/api/incident','DELETE',{confirmation:'CLEAR'})).status,403);
      assert.equal((await request('superadmin','/api/incident','DELETE',{confirmation:'wrong'})).status,400);
      assert.equal((await request('superadmin','/api/incident','DELETE',{confirmation:'CLEAR'})).status,200);
      assert.equal((await request('resident','/api/auth/me')).status,401);
      assert.equal((await request('resident','/api/auth/login','POST',{username:'A-201',password:'A-201'})).status,401);
      for(const name of ['incidents','safety_reports','found_items']) assert.equal(await db.collection(name).countDocuments(),0);
      assert.equal(await db.collection('users').countDocuments(),4);
      assert.equal((await request('admin','/api/auth/me')).status,401);assert.equal((await request('superadmin','/api/auth/me')).status,200);
      assert.equal(await db.collection('disaster_maps').countDocuments(),0);assert.equal(await db.collection('floor_searches').countDocuments(),0);
    });
    await t.test('startup recovers interrupted setup and deletion', async () => {
      for (const status of ['provisioning','clearing']) {
        await db.collection('disaster_maps').deleteMany({});
        await db.collection('disaster_maps').insertOne({_id:'current',incidentId:'interrupted',phase:'active',revision:1,annotations:[],blocks:[],image:{data:png.split(',')[1],width:200,height:120}});
        await db.collection('incidents').insertOne({_id:'current',incidentId:'interrupted',status});
        await db.collection('users').insertOne({_id:'temporary-unit',incidentId:'interrupted'});
        await db.collection('found_items').insertOne({_id:'temporary-item',incidentId:'interrupted'});
        await initializeDatabase(rawDb);
        assert.equal(await db.collection('incidents').countDocuments(),0);assert.equal(await db.collection('found_items').countDocuments(),0);assert.equal(await db.collection('users').countDocuments(),4);
        if(status==='provisioning') { const draft=await db.collection('disaster_maps').findOne({_id:'current'});assert.equal(draft.phase,'draft');assert.equal(draft.incidentId,null); } else assert.equal(await db.collection('disaster_maps').countDocuments(),0);
      }
      const map=await setupMap([{building:0,label:'Block A',floors:2,rooms:1}],'Next disaster');
      assert.equal((await request('superadmin','/api/incident','POST',{mapRevision:map.revision})).status,201);
      await logIn('next','A-201');assert.equal((await request('next','/api/reports/mine')).body.report,null);
    });
    await t.test('named blocks route accounts and reports correctly when D is placed before A', async () => {
      const store=await initializeDatabase(client.db('named_block_regression'));
      const namedServer=createApp(store,{rateLimits:false}).listen(0,'127.0.0.1');await once(namedServer,'listening');
      const namedBase=`http://127.0.0.1:${namedServer.address().port}/api`, sessions=new Map();
      async function call(actor,route,method='GET',body) {
        const response=await fetch(namedBase+route,{method,headers:{'Content-Type':'application/json',...(sessions.has(actor)?{Cookie:sessions.get(actor)}:{})},...(body?{body:JSON.stringify(body)}:{})});
        const cookie=response.headers.get('set-cookie');if(cookie)sessions.set(actor,cookie.split(';')[0]);
        return {status:response.status,body:await response.json()};
      }
      const login=async actor=>{const username=['admin','superadmin'].includes(actor)?actor+'1':actor;assert.equal((await call(actor,'/auth/login','POST',{username,password:username})).status,200);};
      try {
        await login('superadmin');
        const uploaded=await call('superadmin','/map','POST',{image:png});
        const input={...uploaded.body.map,blocks:[{building:0,label:'Block D',floors:3,rooms:4},{building:1,label:'Block A',floors:2,rooms:4}],annotations:[{id:'d',type:'block',building:0,x:.25,y:.5},{id:'a',type:'block',building:1,x:.75,y:.5}]};
        const duplicate=await call('superadmin','/map','PATCH',{...input,blocks:input.blocks.map(b=>({...b,label:b.building?'Block D rescue':'Block D'}))});assert.equal(duplicate.status,400);
        const saved=await call('superadmin','/map','PATCH',input);assert.equal(saved.status,200,JSON.stringify(saved.body));
        assert.deepEqual(saved.body.map.blocks.map(b=>b.accountPrefix),['D','A']);
        assert.equal((await call('superadmin','/incident','POST',{mapRevision:saved.body.map.revision})).status,201);
        await login('admin');
        const accounts=(await call('admin','/incident/accounts')).body.accounts;assert.equal(accounts.length,20);
        assert.ok(accounts.filter(a=>a.building===0).every(a=>a.username.startsWith('D-')));
        assert.ok(accounts.filter(a=>a.building===1).every(a=>a.username.startsWith('A-')));
        assert.ok(accounts.some(a=>a.username==='D-304'));assert.ok(!accounts.some(a=>a.username==='A-301'));
        for(const [username,status] of [['A-101','help'],['A-104','safe'],['D-101','safe']]) {
          await login(username);const report=await call(username,'/reports','POST',{status,building:99});assert.equal(report.status,201);
          assert.equal(report.body.report.building,username.startsWith('A-')?1:0);
        }
        const d=(await call('admin','/dashboard?building=0')).body,a=(await call('admin','/dashboard?building=1')).body;
        assert.deepEqual(d.counts,{safe:1,help:0,none:11});assert.deepEqual(a.counts,{safe:1,help:1,none:6});
        assert.ok(d.reports.every(r=>r.username.startsWith('D-')));assert.deepEqual(a.reports.map(r=>r.username).sort(),['A-101','A-104']);
        let map=(await call('superadmin','/map')).body.map;
        const rename=await call('superadmin','/map','PATCH',{...map,blocks:map.blocks.map(b=>b.building===0?{...b,label:'Block C'}:b)});assert.equal(rename.status,409);
        const descriptive=await call('superadmin','/map','PATCH',{...map,blocks:map.blocks.map(b=>b.building===0?{...b,label:'Block D rescue area'}:b)});assert.equal(descriptive.status,200);
        await initializeDatabase(client.db('named_block_regression'));
        assert.equal((await store.collection('users').findOne({_id:'A-101'})).building,1);
        assert.equal((await store.collection('safety_reports').findOne({username:'A-104'})).building,1);
        // A newly configured single named block also uses that block's letter.
        assert.equal((await call('superadmin','/incident','DELETE',{confirmation:'CLEAR'})).status,200);
        const single=await call('superadmin','/map','POST',{image:png});
        map=(await call('superadmin','/map','PATCH',{...single.body.map,blocks:[{building:0,label:'Block D',floors:1,rooms:1}],annotations:[{id:'d-only',type:'block',building:0,x:.5,y:.5}]})).body.map;
        assert.equal((await call('superadmin','/incident','POST',{mapRevision:map.revision})).status,201);
        await login('D-101');assert.equal(await store.collection('users').countDocuments({_id:'101'}),0);
      } finally {await new Promise(resolve=>namedServer.close(resolve));}
    });
    await t.test('old order-based accounts and saved reports are repaired with a private backup and keep map/search data', async () => {
      const store=await initializeDatabase(client.db('old_block_regression'));
      const blocks=[{building:0,label:'Block D',floors:3,rooms:4},{building:1,label:'Block A',floors:2,rooms:4}];
      const incident={_id:'current',incidentId:'wrong-order',status:'active',buildings:2,blocks};
      const map={_id:'current',incidentId:incident.incidentId,phase:'active',blocks,revision:5,image:{data:'preserve-map'},annotations:[{id:'d',type:'block',building:0,x:.25,y:.5,w:.1,h:.1,fontSize:24}]};
      await store.collection('incidents').insertOne(incident);await store.collection('disaster_maps').insertOne(map);
      const passwordHash=await hashPassword('custom-password'),users=[];
      for(const b of blocks)for(let f=1;f<=b.floors;f++)for(let r=1;r<=b.rooms;r++) {const username=`${b.building?'B':'A'}-${f}${String(r).padStart(2,'0')}`;users.push({_id:username,username,role:'user',incidentId:incident.incidentId,building:b.building,floor:f,room:r,passwordHash});}
      await store.collection('users').insertMany(users);
      const reports=['A-101','A-104'].map((username,i)=>({_id:`wrong-order:${username}`,incidentId:incident.incidentId,userId:username,username,building:0,floor:1,room:i?4:1,status:i?'safe':'help',situation:'preserve details',createdAt:new Date()}));
      await store.collection('safety_reports').insertMany(reports);
      const floor={_id:'wrong-order:0:1',incidentId:incident.incidentId,building:0,floor:1,status:'inaccessible',note:'Blocked stairs',revision:1};await store.collection('floor_searches').insertOne(floor);
      const item={_id:'item',incidentId:incident.incidentId,createdBy:'A-101',photo:'preserved-photo'};await store.collection('found_items').insertOne(item);
      const backupDirectory=path.join(dataDir,'private-backups');
      const result=await repairBlockAccounts(store,{backupDirectory});assert.equal(result.movedReports,2);assert.equal(result.movedAccounts,8);assert.equal(result.createdAccounts,12);
      const backup=JSON.parse(await readFile(result.backupPath,'utf8'));assert.equal(backup.users.length,20);assert.equal(backup.reports.length,2);
      assert.equal((await store.collection('users').findOne({_id:'A-101'})).passwordHash,passwordHash);
      assert.equal((await store.collection('users').findOne({_id:'A-101'})).building,1);assert.equal((await store.collection('users').findOne({_id:'D-304'})).building,0);
      assert.equal(await store.collection('users').countDocuments({incidentId:incident.incidentId}),20);assert.equal(await store.collection('users').countDocuments({_id:'A-301'}),0);
      for(const report of reports) assert.deepEqual(await store.collection('safety_reports').findOne({_id:report._id}),{...report,building:1});
      assert.deepEqual(await store.collection('floor_searches').findOne({_id:floor._id}),floor);assert.deepEqual(await store.collection('found_items').findOne({_id:item._id}),item);
      const fixedMap=await store.collection('disaster_maps').findOne({_id:'current'});assert.deepEqual(fixedMap.image,map.image);assert.deepEqual(fixedMap.annotations,map.annotations);
      assert.deepEqual(fixedMap.blocks.map(b=>b.accountPrefix),['D','A']);
      assert.equal(await repairBlockAccounts(store,{backupDirectory}),null);assert.equal((await readdir(backupDirectory)).length,1);
      await initializeDatabase(client.db('old_block_regression'));assert.equal((await store.collection('safety_reports').findOne({username:'A-101'})).building,1);
      // Fail before any write if a report cannot fit the named block's layout.
      await store.collection('incidents').updateOne({_id:'current'},{$unset:{blockIdentityVersion:''}});
      await store.collection('safety_reports').insertOne({_id:'outside',incidentId:incident.incidentId,username:'A-301',userId:'A-301',building:0,floor:3,room:1,status:'help'});
      const before=await store.collection('users').find({}).toArray();
      await assert.rejects(repairBlockAccounts(store,{backupDirectory}),/outside its named block layout/);
      assert.deepEqual(await store.collection('users').find({}).toArray(),before);assert.equal(await store.collection('safety_reports').countDocuments({}),3);
    });
    await t.test('adding a map to the previous setup preserves resident accounts and reports', async () => {
      const legacyDb=client.db('legacy_map_setup');const store=await initializeDatabase(legacyDb);
      await store.collection('incidents').insertOne({_id:'current',incidentId:'legacy',name:'Existing incident',buildings:1,floors:2,rooms:1,status:'active'});
      const passwordHash=await hashPassword('201');
      await store.collection('users').insertOne({_id:'201',username:'201',role:'user',incidentId:'legacy',building:0,floor:2,room:1,passwordHash});
      const oldReport={_id:'legacy:201',incidentId:'legacy',userId:'201',status:'safe',familyPhone:'',createdAt:new Date()};await store.collection('safety_reports').insertOne(oldReport);
      const legacyServer=createApp(store,{rateLimits:false}).listen(0,'127.0.0.1');await once(legacyServer,'listening');const legacyBase=`http://127.0.0.1:${legacyServer.address().port}/api`;let cookie;
      async function legacy(route,method='GET',body) {const response=await fetch(legacyBase+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return {status:response.status,body:await response.json()};}
      try {
        assert.equal((await legacy('/auth/login','POST',{username:'admin1',password:'admin1'})).status,403);
        assert.equal((await legacy('/auth/login','POST',{username:'superadmin1',password:'superadmin1'})).status,200);
        const uploaded=await legacy('/map','POST',{image:png});assert.equal(uploaded.status,201);assert.equal(uploaded.body.map.blocks[0].floors,2);
        const saved=await legacy('/map','PATCH',{...uploaded.body.map,annotations:[{id:'legacy-marker',type:'block',building:0,x:.5,y:.5}]});assert.equal(saved.status,200);
        const initialized=await legacy('/incident','POST',{mapRevision:saved.body.map.revision});assert.equal(initialized.status,201);assert.equal(initialized.body.preserved,true);
        assert.equal((await store.collection('users').findOne({_id:'201'})).passwordHash,passwordHash);assert.deepEqual(await store.collection('safety_reports').findOne({_id:'legacy:201'}),oldReport);
        assert.equal((await legacy('/auth/login','POST',{username:'201',password:'201'})).status,200);
        assert.equal((await legacy('/reports/mine')).body.report.status,'safe');
      } finally {await new Promise(resolve=>legacyServer.close(resolve));}
    });
    await t.test('database keeps the system data collections and never creates sessions after login or startup', async () => {
      assert.deepEqual((await rawDb.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name).sort(),Object.values(COLLECTION_NAMES).sort());
      const manager=await rawDb.collection('user').findOne({_id:'admin1'});
      assert.equal(manager.role,'admin');assert.equal(manager.recordType,undefined);
      const scopeDb=client.db('separate_record_scope');
      const scoped=await initializeDatabase(scopeDb);
      await scoped.collection('found_items').insertOne({_id:'admin',description:'Same ID, different collection'});
      assert.equal((await scoped.collection('users').findOne({_id:'admin1'})).role,'admin');
      assert.equal((await scoped.collection('found_items').findOne({_id:'admin'})).description,'Same ID, different collection');
      assert.throws(()=>scoped.collection('sessions'),/Unknown system record group/);
      await initializeDatabase(scopeDb);
      assert.deepEqual((await scopeDb.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name).sort(),Object.values(COLLECTION_NAMES).sort());
      assert.equal(await scoped.collection('users').countDocuments(),4);
      assert.equal(await scoped.collection('found_items').countDocuments(),1);
      await scoped.collection('found_items').deleteMany({});
      assert.equal(await scoped.collection('users').countDocuments(),4);
    });
    await t.test('migration preserves IDs, relationships, hashes, photos, and the source; reruns refuse conflicts', async () => {
      const migrationDb=client.db('migration_scope');
      const destination=createStore(migrationDb);
      const entries=[
        ['user',{_id:'admin',role:'admin',passwordHash:'preserved-hash'}],
        ['incident',{_id:'current',incidentId:'incident-1',status:'active'}],
        ['safety_report',{_id:'incident-1:admin',incidentId:'incident-1',userId:'admin',status:'safe'}],
        ['found_item',{_id:'item-1',incidentId:'incident-1',photo:'data:image/jpeg;base64,cGhvdG8='}],
        ['session',{_id:'token-hash',userId:'admin',expiresAt:new Date(Date.now()+60000)}],
      ];
      await migrationDb.collection('FYP-SafetySystem').insertMany(entries.map(([recordType,record])=>({...record,_id:recordType+':'+record._id,recordId:record._id,recordType})));
      const result=await migrateLegacyCollection(migrationDb,destination);assert.equal(result.copied,4);
      const names=['users','incidents','safety_reports','found_items'];
      for(let i=0;i<names.length;i++) assert.deepEqual(await destination.collection(names[i]).findOne({_id:entries[i][1]._id}),entries[i][1]);
      assert.equal(await migrationDb.collection('FYP-SafetySystem').countDocuments(),5);
      assert.ok(!(await migrationDb.listCollections({}, {nameOnly:true}).toArray()).some(c=>c.name==='sessions'));
      assert.equal((await migrateLegacyCollection(migrationDb,destination)).copied,0);
      await destination.collection('users').updateOne({_id:'admin'},{$set:{role:'superadmin'}});
      await destination.collection('found_items').deleteOne({_id:'item-1'});
      await assert.rejects(migrateLegacyCollection(migrationDb,destination),/Conflicting record/);
      assert.equal(await destination.collection('found_items').countDocuments(),0);
      assert.equal((await destination.collection('users').findOne({_id:'admin'})).role,'superadmin');
      assert.equal(await migrationDb.collection('FYP-SafetySystem').countDocuments(),5);
    });
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));await client?.close();
    if(mongo.exitCode===null && !mongoFailure){const exit=once(mongo,'exit');mongo.kill('SIGTERM');await exit;}
    await rm(dataDir,{recursive:true,force:true});
  }
});
