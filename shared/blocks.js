// A building's position in the map array is not its account identity.
export function codeFromLabel(label = '') {
  return /^(?:(?:block|building|tower)\s+)?([a-z])(?:$|[^a-z0-9])/i.exec(label.trim())?.[1].toUpperCase();
}

export function blockUnitName(block, floor, room) {
  const unit = `${floor}${String(room).padStart(2, '0')}`;
  return block.accountPrefix ? `${block.accountPrefix}-${unit}` : unit;
}
