// Состояние клиента.
//
//   committed — серверная правда, лежит в IndexedDB. Ключ [doc, idx].
//               Пишется только из ACK и EVT.
//   pending   — неподтверждённое, живёт в памяти. Ключ txid, номера нет.
//
// В памяти держится окно текущего документа; всё остальное остаётся в базе
// и поднимается диапазонным запросом при прокрутке вверх.

export const WINDOW = 1000;

// Журнал состава системы. Имя совпадает с backend/dialogs.py.
export const DOC_USERS = 'users';

export class Store {
  constructor(storage, onChange) {
    this._storage = storage;
    this._onChange = onChange;
    this.doc = null;
    this.view = [];              // окно committed текущего документа
    this.pending = new Map();    // txid -> транзакция
    this.heads = new Map();      // doc -> номер последней известной записи
    this.users = new Map();      // id -> пользователь, собран из журнала состава
    this.lastTs = 0;             // время последнего общего действия
    this._muted = 0;             // глубина пакетной вставки
    this._missed = false;        // менялось ли что-то, пока молчали
  }

  /** Копит изменения и перерисовывает один раз в конце.
   *
   * Досыл после разрыва приходит поштучно: без этого каждая из сотен
   * записей перекладывала бы весь экран.
   */
  async batch(fn) {
    this._muted++;
    try {
      await fn();
    } finally {
      this._muted--;
      if (!this._muted && this._unsorted) {
        this._unsorted = false;
        this.view.sort((a, b) => a.idx - b.idx);
      }
      if (!this._muted && this._missed) {
        this._missed = false;
        this._onChange();
      }
    }
  }

  _changed() {
    if (this._muted) {
      this._missed = true;
      return;
    }
    this._onChange();
  }

  // Журнал состава разбирается в список людей. Пересборка идемпотентна:
  // повторно пришедшая запись ничего не ломает.
  async loadUsers() {
    for (const e of await this._storage.window(DOC_USERS, 0, WINDOW)) {
      this._applyUser(e);
    }
  }

  _applyUser(entry) {
    if (entry.op === 'user.add') this.users.set(entry.payload.id, entry.payload);
    else if (entry.op === 'user.remove') this.users.delete(entry.payload.id);
    if (entry.ts > this.lastTs) this.lastTs = entry.ts;
  }

  userList() {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async openDoc(doc) {
    this.doc = doc;
    this.view = await this._storage.window(doc, 0, WINDOW);
    // Курсор поднимаем из локальной базы: heartbeat должен сверять реальный
    // номер, а не ноль, иначе сервер дошлёт уже имеющееся.
    const head = await this._storage.head(doc);
    if (head > (this.heads.get(doc) || 0)) this.heads.set(doc, head);
    this._changed();
  }

  async cursors(docs) {
    const out = {};
    for (const doc of docs) out[doc] = await this._storage.head(doc);
    return out;
  }

  addPending(txid, doc, op, payload) {
    this.pending.set(txid, { txid, doc, op, payload, failed: false });
    this._changed();
  }

  unconfirmed() {
    return [...this.pending.values()];
  }

  markFailed(txid, reason) {
    const item = this.pending.get(txid);
    if (!item) return;
    item.failed = true;
    item.reason = reason;
    this._changed();
  }

  // Единственный путь записи в committed — запись, вернувшаяся с сервера.
  async commit(entry) {
    this.pending.delete(entry.txid);
    try {
      await this._storage.put([entry]);
    } catch (e) {
      // Локальная копия — ускорение, а не единственный источник: на
      // телефоне квота невелика, но переписку показать всё равно надо.
      // Пропущенное доберётся с сервера при следующем подключении.
      console.warn('запись в локальное хранилище не удалась:', e?.message);
    }

    // Записи журнала состава меняют список людей, а не ленту сообщений.
    if (entry.doc === DOC_USERS) {
      this._applyUser(entry);
      const head = this.heads.get(DOC_USERS) || 0;
      if (entry.idx > head) this.heads.set(DOC_USERS, entry.idx);
      this._changed();
      return;
    }

    const head = this.heads.get(entry.doc) || 0;
    if (entry.idx > head) this.heads.set(entry.doc, entry.idx);

    if (entry.doc === this.doc && !this.view.some((e) => e.idx === entry.idx)) {
      this.view.push(entry);
      // В пакете сортируем один раз в конце: досыл идёт по возрастанию,
      // и пересортировывать растущий массив на каждой записи незачем.
      if (this._muted) this._unsorted = true;
      else this.view.sort((a, b) => a.idx - b.idx);
    }
    this._changed();
  }

  // Догрузка вверх: сначала из локальной базы, и только если там пусто —
  // запрос уходит на сервер.
  async older(limit = WINDOW) {
    const oldest = this.view.length ? this.view[0].idx : 0;
    if (oldest <= 1) return 0;
    const older = await this._storage.window(this.doc, oldest, limit);
    if (older.length) {
      this.view = older.concat(this.view);
      this._changed();
    }
    return older.length;
  }

  oldestIdx() {
    return this.view.length ? this.view[0].idx : 0;
  }

  async reset(doc) {
    await this._storage.drop(doc);
    if (doc === this.doc) this.view = [];
    this.heads.set(doc, 0);
    this._changed();
  }
}
