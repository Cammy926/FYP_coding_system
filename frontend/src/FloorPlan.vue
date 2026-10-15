<script setup>
const props = defineProps({ map: { type: Object, required: true }, editable: Boolean, tool: String, selected: String, preview: Object });
const emit = defineEmits(['start', 'move', 'end', 'cancel', 'open', 'resize-key']);
function pointer(event, phase) {
  if (!props.editable || (phase === 'start' && event.button !== 0)) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (phase === 'start') event.currentTarget.setPointerCapture(event.pointerId);
  emit(phase, { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)), id: event.target.closest('[data-annotation-id]')?.dataset.annotationId, resize: !!event.target.closest('[data-resize]'), size: size(event.target.closest('.map-block-frame'), bounds) });
}
function size(frame, bounds) { if (!frame) return null; const box = frame.getBoundingClientRect(); return { w: box.width / bounds.width, h: box.height / bounds.height }; }
function resizeKey(event, annotation) {
  const direction = { ArrowRight: ['w', 1], ArrowLeft: ['w', -1], ArrowDown: ['h', 1], ArrowUp: ['h', -1] }[event.key];
  if (!direction) return;
  event.preventDefault();
  const frame = event.currentTarget.closest('.map-block-frame');
  emit('resize-key', { id: annotation.id, axis: direction[0], delta: direction[1] * (event.shiftKey ? 5 : 1), size: size(frame, frame.closest('.floor-plan').getBoundingClientRect()) });
}
const position = annotation => ({ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` });
</script>
<template>
  <div class="floor-plan" :class="{ editable, drawing: editable && tool !== 'select' }" :style="{ aspectRatio: `${map.image.width}/${map.image.height}` }" @pointerdown="pointer($event, 'start')" @pointermove="pointer($event, 'move')" @pointerup="pointer($event, 'end')" @pointercancel="emit('cancel')">
    <img :key="map.imageId" :src="`/api/map/image?v=${map.imageId}`" alt="Uploaded disaster area map" draggable="false">
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      <template v-for="a in [...map.annotations, ...(preview ? [preview] : [])]" :key="a.id">
        <polyline v-if="a.type === 'pen'" :data-annotation-id="a.id" :points="a.points.map(p => `${p.x * 1000},${p.y * 1000}`).join(' ')" fill="none" :stroke="a.color" :stroke-width="a.width" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" :class="{ 'drawing-selected': selected === a.id }"/>
        <rect v-if="a.type === 'rectangle'" :data-annotation-id="a.id" :x="a.x * 1000" :y="a.y * 1000" :width="a.w * 1000" :height="a.h * 1000" fill="none" :stroke="a.color" :stroke-width="a.width" vector-effect="non-scaling-stroke" :class="{ 'drawing-selected': selected === a.id }"/>
      </template>
    </svg>
    <template v-for="a in map.annotations" :key="a.id">
      <div v-if="a.type === 'block'" class="map-block-frame" :class="{ 'sized-block': a.w !== undefined, 'selected-frame': selected === a.id }" :style="{ ...position(a), ...(a.w !== undefined ? { width: `${a.w * 100}%`, height: `${a.h * 100}%` } : {}) }" :data-annotation-id="a.id">
        <button type="button" class="map-block" :class="{ 'annotation-selected': selected === a.id }" :data-annotation-id="a.id" :aria-label="editable ? `Select ${map.blocks[a.building]?.label}` : `Open ${map.blocks[a.building]?.label}`" :title="map.blocks[a.building]?.label" @click="!editable && emit('open', a.building)">{{ map.blocks[a.building]?.label }}<span v-if="!editable" aria-hidden="true">↗</span></button>
        <button v-if="editable && tool === 'select' && selected === a.id" type="button" class="block-resize-handle" data-resize="se" :aria-label="`Resize ${map.blocks[a.building]?.label}`" title="Drag to resize. Arrow keys also adjust size." @keydown="resizeKey($event, a)"></button>
      </div>
      <div v-if="a.type === 'text'" class="map-note" :class="{ 'annotation-selected': selected === a.id }" :style="{ ...position(a), color: a.color, fontSize: `${a.fontSize}px` }" :data-annotation-id="a.id">{{ a.text }}</div>
    </template>
  </div>
</template>
