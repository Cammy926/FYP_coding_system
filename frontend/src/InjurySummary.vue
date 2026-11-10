<script setup>
import InjuryIcon from './InjuryIcon.vue';
import { INJURY_TYPES } from '../../shared/injuries.js';
defineProps({ counts: { type: Object, required: true } });
</script>

<template>
  <div class="metric injury-metric" aria-label="Help requests by injury">
    <span>Reported injuries</span>
    <div class="injury-counts"><div v-for="type in INJURY_TYPES" :key="type.id" class="injury-count" :data-injury="type.id"><InjuryIcon :type="type.id"/><span>{{ type.label }}</span><strong>{{ counts[type.id] || 0 }}</strong></div></div>
    <small>Units needing help · multiple choices allowed</small>
  </div>
</template>
