<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, Mail, MessageCircle, RefreshCw, Search, Send, TriangleAlert } from 'lucide-vue-next';

const props = defineProps({
  api: { type: Function, required: true },
  incidentId: { type: String, required: true },
  superadmin: Boolean,
  formatTime: { type: Function, required: true },
});
const emit = defineEmits(['reconnect', 'expired']);
const chats = ref([]), filter = ref(''), selected = ref(null), thread = ref(null);
const connection = ref(null), listError = ref(''), chatError = ref(''), sendError = ref('');
const draft = ref(''), sending = ref(false), loading = ref(false), refreshing = ref(false);
const historyPane = ref(null);
const pageSize = 50;
let timer, disposed = false, sequence = 0, limit = pageSize, replyAttempt;

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase();
  return chats.value.filter(chat => [chat.phone, ...chat.units].some(value => value.toLowerCase().includes(query)));
});
const activeChat = computed(() => chats.value.find(chat => chat.phone === selected.value));
const chatPath = phone => '/whatsapp/chats/' + encodeURIComponent(phone);
const query = () => 'incidentId=' + encodeURIComponent(props.incidentId);

function handleError(error, target) {
  if (disposed) return;
  if (error.status === 401) emit('expired', error.message);
  else target.value = error.message;
}

async function loadConversation(phone, scroll = 'follow') {
  const current = ++sequence;
  loading.value = true;
  const pane = historyPane.value;
  const follow = !pane || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 70;
  const previousHeight = pane?.scrollHeight;
  try {
    const data = await props.api(chatPath(phone) + '?' + query() + '&limit=' + limit);
    if (disposed || current !== sequence || selected.value !== phone) return;
    thread.value = data;
    chatError.value = '';
    await nextTick();
    if (current !== sequence || !historyPane.value) return;
    if (scroll === 'bottom' || (scroll === 'follow' && follow)) {
      historyPane.value.scrollTop = historyPane.value.scrollHeight;
    } else if (scroll === 'earlier' && previousHeight !== undefined) {
      historyPane.value.scrollTop += historyPane.value.scrollHeight - previousHeight;
    }
  } catch (error) {
    if (current === sequence) handleError(error, chatError);
  } finally {
    if (current === sequence) loading.value = false;
  }
}

async function refresh() {
  if (disposed || refreshing.value || sending.value || loading.value) return;
  refreshing.value = true;
  try {
    const result = await props.api('/whatsapp/chats?' + query());
    if (disposed) return;
    connection.value = result;
    listError.value = '';
    if (result.recovering) return;
    if (!result.connected) {
      chats.value = [];
      thread.value = null;
      if (result.enabled && props.superadmin) emit('reconnect', result.state);
      return;
    }
    chats.value = result.chats;
    if (selected.value && activeChat.value) await loadConversation(selected.value);
  } catch (error) {
    handleError(error, listError);
  } finally {
    refreshing.value = false;
  }
}

function selectChat(phone) {
  if (sending.value) return;
  selected.value = phone;
  thread.value = null;
  draft.value = '';
  replyAttempt = null;
  chatError.value = '';
  sendError.value = '';
  limit = pageSize;
  if (phone) void loadConversation(phone, 'bottom');
  else { sequence++; loading.value = false; }
}

async function loadEarlier() {
  limit = Math.min(1000, limit + pageSize);
  await loadConversation(selected.value, 'earlier');
}

async function sendReply() {
  const message = draft.value.trim(), phone = selected.value;
  if (!connection.value?.connected || !message || !phone || sending.value || !thread.value?.canReply || chatError.value || listError.value) return;
  if (replyAttempt?.message !== message) replyAttempt = { message, requestId: crypto.randomUUID() };
  sending.value = true;
  sendError.value = '';
  try {
    await props.api(chatPath(phone) + '/reply', {
      method: 'POST',
      body: { incidentId: props.incidentId, ...replyAttempt },
    });
    if (disposed) return;
    draft.value = '';
    replyAttempt = null;
    await loadConversation(phone, 'bottom');
  } catch (error) {
    handleError(error, sendError);
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
});
onUnmounted(() => { disposed = true; sequence++; clearInterval(timer); });
</script>

