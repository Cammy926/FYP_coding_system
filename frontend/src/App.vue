<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue';
import FloorPlan from './FloorPlan.vue';
import MapEditor from './MapEditor.vue';
import { blockUnitName } from '../../shared/blocks.js';
import { ShieldCheck, LogOut, House, Search, CircleCheck, TriangleAlert, ArrowRight, ArrowLeft, Upload, RefreshCw, Download, PackageSearch, MapPin, Phone, Check, LockKeyhole } from 'lucide-vue-next';

const user = ref(null), incident = ref(null), screen = ref('login'), busy = ref(false), initializing = ref(true);
const error = ref(''), notice = ref(''), online = ref(false), updated = ref(null);
const reports = ref([]), myReport = ref(null), building = ref(0), selectedUnit = ref(null);
const counts = reactive({ safe: 0, help: 0, none: 0 });
const floorSearches = ref([]), floorDraft = ref(null);
const floorMap = computed(() => new Map(floorSearches.value.filter(f => f.building === building.value).map(f => [f.floor, f])));
const floorStatus = floor => floorMap.value.get(floor)?.status || 'not_started';
const searchProgress = computed(() => {
  const selected = screen.value === 'dashboard' ? building.value : null;
  const blocks = mapData.value?.blocks || [];
  const total = blocks.filter(b => selected === null || b.building === selected).reduce((sum, b) => sum + b.floors, 0);
  const records = floorSearches.value.filter(f => selected === null || f.building === selected);
  const cleared = records.filter(f => f.status === 'cleared').length, inaccessible = records.filter(f => f.status === 'inaccessible').length;
  return { total, cleared, inaccessible, pending: total - cleared - inaccessible };
});
function mergeFloorSearches(records) {
  const merged = new Map(floorSearches.value.filter(f => f.incidentId === incident.value?.incidentId).map(f => [f._id, f]));
  for (const record of records) if (!merged.has(record._id) || record.revision >= merged.get(record._id).revision) merged.set(record._id, record);
  floorSearches.value = [...merged.values()];
}
const login = reactive({ username: '', password: '' });
const dashboardReady = ref(false);
const mapData = ref(null), editor = ref(null), mapUnsaved = ref(false), editorKey = ref(0);
const selectedBlock = computed(() => mapData.value?.blocks?.[building.value]);
const safety = reactive({ familyPhone: '', situation: '', location: '', contact: '' });
const reportStep = computed(() => !myReport.value ? 'choice' : myReport.value.detailsSubmittedAt === null ? 'details' : 'complete');
const displayDetail = value => typeof value === 'string' && value.trim() ? value : 'N/A';
const found = reactive({ photo: '', description: '', place: '', category: '', contact: '' });
const keyword = ref(''), items = ref([]), searched = ref(false), item = ref(null);
const clearOpen = ref(false), confirmation = ref('');
const manager = computed(() => user.value && user.value.role !== 'user');

const lostScreen = computed(() => ['lost', 'found', 'items', 'detail'].includes(screen.value));
const urgent = computed(() => reports.value.filter(r => r.status === 'help' && r.building === building.value).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt)));
const floorNumbers = computed(() => incident.value ? Array.from({ length: selectedBlock.value?.floors || 0 }, (_,i) => selectedBlock.value.floors - i) : []);
const reportMap = computed(() => new Map(reports.value.map(r => [`${r.building}:${r.floor}:${r.room}`, r])));
const categories = ['Toys', 'Documents', 'Electronics', 'Clothing', 'Other'];
let timer, mapEvents, polling = false;
const formatTime = value => value ? new Date(value).toLocaleString('en-HK', { timeZone: 'Asia/Hong_Kong', dateStyle: 'medium', timeStyle: 'short' }) : '';
const label = (b, f, r) => blockUnitName(mapData.value.blocks[b], f, r);
const photoUrl = id => `/api/items/${encodeURIComponent(id)}/photo`;
const statusText = status => status === 'safe' ? 'Safe' : status === 'help' ? 'Needs help' : 'No response';

