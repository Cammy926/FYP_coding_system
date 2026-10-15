import sharp from 'sharp';
import { ApiError, text } from './lib.js';

export const mapProjection = { projection: { 'image.data': 0 } };
export function mapMetadata(map) {
  if (!map) return null;
  const { data, ...image } = map.image;
  return { ...map, image };
}
export function incidentBlocks(incident) {
  return incident.blocks || Array.from({ length: incident.buildings }, (_, building) => ({ building, label: `Block ${String.fromCharCode(65 + building)}`, floors: incident.floors, rooms: incident.rooms }));
}
export async function pngImage(value) {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) || value.length > 5600000) throw new ApiError(400, 'Choose a PNG map up to 4 MB.');
  try {
    const input = Buffer.from(value.split(',')[1], 'base64');
    if (input.length > 4 * 1024 * 1024) throw new Error('Too large');
    const metadata = await sharp(input, { limitInputPixels: 25000000 }).metadata();
    if (metadata.format !== 'png' || metadata.pages > 1) throw new Error('Not a still PNG');
    for (const size of [2400, 1800, 1400, 1000]) {
      const { data, info } = await sharp(input, { limitInputPixels: 25000000 }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      if (data.length <= 1200000) return { data: data.toString('base64'), width: info.width, height: info.height };
    }
  } catch { throw new ApiError(400, 'The map cannot be read. Upload a valid PNG up to 4 MB and 25 megapixels.'); }
  throw new ApiError(400, 'The map is too detailed to store. Please upload a smaller PNG.');
}
export function validateMap(body) {
  const name = text(body.name, 'Disaster name', 100);
  if (!Array.isArray(body.blocks) || body.blocks.length > 8) throw new ApiError(400, 'Use up to eight building blocks.');
  const labels = new Set();
  const blocks = body.blocks.map((block, building) => {
    if (!block || block.building !== building || !Number.isInteger(block.floors) || block.floors < 1 || block.floors > 40 || !Number.isInteger(block.rooms) || block.rooms < 1 || block.rooms > 20) throw new ApiError(400, 'Each block needs 1–40 floors and 1–20 rooms per floor.');
    const label = text(block.label, 'Block label', 60);
    if (labels.has(label.toLowerCase())) throw new ApiError(400, 'Block labels must be unique.');
    labels.add(label.toLowerCase()); return { building, label, floors: block.floors, rooms: block.rooms };
  });
  if (!Array.isArray(body.annotations) || body.annotations.length > 200) throw new ApiError(400, 'Use up to 200 drawings.');
  const ids = new Set(), markers = new Set(); let points = 0;
  const number = (value, min, max) => { if (!Number.isFinite(value) || value < min || value > max) throw new ApiError(400, 'Drawing coordinates or sizes are invalid.'); return value; };
  const position = a => ({ x: number(a.x, 0, 1), y: number(a.y, 0, 1) });
  const color = value => { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new ApiError(400, 'Choose a valid drawing color.'); return value; };
  const annotations = body.annotations.map(a => {
    if (!a || typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(a.id) || ids.has(a.id)) throw new ApiError(400, 'Drawing identifiers must be unique.');
    ids.add(a.id);
    const base = { id: a.id, type: a.type };
    if (a.type === 'pen') {
      if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 1200 || (points += a.points.length) > 20000) throw new ApiError(400, 'The drawing has too many points.');
      return { ...base, color: color(a.color), width: number(a.width, 1, 12), points: a.points.map(position) };
    }
    if (a.type === 'rectangle') {
      const p = position(a), w = number(a.w, 0.001, 1), h = number(a.h, 0.001, 1);
      if (p.x + w > 1.000001 || p.y + h > 1.000001) throw new ApiError(400, 'Keep drawings inside the map.');
      return { ...base, ...p, w, h, color: color(a.color), width: number(a.width, 1, 12) };
    }
    if (a.type === 'text') return { ...base, ...position(a), text: text(a.text, 'Map note', 120), color: color(a.color), fontSize: number(a.fontSize, 12, 48) };
    if (a.type === 'block') {
      if (!Number.isInteger(a.building) || !blocks[a.building] || markers.has(a.building)) throw new ApiError(400, 'Each block can have one clickable label.');
      const p = position(a), dimensions = {};
      // Older labels keep their natural size until explicitly resized.
      if (a.w !== undefined || a.h !== undefined) {
        dimensions.w = number(a.w, 0.04, 1); dimensions.h = number(a.h, 0.03, 1);
        if (p.x - dimensions.w / 2 < -0.000001 || p.x + dimensions.w / 2 > 1.000001 || p.y - dimensions.h / 2 < -0.000001 || p.y + dimensions.h / 2 > 1.000001) throw new ApiError(400, 'Keep the whole building label inside the map.');
      }
      markers.add(a.building); return { ...base, ...p, building: a.building, ...dimensions };
    }
    throw new ApiError(400, 'Unknown drawing tool.');
  });
  if (Buffer.byteLength(JSON.stringify({ blocks, annotations })) > 180000) throw new ApiError(400, 'The drawings are too large. Remove some pen strokes.');
  return { name, blocks, annotations };
}
export function assertSameLayout(blocks, incident) {
  const existing = incidentBlocks(incident);
  if (blocks.length !== existing.length || blocks.some((b, i) => b.building !== existing[i].building || b.floors !== existing[i].floors || b.rooms !== existing[i].rooms)) throw new ApiError(409, 'Existing unit layouts are locked. You can move labels, rename blocks, and change drawings.');
}
export function requireMarkers(map) {
  if (!map.blocks.length || map.blocks.some(b => !map.annotations.some(a => a.type === 'block' && a.building === b.building))) throw new ApiError(400, 'Place one clickable building label for every block before initializing.');
}