<template>
  <section class="whatsapp-inbox" :class="{ 'chat-open': activeChat }">
    <div class="page-head">
      <div>
        <span class="eyebrow">Responder workspace</span>
        <h2>WhatsApp Inbox</h2>
        <p>Read and reply to families who received a safety notification for this disaster.</p>
      </div>
      <button type="button" :disabled="refreshing || sending || loading" @click="refresh">
        <RefreshCw :size="16" aria-hidden="true"/> Refresh chats
      </button>
    </div>

    <div v-if="listError" class="chat-notice" role="alert"><TriangleAlert :size="20"/> {{ listError }}</div>
    <p v-if="!connection && !listError" role="status">Loading WhatsApp inbox…</p>
    <p v-else-if="connection?.recovering" class="chat-notice" role="status">
      Restoring the WhatsApp connection. The inbox will reload automatically.
    </p>
    <div v-else-if="connection && !connection.connected" class="card chat-notice" role="status">
      <TriangleAlert :size="24" aria-hidden="true"/>
      <div>
        <h3>{{ connection.enabled ? 'WhatsApp sender disconnected' : 'WhatsApp is disabled' }}</h3>
        <p v-if="connection.enabled">{{ superadmin ? 'Opening the WhatsApp connection page…' : 'Ask a Super Admin to reconnect the sender before you can read or send messages.' }}</p>
        <p v-else>Enable WhatsApp in the backend configuration to use the inbox.</p>
      </div>
    </div>

    <div v-if="connection?.connected || (connection?.recovering && chats.length)" class="inbox-workspace">
      <aside class="chat-sidebar" aria-label="Conversations">
        <div class="chat-sidebar-head">
          <h3>Chats <span>{{ chats.length }}</span></h3>
          <label class="chat-filter">
            <Search :size="16" aria-hidden="true"/>
            <input v-model="filter" type="search" placeholder="Find a phone or unit" aria-label="Find a phone or unit">
          </label>
        </div>
        <div class="chat-list">
          <button v-for="chat in filtered" :key="chat.phone" type="button" class="chat-row"
            :class="{ 'selected-chat': selected === chat.phone }" :aria-pressed="selected === chat.phone"
            :disabled="sending || connection.recovering" @click="selectChat(chat.phone)">
            <span class="chat-avatar"><MessageCircle :size="18" aria-hidden="true"/></span>
            <span class="chat-contact">
              <strong>{{ chat.phone }}</strong>
              <small>{{ chat.units.length === 1 ? 'Unit' : 'Units' }} {{ chat.units.join(', ') }}</small>
              <small>{{ formatTime(chat.sentAt) }}</small>
            </span>
          </button>
          <p v-if="!filtered.length" class="chat-list-empty">{{ chats.length ? 'No matching phone numbers or units.' : 'Chats appear after an automatic safety message is sent.' }}</p>
        </div>
      </aside>

      <div v-if="!activeChat" class="chat-empty">
        <Mail :size="36" aria-hidden="true"/>
        <h3>Select a conversation</h3>
        <p>Open a family’s chat to see their safety notification and messages.</p>
      </div>
      <div v-else class="chat-panel">
        <header class="chat-header">
          <button class="chat-back" type="button" :disabled="sending" @click="selectChat(null)" aria-label="Back to chats"><ArrowLeft :size="19"/></button>
          <span class="chat-avatar"><MessageCircle :size="19" aria-hidden="true"/></span>
          <div><h3>{{ activeChat.phone }}</h3><p>{{ activeChat.units.length === 1 ? 'Unit' : 'Units' }} {{ activeChat.units.join(', ') }}</p></div>
        </header>
        <div ref="historyPane" class="chat-history" aria-label="Conversation messages" tabindex="0">
          <p v-if="loading && !thread" role="status">Loading messages…</p>
          <p v-if="chatError" class="chat-notice" role="alert">{{ chatError }}</p>
          <p v-if="thread?.warning" class="chat-notice" role="status">{{ thread.warning }}</p>
          <button v-if="thread?.hasEarlier" type="button" class="chat-earlier" :disabled="loading || sending || connection.recovering" @click="loadEarlier">Load earlier messages</button>
          <article v-for="message in thread?.messages" :key="message.id" class="chat-message" :class="{ outgoing: message.outgoing }">
            <small v-if="message.kind === 'automatic'" class="chat-message-label">Automatic safety message · Unit {{ message.unit }}</small>
            <div>{{ message.body }}</div>
            <div class="chat-message-meta">
              <time :datetime="message.sentAt">{{ formatTime(message.sentAt) }}</time>
              <small v-if="superadmin && message.repliedBy">Replied by {{ message.repliedBy }}</small>
            </div>
          </article>
        </div>
        <form v-if="thread?.canReply" class="chat-composer" @submit.prevent="sendReply">
          <p v-if="sendError" class="chat-notice" role="alert">{{ sendError }}</p>
          <div class="chat-compose-row">
            <textarea v-model="draft" rows="2" maxlength="4000" required placeholder="Write a reply…" aria-label="Reply message" :disabled="sending"/>
            <button class="primary" :disabled="sending || !connection.connected || !draft.trim() || !!chatError || !!listError">
              <Send :size="17" aria-hidden="true"/>{{ sending ? 'Sending…' : 'Send reply' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.inbox-workspace {
  display: grid;
  grid-template-columns: minmax(210px, 28%) minmax(0, 1fr);
  height: clamp(440px, 66vh, 760px);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: white;
}
.chat-sidebar, .chat-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.chat-sidebar { border-right: 1px solid var(--line); }
.chat-sidebar-head { padding: 16px; border-bottom: 1px solid var(--line); }
.chat-sidebar-head h3 span { margin-left: 4px; color: var(--sub); font-size: 12px; }
.chat-filter { display: flex; gap: 8px; align-items: center; color: var(--sub); margin-top: 10px; }
.chat-filter svg, .chat-avatar, .chat-notice svg { flex-shrink: 0; }
.chat-filter input { min-width: 0; font-size: 13px; }
.chat-list { overflow: auto; }
.chat-row {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
  padding: 13px 14px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
}
.chat-row.selected-chat { background: #e7f4f7; box-shadow: inset 3px 0 0 var(--teal); }
.chat-avatar {
  display: grid;
  place-items: center;
  width: 35px;
  height: 35px;
  border-radius: 50%;
  color: var(--teal);
  background: #e7f4f7;
}
.chat-contact { display: grid; gap: 4px; overflow-wrap: anywhere; min-width: 0; }
.chat-contact small, .chat-list-empty, .chat-message-meta, .chat-message-label { color: var(--sub); font-size: 12px; }
.chat-list-empty { padding: 16px; }
.chat-empty { display: grid; place-content: center; justify-items: center; text-align: center; padding: 24px; }
.chat-empty svg { margin-bottom: 10px; color: var(--teal); }
.chat-header { display: flex; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.chat-header h3 { font-size: 16px; }
.chat-header p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.chat-back { display: none; }
.chat-history { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; background: #f1f6f4; }
.chat-message {
  align-self: flex-start;
  max-width: min(88%, 620px);
  padding: 9px 12px;
  background: white;
  border: 1px solid var(--line);
  border-radius: 4px 12px 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.45;
}
.chat-message.outgoing { align-self: flex-end; background: #e1f3e7; border-color: #c9e6d4; border-radius: 12px 4px 12px 12px; }
.chat-message-label { display: block; margin-bottom: 5px; font-weight: 650; color: var(--green); }
.chat-message-meta { display: grid; justify-items: end; gap: 3px; margin-top: 6px; }
.chat-message-meta small { font-size: inherit; font-weight: 650; }
.chat-earlier { align-self: center; }
.chat-composer { padding: 12px; border-top: 1px solid var(--line); }
.chat-compose-row { display: flex; align-items: end; gap: 8px; }
.chat-compose-row textarea { min-width: 0; min-height: 48px; resize: vertical; }
.chat-compose-row button { flex-shrink: 0; }
.chat-notice { display: flex; align-items: flex-start; gap: 10px; background: #fff4e8; color: #794616; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.chat-notice p { margin-bottom: 0; }
@media (max-width: 760px) {
  .inbox-workspace { grid-template-columns: minmax(0, 1fr); height: clamp(375px, 60dvh, 650px); }
  .chat-sidebar { border-right: 0; }
  .chat-empty, .chat-open .chat-sidebar { display: none; }
  .chat-back { display: inline-flex; padding: 5px; }
  .chat-compose-row button { padding-inline: 9px; }
  .chat-message { max-width: 95%; }
}
</style>
