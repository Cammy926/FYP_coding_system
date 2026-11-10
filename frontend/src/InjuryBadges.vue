<script setup>
import { computed } from 'vue';
import InjuryIcon from './InjuryIcon.vue';
import { INJURY_TYPES } from '../../shared/injuries.js';
const props = defineProps({ injuries: { type: Array, default: () => [] }, showLabels: Boolean });
const types = computed(() => INJURY_TYPES.filter(type => props.injuries.includes(type.id)));
</script>

<template>
  <span v-if="types.length" class="injury-badges" :class="{ 'with-labels': showLabels }">
    <span class="sr-only">Reported injuries: {{ types.map(type => type.label).join(', ') }}.</span>
    <span v-for="type in types" :key="type.id" class="injury-badge" :title="type.label" :data-injury="type.id" aria-hidden="true"><InjuryIcon :type="type.id"/><span v-if="showLabels">{{ type.label }}</span></span>
  </span>
</template>
