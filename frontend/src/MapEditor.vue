<script setup>
import { ref, computed, onBeforeUnmount, onMounted } from 'vue';
import FloorPlan from './FloorPlan.vue';
import { codeFromLabel, blockUnitName } from '../../shared/blocks.js';
const props = defineProps({ map: { type: Object, required: true }, save: { type: Function, required: true }, initializing: Boolean });
const emit = defineEmits(['saved', 'initialize', 'exit', 'reload', 'dirty']);
const copy = value => JSON.parse(JSON.stringify(value));
const model = ref(copy(props.map)), revision = ref(props.map.revision), tool = ref('select');
const color = ref('#ed2024'), width = ref(4), selected = ref(null), preview = ref(null), saving = ref(false), error = ref('');
const blockSize = ref(null);
const modal = ref(null), history = ref([]), pending = ref(null);
const layoutLocked = computed(() => model.value.phase === 'active' || !!model.value.incidentId);
const chosen = computed(() => model.value.annotations.find(a => a.id === selected.value));
const canDelete = computed(() => chosen.value && !(layoutLocked.value && chosen.value.type === 'block'));
const unplaced = computed(() => model.value.blocks.filter(b => !model.value.annotations.some(a => a.type === 'block' && a.building === b.building)));
const modalPrefix = computed(() => modal.value ? codeFromLabel(modal.value.label) || modal.value.accountPrefix : '');
const ready = computed(() => model.value.blocks.length > 0 && !unplaced.value.length && !pending.value && !saving.value && !error.value && !modal.value);
let timeout, running, gesture, placing = null, alive = true;
const fields = () => copy({ name: model.value.name, blocks: model.value.blocks, annotations: model.value.annotations });
const dirty = () => emit('dirty', !!pending.value || saving.value || !!error.value);
function remember() { history.value.push(fields()); if (history.value.length > 25) history.value.shift(); }
function changed() { pending.value = fields(); clearTimeout(timeout); error.value = ''; dirty(); timeout = setTimeout(() => flush(), 300); }
async function flush() {
  clearTimeout(timeout);
  if (running) { await running; if (pending.value && !error.value) return flush(); return !error.value; }
  if (!pending.value) return !error.value;
  running = (async () => {
    saving.value = true; dirty();
    try {
      while (pending.value && alive) {
        const snapshot = pending.value; pending.value = null;
        try {
          const saved = await props.save({ ...snapshot, revision: revision.value });
          revision.value = saved.revision; emit('saved', saved);
        } catch (failure) { if (!pending.value) pending.value = snapshot; error.value = failure.message; break; }
      }
    } finally { saving.value = false; dirty(); }
  })();
  await running; running = null; return !error.value;
}
async function initialize() { if (await flush()) emit('initialize', revision.value); }
async function exit() { if (await flush()) emit('exit'); }
function undo() { if (!history.value.length) return; Object.assign(model.value, history.value.pop()); selected.value = null; changed(); }
function removeSelected() {
  if (!canDelete.value) return;
  remember(); const a = chosen.value;
  if (a.type === 'block') {
    model.value.blocks.splice(a.building, 1); model.value.blocks.forEach((b, i) => b.building = i);
    model.value.annotations = model.value.annotations.filter(item => item.id !== a.id);
    model.value.annotations.forEach(item => { if (item.type === 'block' && item.building > a.building) item.building--; });
  } else model.value.annotations = model.value.annotations.filter(item => item.id !== a.id);
  selected.value = null; changed();
}
function placeBlock(building) { placing = building; tool.value = 'block'; selected.value = null; }
function editBlock(block) {
  const marker = model.value.annotations.find(a => a.type === 'block' && a.building === block.building);
  if (!marker) { placeBlock(block.building); return; }
  modal.value = { type: 'block', building: block.building, label: block.label, accountPrefix: block.accountPrefix, floors: block.floors, rooms: block.rooms, x: marker.x, y: marker.y, markerId: marker.id };
}
function start(p) {
  if (modal.value || props.initializing) return;
  if (tool.value === 'block') {
    const existing = placing !== null ? model.value.blocks[placing] : unplaced.value[0]; placing = null;
    if (!existing && (layoutLocked.value || model.value.blocks.length >= 8)) { error.value = 'All building labels are placed. Use Select / move to reposition them.'; return; }
    const building = existing?.building ?? model.value.blocks.length;
    const nextPrefix = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ').find(code => !model.value.blocks.some(b => b.accountPrefix === code || codeFromLabel(b.label) === code));
    modal.value = { type: 'block', building, label: existing?.label || `Block ${nextPrefix}`, accountPrefix: existing?.accountPrefix ?? nextPrefix, floors: existing?.floors || 20, rooms: existing?.rooms || 8, x: p.x, y: p.y };
    return;
  }
  if (tool.value === 'text') { modal.value = { type: 'text', text: '', fontSize: 20, x: p.x, y: p.y }; return; }
  if (tool.value === 'select') {
    selected.value = p.id || null;
    const a = chosen.value;
    if (a) { blockSize.value = p.size; gesture = { start: p, original: copy(a), box: p.size, resize: p.resize && a.type === 'block', moved: false }; }
    return;
  }
  gesture = { start: p };
  preview.value = tool.value === 'pen' ? { id: 'preview', type: 'pen', color: color.value, width: width.value, points: [p] } : { id: 'preview', type: 'rectangle', x: p.x, y: p.y, w: 0, h: 0, color: color.value, width: width.value };
}
function move(p) {
  if (!gesture) return;
  if (tool.value === 'select') {
    const original = gesture.original, a = chosen.value; if (!a) return;
    if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > .002) { remember(); gesture.moved = true; }
    if (!gesture.moved) return;
    if (gesture.resize) {
      const left = Math.max(0, original.x - gesture.box.w / 2), top = Math.max(0, original.y - gesture.box.h / 2);
      a.w = Math.max(.04, Math.min(1 - left, p.x - left)); a.h = Math.max(.03, Math.min(1 - top, p.y - top));
      a.x = Math.min(1 - a.w / 2, left + a.w / 2); a.y = Math.min(1 - a.h / 2, top + a.h / 2); return;
    }
    const points = original.type === 'block' ? [{ x: original.x - gesture.box.w / 2, y: original.y - gesture.box.h / 2 }, { x: original.x + gesture.box.w / 2, y: original.y + gesture.box.h / 2 }] : original.type === 'pen' ? original.points : [{ x: original.x, y: original.y }, { x: original.x + (original.w || 0), y: original.y + (original.h || 0) }];
    const dx = Math.max(-Math.min(...points.map(p => p.x)), Math.min(1 - Math.max(...points.map(p => p.x)), p.x - gesture.start.x));
    const dy = Math.max(-Math.min(...points.map(p => p.y)), Math.min(1 - Math.max(...points.map(p => p.y)), p.y - gesture.start.y));
    if (a.type === 'pen') a.points = original.points.map(p => ({ x: p.x + dx, y: p.y + dy })); else { a.x = original.x + dx; a.y = original.y + dy; }
  } else if (preview.value?.type === 'pen') {
    const points = preview.value.points, last = points.at(-1);
    if (points.length < 1200 && Math.hypot(p.x - last.x, p.y - last.y) > .001) points.push({ x: p.x, y: p.y });
  } else if (preview.value) Object.assign(preview.value, { x: Math.min(p.x, gesture.start.x), y: Math.min(p.y, gesture.start.y), w: Math.abs(p.x - gesture.start.x), h: Math.abs(p.y - gesture.start.y) });
}
function end(p) {
  if (!gesture) return;
  move(p);
  if (tool.value === 'select') { if (gesture.moved) changed(); }
  else if (preview.value && (preview.value.type === 'pen' ? preview.value.points.length > 1 : preview.value.w >= .001 && preview.value.h >= .001)) {
    remember(); const a = copy(preview.value); a.id = crypto.randomUUID(); model.value.annotations.push(a); selected.value = a.id; changed();
  }
  gesture = null; preview.value = null;
}
function cancel() { if (gesture?.moved && chosen.value) { const index = model.value.annotations.findIndex(a => a.id === selected.value); model.value.annotations[index] = copy(gesture.original); history.value.pop(); } gesture = null; preview.value = null; }
function currentBlockSize() { return { w: chosen.value?.w ?? blockSize.value?.w ?? .12, h: chosen.value?.h ?? blockSize.value?.h ?? .08 }; }
function resizeSelected(axis, percentage) {
  if (chosen.value?.type !== 'block' || props.initializing) return;
  const value = Number(percentage); if (!Number.isFinite(value)) return;
  const dimensions = currentBlockSize(); dimensions.w = Math.max(.04, Math.min(1, dimensions.w)); dimensions.h = Math.max(.03, Math.min(1, dimensions.h)); dimensions[axis] = Math.max(axis === 'w' ? .04 : .03, Math.min(1, value / 100));
  remember(); Object.assign(chosen.value, dimensions);
  chosen.value.x = Math.max(dimensions.w / 2, Math.min(1 - dimensions.w / 2, chosen.value.x));
  chosen.value.y = Math.max(dimensions.h / 2, Math.min(1 - dimensions.h / 2, chosen.value.y)); changed();
}
function setLabelFontSize(value) {
  if (chosen.value?.type !== 'block' || props.initializing) return;
  const automatic = value.trim() === '';
  const fontSize = automatic ? undefined : Math.max(8, Math.min(72, Math.round(Number(value))));
  if ((!automatic && !Number.isFinite(fontSize)) || chosen.value.fontSize === fontSize) return;
  remember();
  if (automatic) delete chosen.value.fontSize; else chosen.value.fontSize = fontSize;
  changed();
}
function resizeKey(event) { selected.value = event.id; blockSize.value = event.size; resizeSelected(event.axis, currentBlockSize()[event.axis] * 100 + event.delta); }
function confirmModal() {
  const m = modal.value;
  const label = m.type === 'block' ? m.label.trim() : m.text.trim();
  if (!label) return;
  if (m.type === 'block' && model.value.blocks.some(b => b.building !== m.building && b.label.toLowerCase() === label.toLowerCase())) { error.value = 'Block labels must be unique.'; return; }
  const accountPrefix = layoutLocked.value ? model.value.blocks[m.building]?.accountPrefix : modalPrefix.value;
  if (m.type === 'block') {
    if (layoutLocked.value && codeFromLabel(label) && codeFromLabel(label) !== (accountPrefix || codeFromLabel(model.value.blocks[m.building].label))) { error.value = 'Keep the initialized block letter when editing its label.'; return; }
    if (accountPrefix !== '' && !/^[A-Z]$/.test(accountPrefix || '')) { error.value = 'Choose an account prefix from A to Z.'; return; }
    if (model.value.blocks.some(b => b.building !== m.building && b.accountPrefix === accountPrefix)) { error.value = 'Each block must have a different account prefix.'; return; }
  }
  remember();
  if (m.type === 'block') {
    model.value.blocks[m.building] = { building: m.building, label, accountPrefix, floors: m.floors, rooms: m.rooms };
    let marker = model.value.annotations.find(a => a.type === 'block' && a.building === m.building);
    if (!marker) { marker = { id: crypto.randomUUID(), type: 'block', building: m.building }; model.value.annotations.push(marker); }
    Object.assign(marker, { x: m.x, y: m.y }); selected.value = marker.id;
  } else {
    const note = { id: crypto.randomUUID(), type: 'text', text: label, fontSize: m.fontSize, color: color.value, x: m.x, y: m.y };
    model.value.annotations.push(note); selected.value = note.id;
  }
  modal.value = null; tool.value = 'select'; changed();
}
function beforeUnload(event) { if (pending.value || saving.value) { event.preventDefault(); event.returnValue = ''; } }
function keydown(event) { if ((event.key === 'Delete' || event.key === 'Backspace') && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !modal.value) { event.preventDefault(); removeSelected(); } }
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', keydown); });
onBeforeUnmount(() => { alive = false; clearTimeout(timeout); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown); });
defineExpose({ flush });
</script>
<template>
  <section class="map-editor">
    <div class="page-head"><div><span class="eyebrow">Super Admin · Disaster map editor</span><h2>{{ model.phase === 'active' ? 'Edit disaster map' : 'Set up the disaster area' }}</h2><p>Place each building label, then add boundaries, notes, and emoji.</p></div><div class="actions"><span class="save-state" role="status">{{ error ? 'Changes not saved' : saving || pending ? 'Saving…' : 'All changes saved' }}</span><button v-if="model.phase === 'active'" :disabled="!!error || initializing" @click="exit">View disaster map</button><button v-else class="primary" :disabled="!ready || initializing" @click="initialize">{{ initializing ? 'Initializing…' : 'Initialize' }}</button></div></div>
    <div v-if="error" class="message error" role="alert"><span>{{ error }}</span><button @click="error=''; flush()">Retry save</button><button @click="emit('reload')">Reload saved map</button></div>
    <div class="map-toolbar" aria-label="Map drawing tools">
      <button v-for="entry in [['select','Select / move'],['pen','Pen'],['rectangle','Boundary'],['block','Building block'],['text','Text / emoji']]" :key="entry[0]" :class="{ active: tool === entry[0] }" :aria-pressed="tool === entry[0]" :disabled="initializing" @click="tool=entry[0]; selected=null">{{ entry[1] }}</button>
      <label class="tool-color">Color<input v-model="color" aria-label="Drawing color" type="color"></label><label class="tool-width">Width<input v-model.number="width" aria-label="Pen width" type="number" min="1" max="12"></label>
      <button :disabled="!canDelete || initializing" @click="removeSelected">Delete selected</button><button :disabled="!history.length || initializing" @click="undo">Undo</button>
    </div>
    <p class="map-instruction">{{ tool === 'block' ? 'Click the map to place a building label and set its floors and units.' : tool === 'text' ? 'Click the map to add a note or emoji.' : tool === 'select' ? 'Drag a selected label to move it. Drag its corner handle, or use Block size, to resize it.' : 'Drag on the map to draw.' }}</p>
    <div class="map-workspace"><FloorPlan :map="model" editable :tool="tool" :selected="selected" :preview="preview" @start="start" @move="move" @end="end" @cancel="cancel" @resize-key="resizeKey"/>
      <aside class="card block-settings"><label class="field"><span>Disaster name</span><input v-model="model.name" maxlength="100" required :disabled="initializing" @change="remember(); changed()"></label><section v-if="chosen?.type === 'block'" class="block-size-controls" aria-label="Selected block size"><h3>Block size</h3><label class="field"><span>Block width (% of map)</span><input type="number" min="4" max="100" step="0.1" :value="Math.round(currentBlockSize().w * 1000) / 10" :disabled="initializing" @change="resizeSelected('w', $event.target.value)"></label><label class="field"><span>Block height (% of map)</span><input type="number" min="3" max="100" step="0.1" :value="Math.round(currentBlockSize().h * 1000) / 10" :disabled="initializing" @change="resizeSelected('h', $event.target.value)"></label><label class="field"><span>Label font size (px)</span><input aria-label="Label font size (px)" aria-describedby="label-font-hint" type="number" min="8" max="72" step="1" :value="chosen.fontSize ?? ''" placeholder="Automatic" :disabled="initializing" @change="setLabelFontSize($event.target.value)"><small id="label-font-hint">8–72 px. Leave blank for automatic size. Enlarge the block if larger text needs more space.</small></label><p class="hint">Label and text sizes save automatically. Floor and unit counts stay the same.</p></section><h3>Building blocks</h3><p v-if="!model.blocks.length">Choose Building block, then click the map to add your first block.</p><div v-for="block in model.blocks" :key="block.building" class="block-setting"><strong>{{ block.label }}</strong><small>{{ block.floors }} floors · {{ block.rooms }} units per floor</small><button @click="editBlock(block)">{{ unplaced.some(b=>b.building===block.building) ? 'Place' : 'Edit' }} {{ block.label }}</button></div><p v-if="layoutLocked" class="hint">Existing accounts are preserved. Floor and unit counts and account prefixes are locked; label descriptions, positions, and other drawings can be edited.</p><p v-if="layoutLocked && chosen?.type === 'block'" class="hint">Move this building label instead of deleting it, so responders can still open the block.</p></aside></div>
    <div v-if="modal" class="map-modal-backdrop"><form class="card map-modal" role="dialog" aria-modal="true" :aria-label="modal.type === 'block' ? 'Configure building block' : 'Add map note'" @submit.prevent="confirmModal">
      <template v-if="modal.type === 'block'"><h3>Configure building block</h3><label class="field"><span>Block label</span><input v-model="modal.label" autofocus maxlength="60" required></label><label v-if="!codeFromLabel(modal.label) && !layoutLocked" class="field"><span>Account prefix</span><input v-model="modal.accountPrefix" maxlength="1" pattern="[A-Z]" required></label><p class="hint">Unit accounts: {{ blockUnitName({ accountPrefix: layoutLocked ? model.blocks[modal.building]?.accountPrefix : modalPrefix }, 1, 1) }}. The account prefix is fixed after initialization.</p><div class="fields"><label class="field"><span>Floors in this block</span><input v-model.number="modal.floors" type="number" min="1" max="40" required :disabled="layoutLocked"></label><label class="field"><span>Units per floor</span><input v-model.number="modal.rooms" type="number" min="1" max="20" required :disabled="layoutLocked"></label></div></template>
      <template v-else><h3>Add map note</h3><label class="field"><span>Text or emoji</span><input v-model="modal.text" maxlength="120" required></label><div class="emoji-tools"><button v-for="emoji in ['🚑','🚒','🚧','⚠️','🆘','🍔','🍟','💧']" :key="emoji" type="button" :aria-label="`Insert ${emoji}`" @click="modal.text += emoji">{{ emoji }}</button></div><label class="field"><span>Text size</span><input v-model.number="modal.fontSize" type="number" min="12" max="48" required></label></template>
      <div class="actions"><button class="primary">{{ modal.type === 'block' ? 'Place block' : 'Add note' }}</button><button type="button" @click="modal=null">Cancel</button></div>
    </form></div>
  </section>
</template>
