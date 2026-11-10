import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { ApiError, text, phone, hashPassword, verifyPassword, publicUser, mutationQueue } from './lib.js';
import { blockUnitName } from '../shared/blocks.js';
import { INJURY_TYPES, emptyInjuryCounts, reportInjuries } from '../shared/injuries.js';
import { deleteIncidentData } from './db.js';
import { createSessionStore } from './sessions.js';
import { createNotifications, familyPhone } from './notifications.js';
import { createWhatsAppInbox, inboxHistoryLimit } from './whatsapp-inbox.js';
import { legacyWhatsAppClientId } from './whatsapp.js';
import { mapProjection, incidentBlocks, pngImage, validateMap, assertSameLayout, requireMarkers } from './maps.js';

const SESSION = 'safety_session';
const digest = token => createHash('sha256').update(token).digest('hex');
const categories = ['Toys', 'Documents', 'Electronics', 'Clothing', 'Other'];
const withoutPhoto = { projection: { photo: 0 } };
function publicReport(report) {
  if (!report) return report;
  const { notificationSenderKey, ...visible } = report;
  return visible;
}
export function createApp(db, { origins = ['http://localhost:5173', 'http://127.0.0.1:5173'], rateLimits = true, whatsapp, notificationOptions = {}, defaultCountryCode = '852' } = {}) {
  const app = express();
  const mutate = mutationQueue();
  const sessions = createSessionStore();
  const mapClients = new Set();
  const publishMap = (event = 'map') => {
    for (const client of mapClients) {
      if (!sessions.get(client.sessionId)) { client.res.end(); continue; }
      client.res.write(`event: ${event}\ndata: {}\n\n`);
    }
  };
  const notifications = createNotifications(db, { ...notificationOptions, transport: whatsapp, exclusive: mutate, publish: () => publishMap('reports') });
  app.locals.notifications = notifications;
  const senderId = incident => incident.whatsappClientId || legacyWhatsAppClientId;
  async function completeWhatsAppSetup() {
    await mutate(async () => {
      const incident = await db.collection('incidents').findOne({ _id: 'current', status: 'active', setupComplete: false });
      if (!incident || whatsapp?.status().state !== 'ready' || whatsapp.binding() !== senderId(incident)) return;
      await db.collection('incidents').updateOne({ _id: 'current', incidentId: incident.incidentId, setupComplete: false }, { $set: { setupComplete: true, setupCompletedAt: new Date(), whatsappLinkedAt: new Date() } });
      publishMap('setup');
    });
  }
  const unwatchWhatsApp = whatsapp?.onChange(() => {
    publishMap('whatsapp');
    if (whatsapp.status().state === 'ready') void completeWhatsAppSetup().catch(() => console.error('Could not finalize WhatsApp setup. Reload the setup page to retry.'));
  });
  const connectWhatsApp = incident => whatsapp.start({ clientId: senderId(incident) });
  app.locals.restoreWhatsApp = async () => {
    const incident = await db.collection('incidents').findOne({ _id: 'current', status: 'active' });
    if (notifications.enabled && incident && incident.setupComplete !== false) await connectWhatsApp(incident);
  };
  app.locals.closeStreams = () => { unwatchWhatsApp?.();for (const client of mapClients) client.res.end(); };
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return next(new ApiError(403, 'This version is available on localhost only.'));
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('Origin') && !origins.includes(req.get('Origin'))) return next(new ApiError(403, 'Request origin is not allowed.'));
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => {
    if (['POST', 'DELETE', 'PATCH', 'PUT'].includes(req.method) && (req.body === null || Array.isArray(req.body) || (req.body !== undefined && typeof req.body !== 'object'))) return next(new ApiError(400, 'Send a JSON object.'));
    req.body ||= {};
    next();
  });
  app.use(cookieParser());
  if (rateLimits) app.use('/api', rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please wait one minute.' } }));
  const loginLimit = rateLimits ? rateLimit({ windowMs: 60000, limit: 20, skipSuccessfulRequests: true, message: { error: 'Too many login attempts. Please wait one minute.' } }) : (req, res, next) => next();
  const active = async () => {
    const incident = await db.collection('incidents').findOne({ _id: 'current' });
    if (!incident) throw new ApiError(409, 'No disaster is active.');
    if (incident.status !== 'active') throw new ApiError(503, 'Disaster setup or clearing is in progress. Please wait, or restart the backend to recover an interrupted operation.');
    return incident;
  };
  const initialized = async () => {
    const incident = await db.collection('incidents').findOne({ _id: 'current' });
    const map = await db.collection('disaster_maps').findOne({ _id: 'current' }, { projection: { phase: 1, incidentId: 1 } });
    return incident?.status === 'active' && incident.setupComplete !== false && map?.phase === 'active' && map.incidentId === incident.incidentId;
  };
  const auth = async (req, res, next) => {
    try {
      const token = req.cookies[SESSION];
      const session = typeof token === 'string' ? sessions.get(digest(token)) : null;
      if (!session) throw new ApiError(401, 'Please log in again.');
      const user = await db.collection('users').findOne({ _id: session.userId });
      if (!user) throw new ApiError(401, 'This account is no longer available.');
      if (user.role !== 'superadmin' && !await initialized()) throw new ApiError(401, 'Please wait for Super Admin to initialize the disaster map, then sign in again.');
      if (user.role === 'user') {
        const incident = await active();
        if (incident.incidentId !== user.incidentId) throw new ApiError(401, 'Your disaster setup has been cleared.');
      }
      req.user = user; req.sessionId = session._id; next();
    } catch (e) { next(e); }
  };
  const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new ApiError(403, 'Your account cannot perform this action.'));
  const stillAuthorized = async req => {
    // Recheck inside the write queue: clear/logout may have invalidated a queued request.
    if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
    const incident = await active();
    if (req.user.role === 'user' && req.user.incidentId !== incident.incidentId) throw new ApiError(401, 'Your disaster setup has been cleared.');
    return incident;
  };
  const inbox = createWhatsAppInbox(db, { transport: whatsapp, senderId, exclusive: mutate, authorize: stillAuthorized });
  app.locals.drainWhatsAppReplies = inbox.pauseAndDrain;
  const inboxIncident = async (req, incidentId) => {
    const incident = await stillAuthorized(req);
    if (incident.incidentId !== incidentId || incident.setupComplete === false) {
      throw new ApiError(409, 'Open the WhatsApp inbox for the current disaster.');
    }
    return incident;
  };
  app.get('/api/whatsapp/chats', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await inboxIncident(req, req.query.incidentId);
    const result = await inbox.list(incident);
    await inboxIncident(req, incident.incidentId);
    res.json(result);
  });
  app.get('/api/whatsapp/chats/:phone', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await inboxIncident(req, req.query.incidentId);
    const result = await inbox.conversation(incident, req.params.phone, inboxHistoryLimit(req.query.limit), req.user.role === 'superadmin');
    await inboxIncident(req, incident.incidentId);
    res.json(result);
  });
  app.post('/api/whatsapp/chats/:phone/reply', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await inboxIncident(req, req.body.incidentId);
    await inbox.reply(req, incident, req.params.phone);
    res.status(201).json({ sent: true });
  });
  app.get('/api/health', async (req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: db.databaseName, collections: db.collectionNames, features: { whatsapp: notifications.enabled, photoSearch: false }, whatsapp: notifications.status() });
  });
  app.post('/api/auth/login', loginLimit, async (req, res) => {
    const username = text(req.body.username, 'Account name', 40);
    const password = text(req.body.password, 'Password', 200);
    const user = await db.collection('users').findOne({ _id: username });
    if (!user || !await verifyPassword(password, user.passwordHash)) throw new ApiError(401, 'Account name or password is incorrect.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await mutate(async () => {
      if (user.role !== 'superadmin' && !await initialized()) throw new ApiError(403, 'Only Super Admin can sign in until the disaster map and WhatsApp setup are complete.');
      if (user.role === 'user' && user.incidentId !== (await active()).incidentId) throw new ApiError(401, 'This unit account is no longer active.');
      sessions.create({ _id: digest(token), userId: user._id, ...(user.incidentId ? { incidentId: user.incidentId } : {}), expiresAt, createdAt: new Date() });
    });
    res.cookie(SESSION, token, { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/' });
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', auth, async (req, res) => {
    await mutate(() => sessions.delete(req.sessionId));
    res.clearCookie(SESSION, { path: '/', httpOnly: true, sameSite: 'strict' });
    res.json({ message: 'Logged out.' });
  });
  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
  app.get('/api/whatsapp', auth, role('superadmin'), async (req, res) => {
    await completeWhatsAppSetup();
    const incident = await active();
    const matchingSender = whatsapp?.binding() === senderId(incident);
    const connection = whatsapp?.setupStatus();
    res.json({ ...connection, ...(!matchingSender && notifications.enabled ? { state: ['error', 'disconnected', 'auth_failure'].includes(connection.state) ? connection.state : 'idle', qrAvailable: false } : {}), enabled: notifications.enabled, incidentId: incident.incidentId, setupComplete: incident.setupComplete !== false });
  });
  app.post('/api/whatsapp/connect', auth, role('superadmin'), async (req, res) => {
    if (!notifications.enabled) throw new ApiError(409, 'WhatsApp is disabled in the backend configuration.');
    const incident = await mutate(async () => {
      const current = await stillAuthorized(req);
      if (req.body.incidentId !== current.incidentId) throw new ApiError(409, 'This setup belongs to a previous disaster. Reload the current setup.');
      await connectWhatsApp(current);
      return current;
    });
    // Starting is serialized before returning; Chromium/QR loading continues in
    // the background so the setup page can render while the sender logs in.
    res.status(202).json({ ...whatsapp.setupStatus(), incidentId: incident.incidentId });
  });
  app.get('/api/whatsapp/qr', auth, role('superadmin'), async (req, res) => {
    const incident = await active();
    if (req.query.incidentId !== incident.incidentId) throw new ApiError(409, 'Reload the QR for the current disaster.');
    if (whatsapp?.binding() !== senderId(incident)) throw new ApiError(409, 'Start the connection for this disaster first.');
    const image = whatsapp.qr();
    if (!image) throw new ApiError(404, 'The QR is loading or has already been scanned.');
    res.type('image/png').send(image);
  });
  app.get('/api/incident', auth, async (req, res) => {
    const incident = await db.collection('incidents').findOne({ _id: 'current' });
    if (incident && incident.status !== 'active') throw new ApiError(503, 'Setup or clearing is in progress. Please wait or restart the backend.');
    const map = incident ? await db.collection('disaster_maps').findOne({ _id: 'current', phase: 'active', incidentId: incident.incidentId }, { projection: { name: 1, blocks: 1 } }) : null;
    const response = { incident: map ? { ...incident, name: map.name, blocks: map.blocks } : incident };
    if (req.user.role === 'superadmin' && incident && whatsapp?.binding() === senderId(incident)) {
      response.whatsappSenderNumber = whatsapp.senderNumber?.() ?? null;
    }
    res.json(response);
  });
  app.get('/api/map', auth, role('admin', 'superadmin'), async (req, res) => {
    res.json({ map: await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection) });
  });
  app.get('/api/map/image', auth, role('admin', 'superadmin'), async (req, res) => {
    const map = await db.collection('disaster_maps').findOne({ _id: 'current' });
    if (!map) throw new ApiError(404, 'Upload a disaster map first.');
    res.type('image/png').send(Buffer.from(map.image.data, 'base64'));
  });
  app.get('/api/map/events', auth, role('admin', 'superadmin'), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); res.write(': connected\n\n');
    const client = { res, sessionId: req.sessionId }; mapClients.add(client);
    const heartbeat = setInterval(() => {
      if (!sessions.get(req.sessionId)) return res.end();
      res.write(': keepalive\n\n');
    }, 20000);
    req.on('close', () => { clearInterval(heartbeat); mapClients.delete(client); });
  });
  app.post('/api/map', auth, role('superadmin'), async (req, res) => {
    const image = await pngImage(req.body.image);
    const map = await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      const existing = await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
      if (existing) {
        if (req.body.revision !== existing.revision) throw new ApiError(409, 'The map changed in another window. Reload the saved map.');
        const result = await db.collection('disaster_maps').updateOne({ _id: 'current', revision: existing.revision }, { $set: { image, imageId: randomUUID(), updatedAt: new Date() }, $inc: { revision: 1 } });
        if (result.matchedCount !== 1) throw new ApiError(409, 'The map changed. Reload the saved map.');
      } else {
        const incident = await db.collection('incidents').findOne({ _id: 'current' });
        await db.collection('disaster_maps').insertOne({ _id: 'current', phase: 'draft', incidentId: incident?.incidentId || null, image, imageId: randomUUID(), name: incident?.name || 'Disaster area', blocks: incident ? incidentBlocks(incident) : [], annotations: [], revision: 1, createdAt: new Date(), updatedAt: new Date(), createdBy: req.user.username });
      }
      return db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
    });
    publishMap();res.status(201).json({ map });
  });
  app.patch('/api/map', auth, role('superadmin'), async (req, res) => {
    const map = await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      const existing = await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
      if (!existing) throw new ApiError(409, 'Upload a disaster map first.');
      if (req.body.revision !== existing.revision) throw new ApiError(409, 'The map changed in another window. Reload the saved map. Your local edits have not overwritten it.');
      const incident = await db.collection('incidents').findOne({ _id: 'current' });
      const fields = validateMap(req.body, incident ? incidentBlocks(incident) : []);
      if (incident) assertSameLayout(fields.blocks, incident);
      if (existing.phase === 'active') requireMarkers(fields);
      const result = await db.collection('disaster_maps').updateOne({ _id: 'current', revision: existing.revision }, { $set: { ...fields, updatedAt: new Date() }, $inc: { revision: 1 } });
      if (result.matchedCount !== 1) throw new ApiError(409, 'The map changed. Reload the saved map.');
      return db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
    });
    publishMap();res.json({ map });
  });
  app.post('/api/incident', auth, role('superadmin'), async (req, res) => {
    const result = await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      const map = await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
      if (!map) throw new ApiError(400, 'Upload and annotate a PNG map first.');
      if (map.phase !== 'draft') throw new ApiError(409, 'The map is already initialized. Use Edit map to adjust drawings.');
      if (req.body.mapRevision !== map.revision) throw new ApiError(409, 'Wait for all map edits to save before initializing.');
      requireMarkers(map);
      const existing = await db.collection('incidents').findOne({ _id: 'current' });
      if (existing) {
        if (existing.status !== 'active') throw new ApiError(503, 'Restart the backend to recover the unfinished setup.');
        assertSameLayout(map.blocks, existing);
        const result = await db.collection('disaster_maps').updateOne({ _id: 'current', revision: map.revision }, { $set: { phase: 'active', incidentId: existing.incidentId, updatedAt: new Date() }, $inc: { revision: 1 } });
        if (result.matchedCount !== 1) throw new ApiError(409, 'The map changed. Reload the saved map.');
        const setupComplete = !notifications.enabled;
        await db.collection('incidents').updateOne({ _id: 'current', incidentId: existing.incidentId }, { $set: { setupComplete } });
        if (!setupComplete) await connectWhatsApp(existing);
        return { incident: { ...existing, setupComplete }, count: await db.collection('users').countDocuments({ incidentId: existing.incidentId }), preserved: true };
      }
      // Validate again so a draft saved by an older backend gets named prefixes too.
      map.blocks = validateMap(map).blocks;
      const incidentId = randomUUID();
      const incident = { _id: 'current', incidentId, setupComplete: !notifications.enabled, ...(notifications.enabled ? { whatsappClientId: 'auto-safety-report-' + incidentId } : {}), name: map.name, buildings: map.blocks.length, blocks: map.blocks, blockIdentityVersion: 1, floors: map.blocks[0].floors, rooms: map.blocks[0].rooms, status: 'provisioning', createdAt: new Date(), createdBy: req.user.username };
      await db.collection('incidents').insertOne(incident);
      try {
        const accounts = [];
        for (const block of map.blocks) for (let f = 1; f <= block.floors; f++) for (let r = 1; r <= block.rooms; r++) {
          const username = blockUnitName(block, f, r);
          accounts.push({ _id: username, username, role: 'user', incidentId: incident.incidentId, building: block.building, floor: f, room: r, createdAt: new Date() });
        }
        for (let i = 0; i < accounts.length; i += 16) {
          const batch = accounts.slice(i, i + 16);
          await Promise.all(batch.map(async user => { user.passwordHash = await hashPassword(user.username); }));
          await db.collection('users').insertMany(batch, { ordered: true });
        }
        const saved = await db.collection('disaster_maps').updateOne({ _id: 'current', revision: map.revision }, { $set: { phase: 'active', incidentId: incident.incidentId, blocks: map.blocks, updatedAt: new Date() }, $inc: { revision: 1 } });
        if (saved.matchedCount !== 1) throw new ApiError(409, 'The map changed. Reload the saved map.');
        await db.collection('incidents').updateOne({ _id: 'current', incidentId: incident.incidentId }, { $set: { status: 'active' } });
        if (!incident.setupComplete) await connectWhatsApp(incident);
        return { incident: { ...incident, status: 'active' }, count: accounts.length, preserved: false };
      } catch (e) {
        await db.collection('disaster_maps').updateOne({ _id: 'current', incidentId: incident.incidentId }, { $set: { phase: 'draft', incidentId: null } });
        await deleteIncidentData(db, incident);throw e;
      }
    });
    publishMap();res.status(201).json(result);
  });
  app.delete('/api/incident', auth, role('superadmin'), async (req, res) => {
    if (req.body.confirmation !== 'CLEAR') throw new ApiError(400, 'Type CLEAR to confirm deletion.');
    const [resumeNotifications, resumeReplies] = await Promise.all([
      notifications.pauseAndDrain(), inbox.pauseAndDrain(),
    ]);
    try { await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      const incident = await db.collection('incidents').findOne({ _id: 'current' });
      if (!incident) throw new ApiError(409, 'No disaster is configured.');
      // Confirm remote logout before marking clearing. If it fails, all
      // disaster data stays available for another attempt. Recovery after this
      // point can safely finish deletion because the sender was logged out.
      if (whatsapp) {
        try { await whatsapp.logout({ clientId: senderId(incident) }); }
        catch { throw new ApiError(503, 'WhatsApp logout could not be confirmed. Your disaster data is preserved. Reconnect WhatsApp and retry Clear Setup.'); }
      }
      await db.collection('incidents').updateOne({ _id: 'current' }, { $set: { status: 'clearing' } });
      await deleteIncidentData(db, incident);
      sessions.deleteIncident(incident.incidentId);
    }); } finally { resumeNotifications(); resumeReplies(); }
    publishMap();
    res.json({ message: 'Disaster data, unit accounts, safety reports, and found items deleted. Manager accounts remain.' });
  });
  app.get('/api/incident/accounts', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await active();
    const users = await db.collection('users').find({ incidentId: incident.incidentId }, { projection: { passwordHash: 0 } }).toArray();
    res.json({ accounts: users });
  });
  app.get('/api/reports/mine', auth, role('user'), async (req, res) => {
    res.json({ report: publicReport(await db.collection('safety_reports').findOne({ _id: `${req.user.incidentId}:${req.user._id}` })) });
  });
  // Save the button press before asking for optional details.
  app.post('/api/reports', auth, role('user'), async (req, res) => {
    if (!['safe', 'help'].includes(req.body.status)) throw new ApiError(400, 'Choose safe or help.');
    const status = req.body.status;
    const result = await mutate(async () => {
      const incident = await stillAuthorized(req);
      const id = `${incident.incidentId}:${req.user._id}`;
      const existing = await db.collection('safety_reports').findOne({ _id: id });
      if (existing) {
        if (existing.status !== status) throw new ApiError(409, 'This unit has already chosen a status. You can finish its optional details.');
        return { report: existing, created: false };
      }
      const report = { _id: id, incidentId: incident.incidentId, userId: req.user._id, username: req.user.username, building: req.user.building, floor: req.user.floor, room: req.user.room, status, familyPhone: '', situation: '', location: '', contact: '', injuries: [], injuryStepCompletedAt: null, revision: 1, detailsSubmittedAt: null, notificationStatus: notifications.enabled ? status === 'safe' ? 'not_requested' : 'not_applicable' : 'disabled', createdAt: new Date() };
      await db.collection('safety_reports').insertOne(report);
      return { report, created: true };
    });
    if (result.created) publishMap('reports');
    res.status(result.created ? 201 : 200).json({ report: publicReport(result.report) });
  });
  app.patch('/api/reports/mine/injuries', auth, role('user'), async (req, res) => {
    const completeStep = req.body.completeStep === true;
    if (completeStep ? ('injury' in req.body || 'selected' in req.body) : (!INJURY_TYPES.some(type => type.id === req.body.injury) || typeof req.body.selected !== 'boolean')) throw new ApiError(400, 'Choose a valid injury and whether it is selected, or continue to the optional details.');
    const report = await mutate(async () => {
      const incident = await stillAuthorized(req);
      const id = `${incident.incidentId}:${req.user._id}`;
      const existing = await db.collection('safety_reports').findOne({ _id: id });
      if (!existing || existing.status !== 'help') throw new ApiError(409, 'Choose I need help before selecting injuries.');
      if (existing.detailsSubmittedAt !== null) throw new ApiError(409, 'This report has already been submitted.');
      const injuries = reportInjuries(existing);
      if (completeStep && existing.injuryStepCompletedAt) return existing;
      if (!completeStep && injuries.includes(req.body.injury) === req.body.selected) return existing;
      const update = completeStep
        ? { $set: { injuryStepCompletedAt: new Date() }, $inc: { revision: 1 } }
        : { [req.body.selected ? '$addToSet' : '$pull']: { injuries: req.body.injury }, $inc: { revision: 1 } };
      const saved = await db.collection('safety_reports').updateOne({ _id: id, detailsSubmittedAt: null }, update);
      if (saved.matchedCount !== 1) throw new ApiError(409, 'This report changed. Please reload.');
      return db.collection('safety_reports').findOne({ _id: id });
    });
    publishMap('reports');res.json({ report: publicReport(report) });
  });
  app.patch('/api/reports/mine', auth, role('user'), async (req, res) => {
    if ('status' in req.body) throw new ApiError(400, 'The chosen status cannot be changed.');
    if ('injuries' in req.body) throw new ApiError(400, 'Use the injury selection buttons to update injuries.');
    const report = await mutate(async () => {
      const incident = await stillAuthorized(req);
      const id = `${incident.incidentId}:${req.user._id}`;
      const existing = await db.collection('safety_reports').findOne({ _id: id });
      if (!existing) throw new ApiError(409, 'Choose Safe or I need help first.');
      const details = existing.status === 'safe'
        ? { familyPhone: notifications.enabled ? familyPhone(req.body.familyPhone, defaultCountryCode) : phone(req.body.familyPhone, 'Family phone number', true), situation: '', location: '', contact: '' }
        : { familyPhone: '', situation: text(req.body.situation, 'Current situation', 1500, true), location: text(req.body.location, 'Current location', 200, true), contact: phone(req.body.contact, 'Your phone number', true) };
      if (existing.detailsSubmittedAt !== null) {
        // Legacy completed reports remain locked. Identical retries of a new
        // submission succeed if the network lost the first response.
        if (existing.detailsSubmittedAt && Object.entries(details).every(([key, value]) => (existing[key] || '') === value)) return existing;
        throw new ApiError(409, 'The optional details have already been submitted.');
      }
      const detailsSubmittedAt = new Date();
      const map = await db.collection('disaster_maps').findOne({ _id: 'current', incidentId: incident.incidentId }, { projection: { name: 1 } });
      const notificationFields = notifications.fieldsFor(existing, details, map?.name || incident.name);
      const result = await db.collection('safety_reports').updateOne({ _id: id, detailsSubmittedAt: null }, { $set: { ...details, ...notificationFields, detailsSubmittedAt }, $inc: { revision: 1 } });
      if (result.matchedCount !== 1) throw new ApiError(409, 'This report is no longer available for details. Please reload.');
      return { ...existing, ...details, ...notificationFields, detailsSubmittedAt, revision: (existing.revision || 0) + 1 };
    });
    publishMap('reports');void notifications.kick();res.json({ report: publicReport(report) });
  });
  app.patch('/api/floors/:building/:floor', auth, role('admin', 'superadmin'), async (req, res) => {
    const building = Number(req.params.building), floor = Number(req.params.floor);
    if (!/^\d+$/.test(req.params.building) || !/^\d+$/.test(req.params.floor) || !Number.isSafeInteger(building) || !Number.isSafeInteger(floor)) throw new ApiError(400, 'Choose a valid building and floor.');
    if (!['not_started', 'cleared', 'inaccessible'].includes(req.body.status)) throw new ApiError(400, 'Choose a valid floor search status.');
    if (!Number.isSafeInteger(req.body.revision) || req.body.revision < 0) throw new ApiError(400, 'Reload the floor status before updating it.');
    const status = req.body.status, note = text(req.body.note, 'Floor note', 300, true);
    const expectedIncident = text(req.body.incidentId, 'Disaster identifier', 100);
    if (status === 'inaccessible' && !note) throw new ApiError(400, 'Add a short reason why this floor cannot be searched.');
    const result = await mutate(async () => {
      const incident = await stillAuthorized(req);
      if (incident.setupComplete === false) throw new ApiError(409, 'Finish the Super Admin WhatsApp setup first.');
      if (incident.incidentId !== expectedIncident) throw new ApiError(409, 'This floor belongs to a previous disaster. Reload the current setup.');
      const map = await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
      if (map?.phase !== 'active' || map.incidentId !== incident.incidentId) throw new ApiError(409, 'Initialize the disaster map first.');
      if (!map.blocks[building] || floor < 1 || floor > map.blocks[building].floors) throw new ApiError(400, 'Choose a floor in this building.');
      const id = `${incident.incidentId}:${building}:${floor}`;
      const existing = await db.collection('floor_searches').findOne({ _id: id });
      if (existing && existing.status === status && existing.note === note) return existing;
      if ((existing?.revision || 0) !== req.body.revision) throw new ApiError(409, 'Another responder updated this floor. Reload its latest status before changing it.');
      const updatedAt = new Date();
      const record = { _id: id, incidentId: incident.incidentId, building, floor, status, note, revision: (existing?.revision || 0) + 1, updatedAt, updatedBy: req.user.username, createdAt: existing?.createdAt || updatedAt };
      if (existing) {
        const { _id, ...fields } = record;
        const saved = await db.collection('floor_searches').updateOne({ _id: id, revision: existing.revision }, { $set: fields });
        if (saved.matchedCount !== 1) throw new ApiError(409, 'This floor changed. Reload its latest status.');
      } else {
        try { await db.collection('floor_searches').insertOne(record); }
        catch (error) { if (error.code === 11000) throw new ApiError(409, 'Another responder updated this floor. Reload its latest status.'); throw error; }
      }
      return record;
    });
    publishMap('floor-search');res.json({ floorSearch: result });
  });
  app.get('/api/dashboard', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await active();
    if (incident.setupComplete === false) throw new ApiError(409, 'Finish the Super Admin WhatsApp setup first.');
    const map = await db.collection('disaster_maps').findOne({ _id: 'current' }, mapProjection);
    if (map?.phase !== 'active' || map.incidentId !== incident.incidentId) throw new ApiError(409, 'Initialize the disaster map first.');
    const blocks = map.blocks;
    let selected = null;
    if (req.query.building !== undefined) {
      if (typeof req.query.building !== 'string' || !/^\d+$/.test(req.query.building) || !blocks[Number(req.query.building)]) throw new ApiError(400, 'Choose a valid building block.');
      selected = Number(req.query.building);
    }
    const reports = await db.collection('safety_reports').find({ incidentId: incident.incidentId, ...(selected === null ? {} : { building: selected }) }).toArray();
    const safe = reports.filter(r => r.status === 'safe').length, help = reports.filter(r => r.status === 'help').length;
    const injuryCounts = emptyInjuryCounts();
    for (const report of reports) for (const injury of reportInjuries(report)) injuryCounts[injury]++;
    const total = blocks.filter(b => selected === null || b.building === selected).reduce((n, b) => n + b.floors * b.rooms, 0);
    const floorSearches = (await db.collection('floor_searches').find({ incidentId: incident.incidentId, ...(selected === null ? {} : { building: selected }) }).toArray()).filter(record => blocks[record.building] && Number.isInteger(record.floor) && record.floor >= 1 && record.floor <= blocks[record.building].floors && ['not_started', 'cleared', 'inaccessible'].includes(record.status));
    const floorTotal = blocks.filter(b => selected === null || b.building === selected).reduce((n, b) => n + b.floors, 0);
    const cleared = floorSearches.filter(f => f.status === 'cleared').length, inaccessible = floorSearches.filter(f => f.status === 'inaccessible').length;
    res.json({ incident: { ...incident, name: map.name, blocks }, reports: reports.map(publicReport), building: selected, counts: { safe, help, none: total - safe - help }, injuryCounts, floorSearches, searchProgress: { cleared, inaccessible, pending: floorTotal - cleared - inaccessible, total: floorTotal } });
  });
  app.get('/api/items', auth, async (req, res) => {
    const incident = await active();
    const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (keyword.length > 100) throw new ApiError(400, 'Search must be at most 100 characters.');
    let items = await db.collection('found_items').find({ incidentId: incident.incidentId }, withoutPhoto).toArray();
    // Literal, case-insensitive keywords: avoids regex injection and Atlas dependence.
    const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) items = items.filter(item => words.every(word => `${item.description} ${item.place} ${item.category}`.toLowerCase().includes(word)));
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items });
  });
  app.get('/api/items/:id/photo', auth, async (req, res) => {
    const incident = await active();
    const item = await db.collection('found_items').findOne({ _id: req.params.id, incidentId: incident.incidentId });
    if (!item) throw new ApiError(404, 'Item is no longer available.');
    res.type('image/jpeg').send(Buffer.from(item.photo.split(',')[1], 'base64'));
  });
  app.get('/api/items/:id', auth, async (req, res) => {
    const incident = await active();
    const item = await db.collection('found_items').findOne({ _id: req.params.id, incidentId: incident.incidentId }, withoutPhoto);
    if (!item) throw new ApiError(404, 'Item is no longer available.');
    res.json({ item });
  });
  app.post('/api/items', auth, async (req, res) => {
    const description = text(req.body.description, 'Description', 1500);
    const place = text(req.body.place, 'Place found', 200);
    const contact = text(req.body.contact, 'Finder contact', 120);
    if (!/^\+?[\d\s()-]{8,30}$/.test(contact) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new ApiError(400, 'Finder contact must be a phone number or email address.');
    if (!categories.includes(req.body.category)) throw new ApiError(400, 'Choose a valid category.');
    const photo = req.body.photo;
    if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(photo) || photo.length > 2800000) throw new ApiError(400, 'Upload a JPEG, PNG, or WebP photo up to 2 MB.');
    let compressed;
    try {
      const input = Buffer.from(photo.split(',')[1], 'base64');
      const image = sharp(input, { limitInputPixels: 25000000 });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Unsupported image');
      compressed = await image.rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    } catch { throw new ApiError(400, 'The photo cannot be read. Choose a valid JPEG, PNG, or WebP image.'); }
    const item = await mutate(async () => {
      const incident = await stillAuthorized(req);
      const item = { _id: randomUUID(), incidentId: incident.incidentId, description, place, contact, category: req.body.category, photo: `data:image/jpeg;base64,${compressed.toString('base64')}`, createdBy: req.user.username, createdAt: new Date() };
      await db.collection('found_items').insertOne(item);
      const { photo, ...result } = item; return result;
    });
    res.status(201).json({ item });
  });
  app.use('/api', (req, res, next) => next(new ApiError(404, 'API route not found.')));
  app.use((err, req, res, next) => {
    const status = err instanceof ApiError ? err.status : err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 503;
    if (status === 503) console.error(`Database/service error: ${err.name}, code ${err.code || 'unknown'}`);
    const error = err instanceof ApiError ? err.message : status === 413 ? 'Upload is too large. Choose a PNG map up to 4 MB or a found-item photo up to 2 MB.' : status === 400 ? 'Request must contain valid JSON.' : 'The database is unavailable. Nothing has been confirmed saved. Please check the backend and try again.';
    res.status(status).json({ error });
  });
  return app;
}
