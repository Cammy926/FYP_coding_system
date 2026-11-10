// The API uses logical names; each maps to its own MongoDB collection.
export const COLLECTION_NAMES = Object.freeze({ users: 'user', incidents: 'incidents', safety_reports: 'safety_reports', found_items: 'found_items', disaster_maps: 'disaster_maps', floor_searches: 'floor_searches', whatsapp_replies: 'whatsapp_replies' });
export function createStore(db) {
  return {
    databaseName: db.databaseName,
    collectionNames: COLLECTION_NAMES,
    command: command => db.command(command),
    collection: name => {
      if (!Object.hasOwn(COLLECTION_NAMES, name)) throw new Error(`Unknown system record group: ${name}`);
      return db.collection(COLLECTION_NAMES[name]);
    },
  };
}
