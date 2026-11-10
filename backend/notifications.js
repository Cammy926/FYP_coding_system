import { ApiError, phone } from './lib.js';

export function familyPhone(value, countryCode = '852') {
  const result = phone(value, 'Family phone number', true);
  if (!result) return '';
  const digits = result.replace(/^\+/, '');
  const international = !result.startsWith('+') && digits.length === 8 ? countryCode + digits : digits;
  if (!/^[1-9]\d{7,14}$/.test(international)) throw new ApiError(400, 'Enter a WhatsApp number with its country code, for example +85291234567.');
  return '+' + international;
}

export function safetyMessage(report, disasterName) {
  const time = new Date(report.createdAt).toLocaleString('en-HK', { timeZone: 'Asia/Hong_Kong', dateStyle: 'medium', timeStyle: 'short' });
  return `Auto Safety Report System\nThe resident using Unit ${report.username}'s account has reported SAFE.\n單位 ${report.username} 的住戶已報平安。\nDisaster / 事故：${disasterName}\nReported / 報告時間：${time} (Hong Kong)\nAutomated notification based on the resident's report.\n此為根據住戶報告發出的自動通知。\n\nFor non-urgent enquiries, please use this WhatsApp chat and await a response from our team.\n如有非緊急查詢，請透過此 WhatsApp 對話提出，並耐心等候工作人員回覆。`;
}

const channel = 'whatsapp-web.js';
const within = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
};

// One notification per finalized Safe report. WhatsApp I/O stays outside the
// incident write queue so a slow send never delays emergency status buttons.
export function createNotifications(db, { transport, exclusive, publish = () => {}, intervalMs = 3000, timeoutMs = 45000, now = () => new Date(), log = console } = {}) {
  const enabled = !!transport?.enabled;
  let timer, running, stopped = false, pauses = 0, unsubscribe;
  const reports = db.collection('safety_reports');
  const status = () => transport?.status() || { enabled: false, state: 'disabled' };
  const fieldsFor = (report, details, disasterName) => {
    if (!enabled) return { notificationStatus: 'disabled' };
    if (report.status !== 'safe') return { notificationStatus: 'not_applicable' };
    if (!details.familyPhone) return { notificationStatus: 'skipped' };
    return { notificationChannel: channel, notificationStatus: 'pending', notificationRecipient: details.familyPhone,
      notificationMessage: safetyMessage(report, disasterName), notificationRequestedAt: now(), notificationAttempts: 0, notificationError: '' };
  };
  async function finish(id, fields) {
    await exclusive(async () => {
      const saved = await reports.updateOne({ _id: id, notificationChannel: channel, notificationStatus: 'sending' }, { $set: fields, $inc: { revision: 1 } });
      if (saved.matchedCount) publish();
    });
  }
  async function work() {
    if (!enabled || stopped || pauses || status().state !== 'ready') return;
    const report = await exclusive(async () => {
      if (stopped || pauses || status().state !== 'ready') return null;
      const incident = await db.collection('incidents').findOne({ _id: 'current', status: 'active' });
      if (!incident || incident.setupComplete === false) return null;
      const map = await db.collection('disaster_maps').findOne({ _id: 'current', incidentId: incident.incidentId, phase: 'active' }, { projection: { _id: 1 } });
      if (!map) return null;
      const pending = await reports.find({ incidentId: incident.incidentId, status: 'safe', notificationChannel: channel, notificationStatus: 'pending', notificationNextAttemptAt: { $exists: false } }).sort({ notificationRequestedAt: 1 }).limit(1).toArray();
      // Deferred lookup retries are considered only after their backoff expires.
      const delayed = pending.length ? [] : await reports.find({ incidentId: incident.incidentId, status: 'safe', notificationChannel: channel, notificationStatus: 'pending', notificationNextAttemptAt: { $lte: now() } }).sort({ notificationRequestedAt: 1 }).limit(1).toArray();
      const candidate = pending[0] || delayed[0];
      if (!candidate || !candidate.detailsSubmittedAt || !candidate.familyPhone) return null;
      const claimed = await reports.updateOne({ _id: candidate._id, notificationStatus: 'pending' }, { $set: { notificationStatus: 'sending', notificationStartedAt: now(), notificationError: '' }, $inc: { notificationAttempts: 1, revision: 1 } });
      if (!claimed.matchedCount) return null;
      publish();return { ...candidate, notificationAttempts: (candidate.notificationAttempts || 0) + 1 };
    });
    if (!report) return;
    let recipient;
    try { recipient = await within(transport.lookup(report.notificationRecipient.replace(/^\+/, '')), timeoutMs); }
    catch {
      const retry = report.notificationAttempts < 3;
      await finish(report._id, { notificationStatus: retry ? 'pending' : 'failed', notificationError: 'connection_problem', notificationNextAttemptAt: new Date(now().getTime() + 30000 * report.notificationAttempts) });
      return;
    }
    if (!recipient) { await finish(report._id, { notificationStatus: 'failed', notificationError: 'number_not_registered' });return; }
    // Last check before sending; Clear Setup drains the worker before deletion.
    if (stopped || status().state !== 'ready') {
      await finish(report._id, { notificationStatus: 'pending', notificationError: 'waiting_for_connection' });return;
    }
    try {
      const senderKey = transport.senderKey?.();
      const result = await within(transport.send(recipient, report.notificationMessage), timeoutMs);
      await finish(report._id, {
        notificationStatus: 'sent', notificationSentAt: now(), notificationMessageId: result?.id?._serialized || '', notificationError: '',
        ...(senderKey ? { notificationSenderKey: senderKey } : {}),
        ...(Number.isFinite(result?.timestamp) ? { notificationWhatsAppAt: new Date(result.timestamp * 1000) } : {}),
      });
    } catch {
      // A send can reach WhatsApp even if its response is lost. Never blindly
      // retry this case: keep it visible for review rather than sending twice.
      await finish(report._id, { notificationStatus: 'unknown', notificationError: 'send_result_unknown' });
    }
  }
  function kick() {
    if (running || stopped || !enabled) return running || Promise.resolve();
    running = work().catch(() => log.error('WhatsApp notification processing failed; saved safety reports remain available.')).finally(() => { running = null; });
    return running;
  }
  async function start() {
    if (!enabled) return;
    // Recover only this feature's interrupted sends; historical disabled
    // reports are never backfilled into a live messaging queue.
    await exclusive(async () => {
      const recovered = await reports.updateMany({ notificationChannel: channel, notificationStatus: 'sending' }, { $set: { notificationStatus: 'unknown', notificationError: 'interrupted_send' }, $inc: { revision: 1 } });
      if (recovered.modifiedCount) publish();
    });
    unsubscribe = transport.onChange(() => { if (status().state === 'ready') void kick(); });
    timer = setInterval(() => void kick(), intervalMs);timer.unref?.();
    void kick();
  }
  async function pauseAndDrain() {
    pauses++;await running;let resumed = false;
    return () => { if (!resumed) { resumed = true;pauses--; } };
  }
  async function stop() { stopped = true;clearInterval(timer);unsubscribe?.();await running; }
  return { enabled, status, fieldsFor, start, kick, stop, pauseAndDrain };
}
