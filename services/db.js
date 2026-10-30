// ORBIT — IndexedDB Service
import { DB_NAME, DB_VERSION, STORES } from '../lib/config.js';
export { STORES };

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // posts — analyzed reddit posts, keyed by reddit post id
      if (!db.objectStoreNames.contains(STORES.POSTS)) {
        const s = db.createObjectStore(STORES.POSTS, { keyPath: 'id' });
        s.createIndex('subreddit', 'subreddit', { unique: false });
        s.createIndex('analyzedAt', 'analyzedAt', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }

      // drafts
      if (!db.objectStoreNames.contains(STORES.DRAFTS)) {
        const s = db.createObjectStore(STORES.DRAFTS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('postId', 'postId', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }

      // tasks / reminders
      if (!db.objectStoreNames.contains(STORES.TASKS)) {
        const s = db.createObjectStore(STORES.TASKS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('nextRun', 'nextRun', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }

      // memory — key/value facts
      if (!db.objectStoreNames.contains(STORES.MEMORY)) {
        db.createObjectStore(STORES.MEMORY, { keyPath: 'key' });
      }

      // history — action log
      if (!db.objectStoreNames.contains(STORES.HISTORY)) {
        const s = db.createObjectStore(STORES.HISTORY, { keyPath: 'id', autoIncrement: true });
        s.createIndex('timestamp', 'timestamp', { unique: false });
        s.createIndex('type', 'type', { unique: false });
      }

      // research — cached tavily
      if (!db.objectStoreNames.contains(STORES.RESEARCH)) {
        const s = db.createObjectStore(STORES.RESEARCH, { keyPath: 'id', autoIncrement: true });
        s.createIndex('query', 'query', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // sessions — chat history
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        const s = db.createObjectStore(STORES.SESSIONS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    if (req) {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    } else {
      t.oncomplete = () => resolve();
      t.onerror = (e) => reject(e.target.error);
    }
  });
}

// Generic CRUD
export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, val) => tx(store, 'readwrite', (s) => s.put(val)),
  delete: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),

  getByIndex: (store, indexName, value) =>
    new Promise(async (resolve, reject) => {
      const dbConn = await openDB();
      const t = dbConn.transaction(store, 'readonly');
      const s = t.objectStore(store).index(indexName);
      const req = s.getAll(value);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    }),

  getAllSorted: (store, indexName, direction = 'prev', limit = 100) =>
    new Promise(async (resolve, reject) => {
      const dbConn = await openDB();
      const results = [];
      const t = dbConn.transaction(store, 'readonly');
      const idx = t.objectStore(store).index(indexName);
      const req = idx.openCursor(null, direction);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    }),
};

// Memory helpers
export const memory = {
  get: (key) => db.get(STORES.MEMORY, key).then(r => r?.value),
  set: (key, value) => db.put(STORES.MEMORY, { key, value, updatedAt: Date.now() }),
  delete: (key) => db.delete(STORES.MEMORY, key),
  getAll: () => db.getAll(STORES.MEMORY),
};

// History/log helpers
export async function logAction(type, data = {}) {
  return db.put(STORES.HISTORY, {
    type,
    timestamp: Date.now(),
    ...data,
  });
}
