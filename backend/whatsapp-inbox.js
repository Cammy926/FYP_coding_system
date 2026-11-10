import { ApiError, text } from './lib.js';

const pageSize = 50;
const maxHistory = 1000;
const phonePattern = /^\+[1-9]\d{7,14}$/;
const disconnected = () => new ApiError(409, 'WhatsApp is disconnected. Ask a Super Admin to reconnect the sender.');
const noAnchor = 'This conversation could not be verified on the connected WhatsApp account. Link the original sender to reply.';
const sentFilter = incidentId => ({ incidentId, notificationChannel: 'whatsapp-web.js', notificationStatus: 'sent' });
const byTime = (a, b) => new Date(a.sentAt) - new Date(b.sentAt);

async function whatsappCall(work) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp request timed out')), 15000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createWhatsAppInbox(db, { transport, senderId, exclusive, authorize }) {
  const reports = db.collection('safety_reports');
  const replies = db.collection('whatsapp_replies');
  const inFlight = new Set();
  let pauses = 0;
  const connected = incident => !!transport?.enabled && incident.setupComplete !== false &&
    transport.binding() === senderId(incident) && transport.status().state === 'ready';
  const unavailable = () => transport?.status().recovering
    ? new ApiError(503, 'Restoring the WhatsApp connection. This conversation will reload automatically.')
    : disconnected();

  async function list(incident) {
    const status = () => transport?.status() ?? { enabled: false, state: 'disabled' };
    if (!connected(incident)) return { ...status(), connected: false, chats: [] };
    const sent = await reports.find(sentFilter(incident.incidentId), {
      projection: { notificationRecipient: 1, notificationSentAt: 1, username: 1 },
    }).toArray();
    const chats = new Map();
    for (const report of sent) {
      const phone = report.notificationRecipient;
      if (!phonePattern.test(phone)) continue;
      if (!chats.has(phone)) chats.set(phone, { phone, units: [], sentAt: report.notificationSentAt });
      const chat = chats.get(phone);
      if (!chat.units.includes(report.username)) chat.units.push(report.username);
      if (new Date(report.notificationSentAt) > new Date(chat.sentAt)) chat.sentAt = report.notificationSentAt;
    }
    const ready = connected(incident);
    return { ...status(), connected: ready, chats: ready ? [...chats.values()].sort((a, b) => byTime(b, a)) : [] };
  }

  async function open(incident, phone, limit, needsHistory) {
    if (!connected(incident) || pauses) throw unavailable();
    if (!phonePattern.test(phone)) throw new ApiError(404, 'Conversation not found.');
    const sent = await reports.find({
      ...sentFilter(incident.incidentId), notificationRecipient: phone,
    }, { projection: {
      username: 1, notificationMessage: 1, notificationSentAt: 1, notificationMessageId: 1,
      notificationSenderKey: 1, notificationWhatsAppAt: 1,
    } }).toArray();
    if (!sent.length) throw new ApiError(404, 'Conversation not found.');
    sent.sort((a, b) => new Date(a.notificationSentAt) - new Date(b.notificationSentAt));

    let chat, history, verified;
    try {
      chat = await whatsappCall(() => transport.openChat(phone, senderId(incident)));
      const legacy = sent.filter(report => !report.notificationSenderKey && report.notificationMessageId);
      const current = sent.filter(report => report.notificationSenderKey === chat.senderKey);
      history = needsHistory || legacy.length ? await whatsappCall(() => chat.history(limit)) : [];
      const outgoing = new Map(history.filter(message => message.outgoing).map(message => [message.id, message]));
      verified = [...current, ...legacy.filter(report => outgoing.has(report.notificationMessageId))];
      for (const report of verified) {
        let original = outgoing.get(report.notificationMessageId);
        if (!report.notificationMessageId && report.notificationMessage && report.notificationSentAt) {
          // A sent notification can lack an ID in older records. Recover the
          // anchor from this verified sender's chat using the exact text and time.
          const sentAt = new Date(report.notificationSentAt).getTime();
          const matches = history.filter(message => message.outgoing &&
            message.body === report.notificationMessage &&
            Math.abs(new Date(message.sentAt).getTime() - sentAt) <= 10000);
          if (matches.length === 1) original = matches[0];
        }
        if (original) {
          report.notificationMessageId = original.id;
          report.notificationWhatsAppAt = original.sentAt;
        }
      }
      if (legacy.length && !outgoing.has(legacy[0].notificationMessageId) &&
          (!verified.length || legacy[0].notificationSentAt < verified[0].notificationSentAt)) {
        const anchor = await whatsappCall(() => chat.findOutgoing(legacy[0].notificationMessageId)).catch(() => null);
        if (anchor) {
          legacy[0].notificationWhatsAppAt = anchor.sentAt;
          verified.push(legacy[0]);
        }
      }
      chat.assertCurrent();
    } catch {
      if (!connected(incident)) throw unavailable();
      throw new ApiError(502, 'WhatsApp could not load this conversation. Try again shortly.');
    }
    return { chat, verified, history };
  }

  async function recoverReplyAttribution(audit, messages) {
    const attempts = audit.filter(reply => ['unknown', 'sending'].includes(reply.state) && reply.repliedBy);
    const unknown = attempts.filter(reply => reply.state === 'unknown');
    if (!unknown.length) return;
    const claimed = new Set(audit.filter(reply => reply.state === 'sent').map(reply => reply.messageId));
    const outgoing = [...messages.values()].filter(message => message.outgoing && !message.kind && !claimed.has(message.id));
    const matches = new Map();
    const uses = new Map();
    for (const reply of attempts) {
      const startedAt = new Date(reply.createdAt).getTime();
      const firstSecond = Math.floor(startedAt / 1000) * 1000;
      const candidates = outgoing.filter(message => {
        const sentAt = new Date(message.sentAt).getTime();
        return message.body === reply.body && sentAt >= firstSecond && sentAt <= startedAt + 20000;
      });
      matches.set(reply._id, candidates);
      for (const message of candidates) uses.set(message.id, (uses.get(message.id) || 0) + 1);
    }
    // Recover only one-to-one matches. Identical replies close together can
    // be ambiguous, and an account label is only useful if it is accurate.
    for (const reply of unknown) {
      const candidates = matches.get(reply._id);
      if (candidates.length !== 1 || uses.get(candidates[0].id) !== 1) continue;
      const [message] = candidates;
      const fields = { state: 'sent', messageId: message.id, sentAt: message.sentAt };
      const saved = await replies.updateOne({ _id: reply._id, state: 'unknown' }, { $set: fields });
      if (saved.matchedCount) Object.assign(reply, fields);
    }
  }

  async function conversation(incident, phone, limit, superadmin) {
    const { chat, verified, history } = await open(incident, phone, limit, true);
    if (!verified.length) {
      return { messages: [], canReply: false, hasEarlier: false, warning: noAnchor };
    }
    const anchor = verified.sort((a, b) => new Date(a.notificationSentAt) - new Date(b.notificationSentAt))[0];
    const anchorIndex = history.findIndex(message => message.id === anchor.notificationMessageId && message.outgoing);
    const since = new Date(anchor.notificationWhatsAppAt ?? anchor.notificationSentAt).getTime();
    const messages = new Map();
    for (const report of verified) {
      const id = report.notificationMessageId || String(report._id);
      messages.set(id, {
        id, body: report.notificationMessage, sentAt: report.notificationWhatsAppAt ?? report.notificationSentAt,
        outgoing: true, kind: 'automatic', unit: report.username,
      });
    }
    for (const message of (anchorIndex >= 0 ? history.slice(anchorIndex) : history.filter(entry => new Date(entry.sentAt).getTime() > since))) {
      if (message.id && !messages.has(message.id)) messages.set(message.id, message);
    }
    const audit = await replies.find({ incidentId: incident.incidentId, phone, senderKey: chat.senderKey }).toArray();
    chat.assertCurrent();
    await recoverReplyAttribution(audit, messages);
    for (const reply of audit) {
      if (reply.state !== 'sent') continue;
      const id = reply.messageId;
      messages.set(id, {
        id, body: reply.body, sentAt: reply.sentAt, outgoing: true, kind: 'reply',
        ...(superadmin ? { repliedBy: reply.repliedBy } : {}),
      });
    }
    try { chat.assertCurrent(); } catch { throw disconnected(); }
    return {
      messages: [...messages.values()].sort(byTime),
      canReply: true,
      hasEarlier: history.length === limit && anchorIndex < 0 && new Date(history[0].sentAt).getTime() > since && limit < maxHistory,
      warning: limit === maxHistory && anchorIndex < 0 && history.length === limit ? 'Showing the latest available WhatsApp messages and saved system messages.' : '',
    };
  }

  async function sendReply(req, incident, phone) {
    const body = text(req.body.message, 'Reply', 4000);
    const requestId = req.body.requestId;
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new ApiError(400, 'Invalid reply identifier.');
    const id = incident.incidentId + ':' + requestId;
    const { chat, verified } = await open(incident, phone, pageSize, false);
    if (!verified.length) throw new ApiError(409, noAnchor);
    const duplicate = await exclusive(async () => {
      const current = await authorize(req);
      if (current.incidentId !== incident.incidentId || !connected(current)) throw disconnected();
      const existing = await replies.findOne({ _id: id });
      if (existing) {
        if (existing.repliedBy !== req.user.username || existing.body !== body ||
            existing.phone !== phone || existing.senderKey !== chat.senderKey) {
          throw new ApiError(409, 'This reply identifier has already been used.');
        }
        if (existing.state !== 'sent') throw new ApiError(409, 'The earlier send could not be confirmed. Check the conversation before trying again.');
        return true;
      }
      chat.assertCurrent();
      await replies.insertOne({
        _id: id, incidentId: incident.incidentId, phone, senderKey: chat.senderKey,
        body, repliedBy: req.user.username, state: 'sending', createdAt: new Date(),
      });
      return false;
    });
    if (duplicate) return;
    try {
      const message = await whatsappCall(() => chat.reply(body));
      if (!message?.id) throw new Error('WhatsApp did not return a message ID');
      await replies.updateOne({ _id: id }, { $set: { state: 'sent', messageId: message.id, sentAt: message.sentAt } });
    } catch {
      // A lost response can happen after delivery. Keep the request reserved.
      await replies.updateOne({ _id: id, state: 'sending' }, { $set: { state: 'unknown' } }).catch(() => {});
      throw new ApiError(502, 'WhatsApp did not confirm the reply. Check the conversation before sending it again.');
    }
  }

  function reply(req, incident, phone) {
    if (pauses) throw disconnected();
    const pending = sendReply(req, incident, phone);
    inFlight.add(pending);
    return pending.finally(() => inFlight.delete(pending));
  }
  async function pauseAndDrain() {
    pauses++;
    await Promise.allSettled(inFlight);
    return () => { pauses--; };
  }

  return { list, conversation, reply, pauseAndDrain };
}

export function inboxHistoryLimit(value) {
  if (value === undefined) return pageSize;
  const limit = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(limit) || limit < pageSize || limit > maxHistory) {
    throw new ApiError(400, 'Invalid WhatsApp history limit.');
  }
  return limit;
}
