import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { ApiError, text, phone, scale, unitName, hashPassword, verifyPassword, publicUser, mutationQueue } from './lib.js';
import { deleteIncidentData } from './db.js';
import { createSessionStore } from './sessions.js';

const SESSION = 'safety_session';
const digest = token => createHash('sha256').update(token).digest('hex');
const categories = ['Toys', 'Documents', 'Electronics', 'Clothing', 'Other'];
const withoutPhoto = { projection: { photo: 0 } };
export function createApp(db, { origins = ['http://localhost:5173', 'http://127.0.0.1:5173'], rateLimits = true } = {}) {
  const app = express();
  const mutate = mutationQueue();
  const sessions = createSessionStore();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return next(new ApiError(403, 'This version is available on localhost only.'));
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('Origin') && !origins.includes(req.get('Origin'))) return next(new ApiError(403, 'Request origin is not allowed.'));
    next();
  });
  app.use(express.json({ limit: '4mb' }));
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
  const auth = async (req, res, next) => {
    try {
      const token = req.cookies[SESSION];
      const session = typeof token === 'string' ? sessions.get(digest(token)) : null;
      if (!session) throw new ApiError(401, 'Please log in again.');
      const user = await db.collection('users').findOne({ _id: session.userId });
      if (!user) throw new ApiError(401, 'This account is no longer available.');
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
  app.get('/api/health', async (req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: db.databaseName, collections: db.collectionNames, features: { whatsapp: false, photoSearch: false } });
  });
  app.post('/api/auth/login', loginLimit, async (req, res) => {
    const username = text(req.body.username, 'Account name', 40);
    const password = text(req.body.password, 'Password', 200);
    const user = await db.collection('users').findOne({ _id: username });
    if (!user || !await verifyPassword(password, user.passwordHash)) throw new ApiError(401, 'Account name or password is incorrect.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await mutate(async () => {
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
  app.get('/api/incident', auth, async (req, res) => {
    const incident = await db.collection('incidents').findOne({ _id: 'current' });
    if (incident && incident.status !== 'active') throw new ApiError(503, 'Setup or clearing is in progress. Please wait or restart the backend.');
    res.json({ incident });
  });
  app.post('/api/incident', auth, role('admin', 'superadmin'), async (req, res) => {
    const dimensions = scale(req.body);
    const name = text(req.body.name, 'Disaster name', 100);
    const result = await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      if (await db.collection('incidents').findOne({ _id: 'current' })) throw new ApiError(409, 'A disaster is already configured. Only Super Admin can clear it.');
      const incident = { _id: 'current', incidentId: randomUUID(), name, ...dimensions, status: 'provisioning', createdAt: new Date(), createdBy: req.user.username };
      await db.collection('incidents').insertOne(incident);
      try {
        const accounts = [];
        for (let b = 0; b < dimensions.buildings; b++) for (let f = 1; f <= dimensions.floors; f++) for (let r = 1; r <= dimensions.rooms; r++) {
          const username = unitName(dimensions.buildings, b, f, r);
          accounts.push({ _id: username, username, role: 'user', incidentId: incident.incidentId, building: b, floor: f, room: r, createdAt: new Date() });
        }
        // Small batches bound password-hashing memory and MongoDB request size.
        for (let i = 0; i < accounts.length; i += 16) {
          const batch = accounts.slice(i, i + 16);
          await Promise.all(batch.map(async user => { user.passwordHash = await hashPassword(user.username); }));
          await db.collection('users').insertMany(batch, { ordered: true });
        }
        await db.collection('incidents').updateOne({ _id: 'current', incidentId: incident.incidentId }, { $set: { status: 'active' } });
        return { incident: { ...incident, status: 'active' }, count: accounts.length };
      } catch (e) {
        // If cleanup fails the provisioning marker remains for startup recovery.
        await deleteIncidentData(db, incident);
        throw e;
      }
    });
    res.status(201).json(result);
  });
  app.delete('/api/incident', auth, role('superadmin'), async (req, res) => {
    if (req.body.confirmation !== 'CLEAR') throw new ApiError(400, 'Type CLEAR to confirm deletion.');
    await mutate(async () => {
      if (!sessions.get(req.sessionId)) throw new ApiError(401, 'Please log in again.');
      const incident = await db.collection('incidents').findOne({ _id: 'current' });
      if (!incident) throw new ApiError(409, 'No disaster is configured.');
      await db.collection('incidents').updateOne({ _id: 'current' }, { $set: { status: 'clearing' } });
      await deleteIncidentData(db, incident);
      sessions.deleteIncident(incident.incidentId);
    });
    res.json({ message: 'Disaster data, unit accounts, safety reports, and found items deleted. Manager accounts remain.' });
  });
  app.get('/api/incident/accounts', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await active();
    const users = await db.collection('users').find({ incidentId: incident.incidentId }, { projection: { passwordHash: 0 } }).toArray();
    res.json({ accounts: users });
  });
  app.get('/api/reports/mine', auth, role('user'), async (req, res) => {
    res.json({ report: await db.collection('safety_reports').findOne({ _id: `${req.user.incidentId}:${req.user._id}` }) });
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
      const report = { _id: id, incidentId: incident.incidentId, userId: req.user._id, username: req.user.username, building: req.user.building, floor: req.user.floor, room: req.user.room, status, familyPhone: '', situation: '', location: '', contact: '', detailsSubmittedAt: null, notificationStatus: 'disabled', createdAt: new Date() };
      await db.collection('safety_reports').insertOne(report);
      return { report, created: true };
    });
    res.status(result.created ? 201 : 200).json({ report: result.report });
  });
  app.patch('/api/reports/mine', auth, role('user'), async (req, res) => {
    if ('status' in req.body) throw new ApiError(400, 'The chosen status cannot be changed.');
    const report = await mutate(async () => {
      const incident = await stillAuthorized(req);
      const id = `${incident.incidentId}:${req.user._id}`;
      const existing = await db.collection('safety_reports').findOne({ _id: id });
      if (!existing) throw new ApiError(409, 'Choose Safe or I need help first.');
      const details = existing.status === 'safe'
        ? { familyPhone: phone(req.body.familyPhone, 'Family phone number', true), situation: '', location: '', contact: '' }
        : { familyPhone: '', situation: text(req.body.situation, 'Current situation', 1500, true), location: text(req.body.location, 'Current location', 200, true), contact: phone(req.body.contact, 'Your phone number', true) };
      if (existing.detailsSubmittedAt !== null) {
        // Legacy completed reports remain locked. Identical retries of a new
        // submission succeed if the network lost the first response.
        if (existing.detailsSubmittedAt && Object.entries(details).every(([key, value]) => (existing[key] || '') === value)) return existing;
        throw new ApiError(409, 'The optional details have already been submitted.');
      }
      const detailsSubmittedAt = new Date();
      const result = await db.collection('safety_reports').updateOne({ _id: id, detailsSubmittedAt: null }, { $set: { ...details, detailsSubmittedAt } });
      if (result.matchedCount !== 1) throw new ApiError(409, 'This report is no longer available for details. Please reload.');
      return { ...existing, ...details, detailsSubmittedAt };
    });
    res.json({ report });
  });
  app.get('/api/dashboard', auth, role('admin', 'superadmin'), async (req, res) => {
    const incident = await active();
    const reports = await db.collection('safety_reports').find({ incidentId: incident.incidentId }).toArray();
    const safe = reports.filter(r => r.status === 'safe').length;
    const help = reports.filter(r => r.status === 'help').length;
    res.json({ incident, reports, counts: { safe, help, none: incident.buildings * incident.floors * incident.rooms - safe - help } });
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
    const error = err instanceof ApiError ? err.message : status === 413 ? 'Upload is too large. Choose a photo up to 2 MB.' : status === 400 ? 'Request must contain valid JSON.' : 'The database is unavailable. Nothing has been confirmed saved. Please check the backend and try again.';
    res.status(status).json({ error });
  });
  return app;
}
