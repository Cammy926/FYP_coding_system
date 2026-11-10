<script setup>
import { QrCode, RefreshCw } from 'lucide-vue-next';
defineProps({ connection: { type: Object, required: true }, incident: { type: Object, required: true }, busy: Boolean });
defineEmits(['refresh', 'connect']);
</script>

<template>
  <section class="whatsapp-setup narrow">
    <div class="page-head"><div><span class="eyebrow">{{ incident.setupComplete === false ? 'Super Admin · Final setup step' : 'Super Admin · WhatsApp connection' }}</span><h2>Connect the WhatsApp sender</h2><p>The map is saved. Link the account that will send family safety notifications.</p></div></div>
    <div class="card whatsapp-link-card">
      <QrCode :size="38" class="page-icon"/>
      <h3>{{ incident.setupComplete === false ? 'Scan to finish initialization' : 'Scan to reconnect WhatsApp' }}</h3>
      <p>On the sender’s phone, open <strong>WhatsApp → Linked devices → Link a device</strong>, then scan this QR code.</p>
      <img v-if="connection.qrAvailable" class="whatsapp-qr" :src="`/api/whatsapp/qr?incidentId=${encodeURIComponent(incident.incidentId)}&v=${connection.qrVersion}`" alt="WhatsApp sender connection QR code">
      <div v-else class="whatsapp-qr-placeholder" role="status">{{ connection.state === 'authenticated' ? 'Account linked. Finishing connection…' : connection.problem === 'connection_timeout' ? 'Connection is taking too long. Retry below; your map and saved login are preserved.' : ['error','disconnected','auth_failure'].includes(connection.state) ? 'Connection unavailable. Please retry below. Your map and saved login are preserved.' : 'Preparing your QR code…' }}</div>
      <p class="hint">{{ incident.setupComplete === false ? 'The QR refreshes automatically. Keep this page open until initialization completes. Admin and resident logins are enabled after the sender connects.' : 'The QR refreshes automatically. Reconnecting preserves the disaster map, accounts, reports, and search progress. Safety reporting remains available.' }}</p>
      <p v-if="connection.state === 'authenticated'" class="hint">If this does not finish, retry the connection. You usually do not need to scan again.</p>
      <div class="actions"><button :disabled="busy" @click="$emit('refresh')"><RefreshCw :size="16"/>Refresh connection</button><button v-if="['authenticated','error','disconnected','auth_failure','idle'].includes(connection.state)" class="primary" :disabled="busy" @click="$emit('connect')">Retry connection</button></div>
    </div>
    <p class="hint">Only Super Admin can view this QR.</p>
  </section>
</template>
