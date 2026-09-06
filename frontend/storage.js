// Локальное хранилище журналов на IndexedDB.
//
// Ключ записи — [doc, idx]. Такой составной ключ даёт диапазонные запросы
// внутри документа: и досыл вперёд, и окно истории вверх — обход курсором,
// без чтения всего журнала.
//
// Журнал копится целиком: единожды загруженное больше не запрашивается.
// Ограничение в тысячу записей относится к размеру одного запроса, а не к
// объёму хранимого.

// База своя на пользователя: в одном браузере могут работать разные люди,
// и их журналы не должны попадать в одно хранилище.
const DB_PREFIX = 'mesera';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Сколько ждём открытия базы. Мобильные браузеры в приватном режиме
// и при нехватке места умеют не отвечать вовсе — без предела приложение
// повисло бы на пустом экране навсегда.
const OPEN_TIMEOUT = 8000;

export class Storage {
  static async open(userId) {
    if (!userId) throw new Error('хранилище требует идентификатор пользователя');
    if (!globalThis.indexedDB) throw new Error('браузер не поддерживает локальное хранилище');

    const req = indexedDB.open(`${DB_PREFIX}:${userId}`, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(ENTRIES, { keyPath: ['doc', 'idx'] });
      db.createObjectStore(META, { keyPath: 'key' });
    };

    const db = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('локальное хранилище не отвечает')), OPEN_TIMEOUT);
      const done = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
      req.onsuccess = done(() => resolve(req.result));
      req.onerror = done(() => reject(req.error || new Error('хранилище недоступно')));
      // Другая вкладка держит базу открытой на старой версии.
      req.onblocked = done(() => reject(new Error('база открыта в другой вкладке')));
    });

    return new Storage(db);
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
      // Место кончилось — на мобильных квота невелика. Это не повод
      // ронять сеанс: журнал доберётся с сервера.
      tx.onabort = () => reject(tx.error || new Error('нет места в хранилище'));
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

  /** Стирает всё локальное: журналы, служебные записи, саму базу. */
  static async wipe(userId) {
    const name = `${DB_PREFIX}:${userId}`;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      // Удаление ждёт закрытия всех соединений: если другая вкладка держит
      // базу открытой, запрос повиснет молча.
      req.onblocked = () => reject(new Error('база открыта в другой вкладке'));
    });
  }

  close() {
    this._db.close();
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
