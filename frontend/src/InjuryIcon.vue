<script setup>
defineProps({ type: { type: String, required: true } });
</script>

<template>
  <svg class="injury-icon" viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#294d60" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="type === 'bleeding'">
        <circle cx="46" cy="48" r="36" fill="#fff0ee" stroke="none"/>
        <g transform="rotate(-35 45 48)">
          <rect x="9" y="34" width="71" height="29" rx="12" fill="#f5c9a5"/>
          <rect x="32" y="34" width="25" height="29" rx="5" fill="#fffaf1"/>
          <path d="M40 41h9M40 48h9M40 55h9M21 43v.5M21 53v.5M68 43v.5M68 53v.5"/>
        </g>
        <path d="M75 49s-9 11-9 17a9 9 0 0 0 18 0c0-6-9-17-9-17Z" fill="#df6264"/>
        <path d="M71 67c0 2 1 3 3 3" stroke="white"/>
      </template>
      <template v-else-if="type === 'fracture'">
        <circle cx="48" cy="48" r="37" fill="#edf0ff" stroke="none"/>
        <g transform="rotate(-35 48 48)">
          <path d="M30 36c-3-9-16-9-18 1-8 4-5 16 4 17 0 10 12 12 16 4h32c4 8 16 6 16-4 9-1 12-13 4-17-2-10-15-10-18-1Z" fill="#fffaf1"/>
          <path d="m49 36-7 8 10 4-8 6 5 4" stroke="#c9575f" stroke-width="4"/>
        </g>
      </template>
      <template v-else-if="type === 'burns'">
        <circle cx="48" cy="49" r="37" fill="#fff2de" stroke="none"/>
        <path d="M31 77 20 55c-3-6 3-10 7-5l7 8V34c0-6 8-6 8 0v15-20c0-6 8-6 8 0v20-18c0-5 8-5 8 0v19-12c0-5 8-5 8 0v24c0 7-3 12-7 16Z" fill="#f4c9a6"/>
        <path d="M45 56c-9-3-14 8-8 13 6 6 19 5 20-3 1-4-3-8-7-6Z" fill="#e98b80" stroke="#cb6261" stroke-width="2.3"/>
        <path d="M27 28c-8-7 5-8-2-15M47 17c-6-6 4-7-1-13M68 25c-6-7 6-9-1-16" stroke="#da8a32"/>
      </template>
      <template v-else-if="type === 'smoke_inhalation'">
        <circle cx="48" cy="49" r="37" fill="#edf5f5" stroke="none"/>
        <path d="M43 41c-5-7-11-2-15 4-7 8-12 24-7 30 5 5 20-1 22-7Z" fill="#f1b4ba"/>
        <path d="M53 41c5-7 11-2 15 4 7 8 12 24 7 30-5 5-20-1-22-7Z" fill="#f1b4ba"/>
        <path d="M48 30v20m0 0L35 61m13-11 13 11" stroke="#487486" stroke-width="5"/>
        <path d="M30 25c-11 0-11-13-2-14 0-9 14-12 18-3 10-6 21 1 18 9 12-1 14 14 2 15H40" fill="#d0dce1"/>
        <path d="M37 21c-5-7 7-8 5-13M54 17c4-2 7 0 7 3" stroke="#8ba0ab" stroke-width="2.5"/>
      </template>
    </g>
  </svg>
</template>
