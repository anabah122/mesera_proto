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
    this._onChange();
  }

  async cursors(docs) {
    const out = {};
    for (const doc of docs) out[doc] = await this._storage.head(doc);
    return out;
  }

  addPending(txid, doc, op, payload) {
    this.pending.set(txid, { txid, doc, op, payload, failed: false });
    this._onChange();
  }

  unconfirmed() {
    return [...this.pending.values()];
  }

  markFailed(txid, reason) {
    const item = this.pending.get(txid);
    if (!item) return;
    item.failed = true;
    item.reason = reason;
    this._onChange();
  }

  // Единственный путь записи в committed — запись, вернувшаяся с сервера.
  async commit(entry) {
    this.pending.delete(entry.txid);
    await this._storage.put([entry]);

    // Записи журнала состава меняют список людей, а не ленту сообщений.
    if (entry.doc === DOC_USERS) {
      this._applyUser(entry);
      const head = this.heads.get(DOC_USERS) || 0;
      if (entry.idx > head) this.heads.set(DOC_USERS, entry.idx);
      this._onChange();
      return;
    }

    const head = this.heads.get(entry.doc) || 0;
    if (entry.idx > head) this.heads.set(entry.doc, entry.idx);

    if (entry.doc === this.doc && !this.view.some((e) => e.idx === entry.idx)) {
      this.view.push(entry);
      this.view.sort((a, b) => a.idx - b.idx);
    }
    this._onChange();
  }

  // Догрузка вверх: сначала из локальной базы, и только если там пусто —
  // запрос уходит на сервер.
  async older(limit = WINDOW) {
    const oldest = this.view.length ? this.view[0].idx : 0;
    if (oldest <= 1) return 0;
    const older = await this._storage.window(this.doc, oldest, limit);
    if (older.length) {
      this.view = older.concat(this.view);
      this._onChange();
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
    this._onChange();
  }
}
