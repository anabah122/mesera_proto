// Локальное хранилище журналов на IndexedDB.
//
// Ключ записи — [doc, idx]. Такой составной ключ даёт диапазонные запросы
// внутри документа: и досыл вперёд, и окно истории вверх — обход курсором,
// без чтения всего журнала.
//
// Журнал копится целиком: единожды загруженное больше не запрашивается.
// Ограничение в тысячу записей относится к размеру одного запроса, а не к
// объёму хранимого.

const DB_NAME = 'mesera';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Storage {
  static async open() {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(ENTRIES, { keyPath: ['doc', 'idx'] });
      db.createObjectStore(META, { keyPath: 'key' });
    };
    return new Storage(await request(req));
  }

  constructor(db) {
    this._db = db;
  }

  _store(name, mode) {
    return this._db.transaction(name, mode).objectStore(name);
  }

  // --- журналы ------------------------------------------------------------

  async put(entries) {
    if (!entries.length) return;
    const tx = this._db.transaction(ENTRIES, 'readwrite');
    const store = tx.objectStore(ENTRIES);
    for (const e of entries) store.put(e);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Окно записей документа, оканчивающееся указанным номером.
  // Идём курсором с конца, поэтому размер журнала на стоимость не влияет.
  async window(doc, before, limit) {
    // Диапазон ограничен снизу самим документом, сверху — запрошенным номером.
    const range = before > 0
      ? IDBKeyRange.bound([doc, 0], [doc, before], false, true)
      : IDBKeyRange.bound([doc, 0], [doc, []]);
    const out = [];
    const req = this._store(ENTRIES, 'readonly').openCursor(range, 'prev');
    await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve();
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out.reverse();
  }

  // Номер последней записи документа — курсор для HELLO.
  async head(doc) {
    const range = IDBKeyRange.bound([doc, 0], [doc, []]);
    const req = this._store(ENTRIES, 'readonly').openKeyCursor(range, 'prev');
    const key = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ? req.result.key : null);
      req.onerror = () => reject(req.error);
    });
    return key ? key[1] : 0;
  }

  async drop(doc) {
    const tx = this._db.transaction(ENTRIES, 'readwrite');
    tx.objectStore(ENTRIES).delete(IDBKeyRange.bound([doc, 0], [doc, []]));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- служебные записи ---------------------------------------------------

  async meta(key, value) {
    if (value === undefined) {
      const row = await request(this._store(META, 'readonly').get(key));
      return row ? row.value : null;
    }
    await request(this._store(META, 'readwrite').put({ key, value }));
  }
}
