// Localhost login state lives only in this backend process, never in MongoDB.
// Restarting the backend invalidates every login; logout revokes it immediately.
export function createSessionStore(now = Date.now) {
  const records = new Map();
  const get = id => {
    const session = records.get(id);
    if (session && session.expiresAt.getTime() <= now()) { records.delete(id); return undefined; }
    return session;
  };
  return {
    get,
    create: session => {
      for (const id of records.keys()) get(id);
      records.set(session._id, session);
    },
    delete: id => records.delete(id),
    deleteIncident: incidentId => {
      for (const [id, session] of records) if (session.incidentId === incidentId) records.delete(id);
    },
  };
}
