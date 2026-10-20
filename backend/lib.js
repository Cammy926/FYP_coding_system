import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function text(value, label, max = 200, optional = false) {
  if (optional && (value === undefined || (typeof value === 'string' && !value.trim()))) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ApiError(400, `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}
export function phone(value, label, optional = false) {
  if (optional && (value === undefined || (typeof value === 'string' && !value.trim()))) return '';
  const result = text(value, label, 30).replace(/[\s()-]/g, '');
  if (!/^\+?\d{8,15}$/.test(result)) throw new ApiError(400, `${label} must contain 8–15 digits, with an optional + country code.`);
  return result;
}
export function scale(body) {
  const dimensions = ['buildings', 'floors', 'rooms'];
  const limits = [8, 40, 20];
  return Object.fromEntries(dimensions.map((key, i) => {
    if (!Number.isInteger(body[key]) || body[key] < 1 || body[key] > limits[i]) throw new ApiError(400, `${key} must be a whole number from 1 to ${limits[i]}.`);
    return [key, body[key]];
  }));
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 200 || !stored) return false;
  const [salt, hash] = stored.split(':');
  const derived = await scrypt(password, salt, 64);
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}
export function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}
// A single backend process serializes incident writes, preventing clear/setup races.
export function mutationQueue() {
  let pending = Promise.resolve();
  return task => {
    const run = pending.then(task, task);
    pending = run.catch(() => {});
    return run;
  };
}