async function api(path, options = {}) {
  let response;
  try { response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }); }
  catch { throw new Error('Cannot reach the backend. Start the system and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const exception = new Error(data.error || 'Cannot reach the backend. Check that it is running.'); exception.status = response.status; throw exception;
  }
  return data;
}
function resetSession() {
  mapEvents?.close(); mapEvents = null; mapData.value = null; mapUnsaved.value = false;
  floorSearches.value = []; floorDraft.value = null;
  user.value = null; incident.value = null; reports.value = []; myReport.value = null; items.value = []; item.value = null;
  login.password = ''; safety.familyPhone = ''; safety.situation = ''; safety.location = ''; safety.contact = '';
  Object.assign(found, { photo: '', description: '', place: '', category: '', contact: '' });
  keyword.value = ''; searched.value = false; screen.value = 'login'; clearOpen.value = false; confirmation.value = ''; selectedUnit.value = null;
}
async function task(work) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await work(); }
  catch (e) { if (e.status === 401 && user.value) resetSession(); error.value = e.message; }
  finally { busy.value = false; }
}
function watchMap() {
  mapEvents?.close(); mapEvents = null;
  if (!manager.value) return;
  mapEvents = new EventSource('/api/map/events');
  const update = () => { if (screen.value !== 'map-editor' && !busy.value) refresh().catch(e => { if (e.status === 401) resetSession(); error.value = e.message; }); };
  mapEvents.addEventListener('map', update);mapEvents.addEventListener('floor-search', update);
}
async function refresh() {
  const current = user.value;
  if (!current) return;
  const data = await api('/incident');
  if (user.value !== current) return;
  incident.value = data.incident;
  if (manager.value) {
    if (screen.value === 'map-editor') return;
    const result = await api('/map'); if (user.value !== current) return;
    const incoming = result.map, previous = mapData.value;
    if (!incoming || !previous || new Date(incoming.createdAt) > new Date(previous.createdAt) || (String(incoming.createdAt) === String(previous.createdAt) && incoming.revision >= previous.revision)) mapData.value = incoming;
    if (!mapData.value || mapData.value.phase !== 'active') {
      screen.value = mapData.value ? 'map-editor' : 'map-upload'; reports.value = []; clearOpen.value = false; return;
    }
    if (['map-upload','setup'].includes(screen.value)) screen.value = 'map';
    const selected = screen.value === 'dashboard' ? building.value : null;
    const dashboard = await api(`/dashboard${selected === null ? '' : '?building=' + selected}`);
    if (user.value !== current || (screen.value === 'dashboard' && building.value !== selected)) return;
    mergeFloorSearches(dashboard.floorSearches || []);
    reports.value = dashboard.reports; Object.assign(counts, dashboard.counts); dashboardReady.value = true;
    if (selectedUnit.value) selectedUnit.value = { ...selectedUnit.value, report: reportMap.value.get(`${selectedUnit.value.building}:${selectedUnit.value.floor}:${selectedUnit.value.room}`) };
  } else {
    const result = await api('/reports/mine'); if (user.value !== current) return; acceptReport(result.report);
  }
  updated.value = new Date();
}
async function uploadMap(event) {
  const file = event.target.files?.[0]; if (!file) return;
  await task(async () => {
    if (file.type !== 'image/png' || file.size > 4 * 1024 * 1024) throw new Error('Choose a PNG map up to 4 MB.');
    const image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Cannot read this map.')); reader.readAsDataURL(file); });
    const result = await api('/map', { method: 'POST', body: { image, ...(mapData.value ? { revision: mapData.value.revision } : {}) } });
    mapData.value = result.map; editorKey.value++; screen.value = 'map-editor';
  });
  event.target.value = '';
}
async function saveMap(fields) { return (await api('/map', { method: 'PATCH', body: fields })).map; }
async function reloadMap() {
  await task(async () => { mapData.value = (await api('/map')).map; mapUnsaved.value = false; editorKey.value++; if (!mapData.value) screen.value = 'map-upload'; });
}
async function editMap() { await task(async () => { mapData.value = (await api('/map')).map; editorKey.value++; screen.value = 'map-editor'; }); }
async function openBlock(index) { await task(async () => { building.value = index; floorDraft.value = null; selectedUnit.value = null; dashboardReady.value = false; screen.value = 'dashboard'; await refresh(); }); }
async function showMap() { floorDraft.value = null; screen.value = 'map'; mapUnsaved.value = false; await task(refresh); }
async function signIn() {
  await task(async () => {
    const data = await api('/auth/login', { method: 'POST', body: login });
    user.value = data.user; login.password = ''; building.value = 0;
    screen.value = manager.value ? 'map' : 'resident';
    await refresh(); watchMap();
  });
}
async function signOut() {
  if (mapUnsaved.value && editor.value && !await editor.value.flush()) return;
  await task(async () => { await api('/auth/logout', { method: 'POST' }); resetSession(); notice.value = 'You have logged out.'; });
}
async function configure(revision) {
  await task(async () => {
    const data = await api('/incident', { method: 'POST', body: { mapRevision: revision } });
    incident.value = data.incident; screen.value = 'map'; mapUnsaved.value = false;
    await refresh(); notice.value = data.preserved ? 'Disaster map initialized. Existing accounts and reports are preserved.' : `${data.count} unit accounts created. Click a block to review its safety reports.`;
  });
}
async function clearSetup() {
  await task(async () => {
    await api('/incident', { method: 'DELETE', body: { confirmation: confirmation.value } });
    incident.value = null; reports.value = []; items.value = []; selectedUnit.value = null; clearOpen.value = false; confirmation.value = '';
    mapData.value = null; floorSearches.value = []; floorDraft.value = null; screen.value = 'map-upload'; notice.value = 'Setup cleared. Upload a new disaster map.';
  });
}
function openFloor(floor) {
  error.value = '';
  const existing = floorMap.value.get(floor);
  floorDraft.value = { incidentId: incident.value.incidentId, building: building.value, floor, status: existing?.status || 'not_started', note: existing?.note || '', revision: existing?.revision || 0 };
}
async function updateFloor(draft) {
  await task(async () => {
    const result = await api(`/floors/${draft.building}/${draft.floor}`, { method: 'PATCH', body: { incidentId: draft.incidentId, status: draft.status, note: draft.note, revision: draft.revision } });
    mergeFloorSearches([result.floorSearch]);floorDraft.value = null;
    notice.value = `${draft.floor}/F search status saved. Resident reports are unchanged.`;
    await refresh();
  });
  if (error.value && user.value) await refresh().catch(() => {});
}
function clearFloor(floor) { return updateFloor({ incidentId: incident.value.incidentId, building: building.value, floor, status: 'cleared', note: '', revision: floorMap.value.get(floor)?.revision || 0 }); }
function acceptReport(report) {
  // An older background poll must not undo a just-saved choice or completion.
  if (!report && myReport.value) return;
  if (report?._id === myReport.value?._id && myReport.value && myReport.value.detailsSubmittedAt !== null && report.detailsSubmittedAt === null) return;
  const hydrate = report && (!myReport.value || myReport.value._id !== report._id);
  myReport.value = report;
  if (hydrate) for (const field of ['familyPhone', 'situation', 'location', 'contact']) safety[field] = report[field] || '';
}
async function focusReport() { await nextTick(); document.getElementById('report-title')?.focus(); }
async function chooseSafety(status) {
  await task(async () => {
    const data = await api('/reports', { method: 'POST', keepalive: true, body: { status } });
    acceptReport(data.report);
    await focusReport();
  });
  if (error.value && incident.value) await refresh().catch(() => {});
}
async function submitSafetyDetails() {
  await task(async () => {
    const data = await api('/reports/mine', { method: 'PATCH', body: { ...safety } });
    acceptReport(data.report);
    await focusReport();
  });
  if (error.value && incident.value) await refresh().catch(() => {});
}
function selectUnit(floor, room) { selectedUnit.value = { building: building.value, floor, room, username: label(building.value,floor,room), report: reportMap.value.get(`${building.value}:${floor}:${room}`) }; }
async function navigate(destination) { if (screen.value === 'map-editor' && editor.value && !await editor.value.flush()) return; screen.value = destination; floorDraft.value = null; error.value = ''; notice.value = ''; clearOpen.value = false; if (destination === 'map') await task(refresh); }
async function loadItems(search = false) {
  await task(async () => {
    if (search && !keyword.value.trim()) throw new Error('Enter a keyword to search.');
    const data = await api(`/items${search ? '?q='+encodeURIComponent(keyword.value.trim()) : ''}`);
    items.value = data.items; searched.value = true; if (!search) screen.value = 'items';
  });
}
async function openItem(id) { await task(async () => { item.value = (await api('/items/'+encodeURIComponent(id))).item; screen.value = 'detail'; }); }
function newFound() { Object.assign(found, { photo: '', description: '', place: '', category: '', contact: '' }); navigate('found'); }
async function readPhoto(event) {
  const input = event.target;
  const file = input.files?.[0]; if (!file) return;
  await task(async () => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG, PNG, or WebP image up to 10 MB.');
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 25000000) { bitmap.close(); throw new Error('Choose an image smaller than 25 megapixels.'); }
    const ratio = Math.min(1, 1200/bitmap.width, 1200/bitmap.height);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width*ratio)); canvas.height = Math.max(1, Math.round(bitmap.height*ratio));
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
    found.photo = canvas.toDataURL('image/jpeg',0.82);
  });
  input.value = '';
}
async function uploadItem() {
  await task(async () => {
    const data = await api('/items', { method: 'POST', body: found });
    item.value = data.item; Object.assign(found, { photo: '', description: '', place: '', category: '', contact: '' }); screen.value = 'detail'; notice.value = 'Found item saved to the database.';
  });
}
async function downloadAccounts() {
  await task(async () => {
    const data = await api('/incident/accounts');
    const rows = [['Account','Initial password','Building','Floor','Room'], ...data.accounts.sort((a,b) => a.building-b.building || a.floor-b.floor || a.room-b.room).map(a => [a.username,a.username,mapData.value.blocks[a.building].accountPrefix || '',a.floor,a.room])];
    const url = URL.createObjectURL(new Blob([rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'unit-accounts.csv'; link.click(); URL.revokeObjectURL(url);
  });
}
onMounted(async () => {
  try { await api('/health'); online.value = true; user.value = (await api('/auth/me')).user; screen.value = manager.value ? 'map' : 'resident'; await refresh(); watchMap(); }
  catch (e) { if (e.status !== 401) error.value = e.message; }
  finally { initializing.value = false; }
  timer = setInterval(async () => {
    if (busy.value || polling || document.hidden) return;
    polling = true;
    try { await api('/health'); online.value = true; if (user.value) await refresh(); }
    catch (e) { online.value = false; if (e.status === 401) { resetSession(); error.value = e.message; } else if (user.value) error.value = e.message; }
    finally { polling = false; }
  }, 5000);
});
onUnmounted(() => { clearInterval(timer); mapEvents?.close(); });
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark"><ShieldCheck :size="25" /></div><div><strong>Auto Safety Report</strong><small>Emergency coordination · 報平安</small></div></div>
      <div class="top-actions"><span class="session-tag">{{ user ? manager ? `Responder · ${user.role === 'superadmin' ? 'Super Admin' : 'Admin'}` : `Resident · Unit ${user.username}` : 'Safety reporting + Lost & Found' }}</span><button v-if="user" class="logout" :disabled="busy" @click="signOut"><LogOut :size="16" />Log out</button></div>
    </header>
    <div class="statusbar"><span><i class="connection-dot" :class="{ online }"></i>{{ online ? 'Database connected' : 'Connecting to backend' }}</span><span>Local development · Notifications & AI search deferred</span></div>
    <div class="app-body" :class="{ 'with-navigation': user && incident }">
    <main :aria-busy="busy || initializing">
      <div v-if="error" class="message error" role="alert"><TriangleAlert :size="19"/><span>{{ error }}</span><button aria-label="Dismiss error" @click="error=''">×</button></div>
      <div v-if="notice" class="message success" role="status"><Check :size="19"/><span>{{ notice }}</span><button aria-label="Dismiss notice" @click="notice=''">×</button></div>
      <div v-if="initializing" class="empty-state">Connecting to your system…</div>

      <section v-else-if="screen === 'login'" class="login-layout">
        <div class="hero"><div><span class="eyebrow">Community safety platform</span><h1>Know who is safe.<br>Find who needs help.</h1><p>A clear connection between residents and responders, when every update matters.</p></div><div class="hero-flow"><span><CircleCheck :size="18"/>Report safety or request help</span><span><House :size="18"/>Review unit status by location</span><span><PackageSearch :size="18"/>Reconnect lost items with owners</span></div></div>
        <form class="card login-form" @submit.prevent="signIn"><span class="eyebrow">Welcome back</span><h2>Sign in</h2><p>Use your responder account or the account assigned to your unit.</p><label class="field"><span>Account name</span><input v-model="login.username" required maxlength="40" autocomplete="username" placeholder="e.g. 204 or A-204" :disabled="busy"></label><label class="field"><span>Password</span><input v-model="login.password" required maxlength="200" type="password" autocomplete="current-password" placeholder="Enter your password" :disabled="busy"></label><button class="primary full" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}<ArrowRight :size="18"/></button><div class="hint"><LockKeyhole :size="15"/>Local test accounts: superadmin / superadmin · admin / admin. Only Super Admin can sign in before the disaster map is initialized.</div></form>
      </section>

      <section v-else-if="screen === 'map-upload' && user?.role === 'superadmin'" class="narrow">
        <div class="card map-upload"><span class="eyebrow">Super Admin · First step</span><h2>Upload the disaster area map</h2><p>Choose a PNG map. Next, label each building and add boundaries, notes, or emoji before initializing.</p><label class="map-upload-box"><Upload :size="42"/><strong>Choose a PNG map</strong><span>Up to 4 MB · PNG only</span><input aria-label="Disaster map PNG" type="file" accept="image/png" :disabled="busy" @change="uploadMap"></label><p v-if="incident" class="hint">Your existing unit accounts and safety reports will be preserved. Place labels for their building blocks to finish map setup.</p></div>
      </section>
      <MapEditor v-else-if="screen === 'map-editor' && mapData && user?.role === 'superadmin'" :key="editorKey" ref="editor" :map="mapData" :save="saveMap" :initializing="busy" @saved="mapData=$event" @dirty="mapUnsaved=$event" @initialize="configure" @exit="showMap" @reload="reloadMap"/>
      <section v-else-if="screen === 'map' && mapData?.phase === 'active'">
        <div class="page-head"><div><span class="eyebrow">Responder workspace · Disaster map</span><h2>{{ mapData.name }}</h2><p>Click a building block to see only that block’s emergency situation.</p></div><div class="actions"><button :disabled="busy" @click="task(refresh)"><RefreshCw :size="16"/>Refresh</button><button v-if="user.role === 'superadmin'" :disabled="busy" @click="editMap">Edit map</button><button v-if="user.role === 'superadmin'" class="clear-button" :disabled="busy" @click="clearOpen=!clearOpen; confirmation=''"><span>Clear Setup</span></button></div></div>
        <div v-if="clearOpen" class="card clear-confirm"><h3>Delete this disaster’s data?</h3><p>This deletes its map, unit accounts, reports, and found items. Manager accounts remain.</p><form @submit.prevent="clearSetup"><label class="field"><span>Type CLEAR to confirm</span><input v-model="confirmation" autocomplete="off"></label><button class="danger" :disabled="busy || confirmation !== 'CLEAR'">Delete disaster data</button></form></div>
        <FloorPlan :map="mapData" @open="openBlock"/><div class="map-block-links" aria-label="Building blocks"><button v-for="block in mapData.blocks" :key="block.building" :disabled="busy" @click="openBlock(block.building)">{{ block.label }} · {{ block.floors }} floors · {{ block.rooms }} units per floor<ArrowRight :size="16"/></button></div>
      </section>
      <section v-else-if="screen === 'dashboard' && incident && selectedBlock">
        <button class="back-link" :disabled="busy" @click="showMap"><ArrowLeft :size="17"/>Back to disaster map</button>
        <div class="page-head"><div><span class="eyebrow">Responder workspace · Safety overview</span><h2>{{ selectedBlock.label }} · {{ mapData.name }}</h2><p>{{ selectedBlock.floors }} floors · {{ selectedBlock.rooms }} units per floor</p></div><div class="actions compact"><button :disabled="busy" @click="task(refresh)"><RefreshCw :size="16"/>Refresh</button><button :disabled="busy" @click="downloadAccounts"><Download :size="16"/>Unit accounts</button></div></div>
        <div v-if="clearOpen" class="card clear-confirm" role="region" aria-label="Confirm clear setup"><h3>Delete this disaster’s data?</h3><p>This permanently deletes its layout, unit accounts, safety reports, and found items. Admin and Super Admin accounts remain.</p><form @submit.prevent="clearSetup"><label class="field"><span>Type CLEAR to confirm</span><input v-model="confirmation" autocomplete="off" :disabled="busy"></label><div class="actions compact"><button class="danger" :disabled="busy || confirmation !== 'CLEAR'">{{ busy ? 'Clearing…' : 'Delete disaster data' }}</button><button type="button" :disabled="busy" @click="clearOpen=false">Cancel</button></div></form></div>
        <div v-if="!dashboardReady" class="card empty-state" role="status">Loading this block’s safety reports…</div><template v-else>
        <div class="summary search-summary"><div class="metric help"><span>Needs help</span><strong>{{ counts.help }}</strong></div><div class="metric safe"><span>Reported safe</span><strong>{{ counts.safe }}</strong></div><div class="metric"><span>No response</span><strong>{{ counts.none }}</strong></div><div class="metric floor-progress" aria-label="Floor search progress"><span>Floors cleared</span><strong>{{ searchProgress.cleared }} <small>/ {{ searchProgress.total }}</small></strong><progress :max="searchProgress.total || 1" :value="searchProgress.cleared" aria-label="Floors searched"></progress><small>{{ searchProgress.inaccessible }} inaccessible · {{ searchProgress.pending }} pending</small></div></div>
        <div class="priority"><h3><TriangleAlert :size="19"/>Urgent help requests · {{ selectedBlock.label }}</h3><p v-if="!urgent.length">No help requests reported for this building.</p><div v-else class="help-list"><button v-for="report in urgent" :key="report._id" @click="selectUnit(report.floor,report.room)"><strong>Unit {{ report.username }}</strong><span>{{ displayDetail(report.situation) }} · Location: {{ displayDetail(report.location) }}</span><ArrowRight :size="16"/></button></div></div>
        <div class="card grid-panel"><div class="panel-head"><h3>Unit status by floor</h3><small>Refreshes every 5 seconds{{ updated ? ' · '+formatTime(updated) : '' }}</small></div><div class="legend"><span><i class="swatch safe"></i>Safe</span><span><i class="swatch help"></i>Needs help</span><span><i class="swatch none"></i>No response</span><span><i class="swatch searched"></i>Floor searched</span><span><i class="swatch inaccessible"></i>Floor inaccessible</span></div><div class="grid-scroll"><div class="unit-grid" :style="{ gridTemplateColumns: `150px repeat(${selectedBlock.rooms}, minmax(62px,1fr))`, minWidth: `${150+selectedBlock.rooms*67}px` }"><div class="grid-label">Floor</div><div v-for="r in selectedBlock.rooms" :key="'h'+r" class="grid-label">Room {{ String(r).padStart(2,'0') }}</div><template v-for="f in floorNumbers" :key="f"><div class="grid-label floor-label floor-control" :class="{ searched: floorStatus(f) === 'cleared', inaccessible: floorStatus(f) === 'inaccessible' }" :data-floor="f"><strong>{{ f }} / F</strong><span v-if="floorStatus(f) === 'cleared'" class="floor-badge">✓ Cleared</span><span v-else-if="floorStatus(f) === 'inaccessible'" class="floor-badge">⚠ Inaccessible</span><small v-if="floorMap.get(f)?.note" class="floor-note" :title="floorMap.get(f).note">{{ floorMap.get(f).note }}</small><div class="floor-actions"><button :aria-label="`Clear floor ${f}`" :disabled="busy || floorStatus(f) === 'cleared'" @click="clearFloor(f)">Clear</button><button :aria-label="`Edit search status for floor ${f}`" :disabled="busy" @click="openFloor(f)">Note / status</button></div></div><button v-for="r in selectedBlock.rooms" :key="`${f}:${r}`" class="unit-cell" :class="[reportMap.get(`${building}:${f}:${r}`)?.status || 'none', { searched: floorStatus(f) === 'cleared', inaccessible: floorStatus(f) === 'inaccessible' }]" :aria-label="`Unit ${label(building,f,r)}: ${statusText(reportMap.get(`${building}:${f}:${r}`)?.status)}`" @click="selectUnit(f,r)">{{ label(building,f,r) }}<span>{{ statusText(reportMap.get(`${building}:${f}:${r}`)?.status) }}</span></button></template></div></div>
        <div v-if="selectedUnit" class="unit-detail" tabindex="0"><h3>Unit {{ selectedUnit.username }} · {{ statusText(selectedUnit.report?.status) }}</h3><template v-if="selectedUnit.report"><dl><template v-if="selectedUnit.report.status === 'help'"><dt>Situation</dt><dd>{{ displayDetail(selectedUnit.report.situation) }}</dd><dt>Current location</dt><dd>{{ displayDetail(selectedUnit.report.location) }}</dd><dt>Contact</dt><dd>{{ displayDetail(selectedUnit.report.contact) }}</dd></template><template v-else><dt>Family contact</dt><dd>{{ displayDetail(selectedUnit.report.familyPhone) }}</dd></template><dt>Reported</dt><dd>{{ formatTime(selectedUnit.report.createdAt) }} (HKT)</dd></dl></template><p v-else>No safety report has been submitted by this unit.</p></div></div><p class="footnote">Each account represents one unit. A report does not verify the safety of every person in the household. “Cleared” means the floor was searched; it does not change resident safe/help reports.</p></template>
      </section>

      <section v-else-if="screen === 'resident' && incident" class="resident-main">
        <div class="page-head"><div><span class="eyebrow">Resident check-in · 報平安</span><h2 id="report-title" tabindex="-1">{{ reportStep === 'choice' ? 'Are you safe?' : reportStep === 'details' ? myReport.status === 'safe' ? 'You reported safe' : 'Your help request is saved' : myReport.status === 'safe' ? 'Remain in a safe area' : 'Please stay calm' }}</h2><p>{{ incident.name }} · Unit {{ user.username }}</p></div></div>
        <div v-if="reportStep === 'choice'" class="status-choices" aria-label="Choose your safety status">
          <button class="status-choice safe-button" :disabled="busy" @click="chooseSafety('safe')"><CircleCheck :size="44"/><span>Safe</span></button>
          <button class="status-choice danger" :disabled="busy" @click="chooseSafety('help')"><TriangleAlert :size="44"/><span>I need help</span></button>
        </div>
        <form v-else-if="reportStep === 'details'" class="report-card" :class="myReport.status" @submit.prevent="submitSafetyDetails">
          <p class="status-saved" role="status"><Check :size="18"/>Your {{ myReport.status === 'safe' ? 'safe status' : 'help request' }} is already saved and visible to responders.</p>
          <template v-if="myReport.status === 'safe'">
            <label class="field"><span>Family member’s WhatsApp phone number <small>(optional)</small></span><input v-model="safety.familyPhone" type="tel" maxlength="30" autocomplete="tel" placeholder="e.g. +852 9123 4567" :disabled="busy"></label>
            <p class="hint">You can leave this blank. WhatsApp notifications will be enabled later.</p>
          </template>
          <template v-else>
            <p>You can leave every field blank and submit immediately.</p>
            <label class="field"><span>What is happening? <small>(optional)</small></span><textarea v-model="safety.situation" maxlength="1500" placeholder="Describe your situation if you can." :disabled="busy"></textarea></label>
            <label class="field"><span>Where are you now? <small>(optional)</small></span><input v-model="safety.location" maxlength="200" placeholder="e.g. Building A, third-floor stairwell" :disabled="busy"></label>
            <label class="field"><span>Your phone number <small>(optional)</small></span><input v-model="safety.contact" type="tel" maxlength="30" autocomplete="tel" placeholder="e.g. +852 9123 4567" :disabled="busy"></label>
          </template>
          <button class="full" :class="myReport.status === 'safe' ? 'safe-button' : 'danger'" :disabled="busy">{{ busy ? 'Submitting…' : 'Submit' }}<ArrowRight :size="18"/></button>
        </form>
        <div v-else class="report-confirmation" :class="myReport.status" role="status">
          <CircleCheck v-if="myReport.status === 'safe'" :size="52"/><TriangleAlert v-else :size="52"/>
          <h3>{{ myReport.status === 'safe' ? 'Your safe report has been saved.' : 'Your request is visible to the rescue team.' }}</h3>
          <p v-if="myReport.status === 'safe'">Please remain in a safe area.</p>
          <p v-else>Please stay calm and wait for rescue assistance. Responders can contact you using any phone number you provided.</p>
          <a class="emergency-call" href="tel:999"><Phone :size="22"/>In an emergency, call 999</a>
          <small>Reported {{ formatTime(myReport.createdAt) }} (HKT)</small>
        </div>
      </section>

      <section v-else-if="screen === 'lost'" class="lost-main"><div class="page-head"><div><span class="eyebrow">Community belongings</span><h2>Lost & Found</h2><p>Find a belonging, or help return one to its owner.</p></div><PackageSearch class="page-icon" :size="44"/></div><div class="card"><h3>I lost something</h3><p>Search descriptions, locations, and categories.</p><form class="search-row" @submit.prevent="loadItems(true)"><label class="field"><span>Keywords</span><input v-model="keyword" maxlength="100" placeholder="e.g. Mickey Mouse toy" :disabled="busy"></label><button class="primary" :disabled="busy"><Search :size="17"/>Search</button></form><div class="deferred"><LockKeyhole :size="16"/><span>AI photo search will be added later. You can search by keywords now.</span></div><template v-if="searched"><p class="result-count">{{ items.length }} matching item{{ items.length===1?'':'s' }}</p><div v-if="!items.length" class="empty-state">No matches yet. Try different keywords or browse all items.</div><div class="item-list"><button v-for="entry in items" :key="entry._id" class="item-row" :disabled="busy" @click="openItem(entry._id)"><img :src="photoUrl(entry._id)" alt="Found item"><span><strong>{{ entry.description }}</strong><small>{{ entry.category }} · {{ entry.place }}</small></span><ArrowRight :size="18"/></button></div></template></div><div class="card found-callout"><div><span class="eyebrow">Help reunite an item</span><h3>I found something</h3><p>Post a photo and details so its owner can contact you.</p></div><div class="actions"><button class="primary" :disabled="busy" @click="newFound"><Upload :size="17"/>I Found Something</button><button :disabled="busy" @click="loadItems(false)">Show all items<ArrowRight :size="17"/></button></div></div></section>

      <section v-else-if="screen === 'found'" class="narrow"><button class="back-link" :disabled="busy" @click="navigate('lost')"><ArrowLeft :size="17"/>Back to Lost & Found</button><form class="card" @submit.prevent="uploadItem"><span class="eyebrow">Lost & Found · New report</span><h2>Report a found item</h2><p>Include clear details to help its owner recognise it.</p><label class="field"><span>Photo of the item</span><input type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy" @change="readPhoto"><small>JPEG, PNG, or WebP up to 10 MB. Photos are resized before saving.</small></label><img v-if="found.photo" class="photo-preview" :src="found.photo" alt="Found item preview"><label class="field"><span>Description</span><textarea v-model="found.description" required maxlength="1500" placeholder="e.g. Mickey Mouse toy with red shorts" :disabled="busy"></textarea></label><label class="field"><span>Place found</span><input v-model="found.place" required maxlength="200" placeholder="e.g. Near Building A lobby" :disabled="busy"></label><label class="field"><span>Category</span><select v-model="found.category" required :disabled="busy"><option value="" disabled>Select a category</option><option v-for="category in categories" :key="category">{{ category }}</option></select></label><label class="field"><span>Finder contact</span><input v-model="found.contact" required maxlength="120" placeholder="Phone number or email" :disabled="busy"></label><button class="primary full" :disabled="busy || !found.photo"><Upload :size="18"/>{{ busy ? 'Saving…' : 'Upload found item' }}</button></form></section>

      <section v-else-if="screen === 'items'" class="lost-main"><button class="back-link" :disabled="busy" @click="navigate('lost')"><ArrowLeft :size="17"/>Back to Lost & Found</button><div class="page-head"><div><span class="eyebrow">Lost & Found · Browse</span><h2>All found items</h2><p>{{ items.length }} item{{ items.length===1?'':'s' }} reported for this disaster.</p></div><button :disabled="busy" @click="loadItems(false)"><RefreshCw :size="17"/>Refresh</button></div><div v-if="!items.length" class="card empty-state"><PackageSearch :size="42"/><h3>No items reported yet</h3><p>Found something? Add the first report.</p><button class="primary" @click="newFound">I Found Something</button></div><div class="item-list"><button v-for="entry in items" :key="entry._id" class="item-row" :disabled="busy" @click="openItem(entry._id)"><img :src="photoUrl(entry._id)" alt="Found item"><span><strong>{{ entry.description }}</strong><small>{{ entry.category }} · {{ entry.place }}</small><small>{{ formatTime(entry.createdAt) }}</small></span><ArrowRight :size="18"/></button></div></section>

      <section v-else-if="screen === 'detail' && item" class="lost-main"><button class="back-link" :disabled="busy" @click="loadItems(false)"><ArrowLeft :size="17"/>Back to items</button><div class="card item-detail"><img :src="photoUrl(item._id)" alt="Photo of the found item"><div><span class="eyebrow">Found item · {{ item.category }}</span><h2>{{ item.description }}</h2><dl><dt><MapPin :size="16"/>Place found</dt><dd>{{ item.place }}</dd><dt><Phone :size="16"/>Finder contact</dt><dd>{{ item.contact }}</dd><dt>Reported by</dt><dd>{{ item.createdBy }}</dd><dt>Reported at</dt><dd>{{ formatTime(item.createdAt) }} (HKT)</dd></dl><p class="hint">Contact the finder and describe identifying details to arrange a return.</p></div></div></section>
      <div v-if="floorDraft && manager" class="map-modal-backdrop"><form class="card map-modal" role="dialog" aria-modal="true" :aria-label="`Floor ${floorDraft.floor} search status`" @submit.prevent="updateFloor(floorDraft)"><h3>{{ floorDraft.floor }} / F · Search status</h3><p v-if="error" class="message error" role="alert">{{ error }}</p><label class="field"><span>Search status</span><select aria-label="Search status" v-model="floorDraft.status" :disabled="busy"><option value="not_started">Not yet searched / reopen</option><option value="cleared">Cleared — search completed</option><option value="inaccessible">Inaccessible — cannot search</option></select></label><label class="field"><span>Floor note {{ floorDraft.status === 'inaccessible' ? '(required)' : '(optional)' }}</span><textarea v-model="floorDraft.note" aria-label="Floor note" maxlength="300" :required="floorDraft.status === 'inaccessible'" :disabled="busy" placeholder="e.g. Fire blocks the stairwell"></textarea></label><p class="hint">These changes update search progress only. Existing safe/help reports remain visible.</p><div class="actions"><button class="primary" :disabled="busy">Save floor status</button><button type="button" :disabled="busy" @click="floorDraft=null">Cancel</button><button type="button" :disabled="busy" @click="openFloor(floorDraft.floor)">Reload latest status</button></div></form></div>
    </main>
    <nav v-if="user && incident" class="bottom-nav" aria-label="Main navigation"><button :disabled="busy" :aria-current="!lostScreen ? 'page' : undefined" :class="{ selected: !lostScreen }" @click="navigate(manager ? 'map' : 'resident')"><House :size="21"/>報平安 · Safety</button><button :disabled="busy" :aria-current="lostScreen ? 'page' : undefined" :class="{ selected: lostScreen }" @click="navigate('lost')"><Search :size="21"/>Lost & Found</button></nav>
    </div>
    <footer>Auto Safety Report · Final Year Project · Localhost testing</footer>
  </div>
</template>
