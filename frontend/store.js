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

// Операции, которые человек видит как сообщение. Служебные записи —
// вроде отметки о прочтении — сообщениями не считаются: иначе чужая
// квитанция выглядела бы как новое непрочитанное.
const MESSAGE_OPS = new Set(['msg.send', 'msg.image']);

export function isMessage(entry) {
  return MESSAGE_OPS.has(entry.op);
}

export class Store {
  constructor(storage, onChange, onIncoming = null) {
    this._storage = storage;
    this._onChange = onChange;
    // Зовётся на живое чужое сообщение — не на досыл истории: пачка
    // после разрыва иначе дала бы очередь сигналов.
    this._onIncoming = onIncoming;
    this.doc = null;
    this.view = [];              // окно committed текущего документа
    this.pending = new Map();    // txid -> транзакция
    this.heads = new Map();      // doc -> номер последней известной записи
    this.users = new Map();      // id -> пользователь, собран из журнала состава
    this.lastTs = 0;             // время последнего общего действия
    this.me = null;              // кто мы: без этого не отличить своё от чужого

    // Учёт прочитанного. Держится по всем диалогам сразу, а не только по
    // открытому: бейдж на вкладке — сумма непрочитанного по всем.
    this.lastIncoming = new Map(); // doc -> idx последнего чужого сообщения
    this.readCursor = new Map();   // doc -> докуда дочитали мы
    this.peerRead = new Map();     // doc -> докуда дочитал собеседник

    // Удалённые сообщения: журнал append-only, поэтому запись остаётся,
    // а её номер попадает сюда и скрывается при отрисовке.
    this.deleted = new Set();      // `${doc} ${idx}`

    // Правки: тем же порядком — оригинал остаётся, новый текст ложится
    // поверх при отрисовке.
    this.edits = new Map();        // `${doc} ${idx}` -> { text, idx }

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

  /** Поднимает курсоры прочитанного из локальной базы.
   *
   * Нужно до соединения: иначе после перезагрузки бейдж пуст до тех пор,
   * пока не приедет досыл, хотя всё уже лежит на диске.
   */
  async loadRead(docs) {
    for (const doc of docs) {
      for (const entry of await this._storage.window(doc, 0, WINDOW)) {
        this._applyRead(entry);
      }
    }
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
    await this._persist([entry]);
    const fresh = this._apply(entry);
    // Сигнал только о живом: досыл идёт через commitAll и молчит.
    if (fresh) this._onIncoming?.(entry);
    this._changed();
  }

  /** Пачка записей: досыл истории одним кадром.
   *
   * Запись на диск идёт одной транзакцией на всю пачку, а не по одной на
   * сообщение, и экран перерисовывается один раз в конце.
   */
  async commitAll(entries) {
    if (!entries?.length) return;
    await this.batch(async () => {
      await this._persist(entries);
      for (const entry of entries) this._apply(entry);
      this._changed();
    });
  }

  async _persist(entries) {
    try {
      await this._storage.put(entries);
    } catch (e) {
      // Локальная копия — ускорение, а не единственный источник: на
      // телефоне квота невелика, но переписку показать всё равно надо.
      // Пропущенное доберётся с сервера при следующем подключении.
      console.warn('запись в локальное хранилище не удалась:', e?.message);
    }
  }

  /** Применяет запись к состоянию в памяти. На диск не пишет.
   *
   * Возвращает true, если это новое чужое сообщение — то, о чём стоит
   * оповестить человека.
   */
  _apply(entry) {
    const known = this.pending.has(entry.txid);
    this.pending.delete(entry.txid);

    // Записи журнала состава меняют список людей, а не ленту сообщений.
    if (entry.doc === DOC_USERS) {
      this._applyUser(entry);
      const head = this.heads.get(DOC_USERS) || 0;
      if (entry.idx > head) this.heads.set(DOC_USERS, entry.idx);
      return false;
    }

    const head = this.heads.get(entry.doc) || 0;
    if (entry.idx > head) this.heads.set(entry.doc, entry.idx);

    this._applyRead(entry);

    const seen = entry.doc === this.doc && this.view.some((e) => e.idx === entry.idx);
    if (entry.doc === this.doc && !seen) {
      this.view.push(entry);
      // В пакете сортируем один раз в конце: досыл идёт по возрастанию,
      // и пересортировывать растущий массив на каждой записи незачем.
      if (this._muted) this._unsorted = true;
      else this.view.sort((a, b) => a.idx - b.idx);
    }
    // Своё эхо и повтор уже виденного оповещением не считаются.
    return isMessage(entry) && entry.author !== this.me && !known && !seen;
  }

  // --- прочитанное --------------------------------------------------------

  /** Двигает курсоры по записи диалога.
   *
   * Отметка о прочтении — такая же запись журнала, поэтому курсоры
   * восстанавливаются сами: и после перезагрузки, и в соседней вкладке.
   */
  _applyRead(entry) {
    if (entry.op === 'msg.edit') {
      const target = Number(entry.payload?.target) || 0;
      if (!target) return;
      const key = `${entry.doc} ${target}`;
      // Правок может быть несколько, и приходят они вразнобой:
      // побеждает та, что записана позже.
      const known = this.edits.get(key);
      if (!known || entry.idx > known.idx) {
        this.edits.set(key, { text: entry.payload.text ?? '', idx: entry.idx });
      }
      return;
    }
    if (entry.op === 'msg.delete') {
      const target = Number(entry.payload?.target) || 0;
      if (target) this.deleted.add(`${entry.doc} ${target}`);
      return;
    }
    if (entry.op === 'msg.read') {
      // Курсор только растёт: записи приходят и досылом вразнобой, и
      // откат назад показал бы уже прочитанное как новое.
      const map = entry.author === this.me ? this.readCursor : this.peerRead;
      const upto = Number(entry.payload?.upto) || 0;
      if (upto > (map.get(entry.doc) || 0)) map.set(entry.doc, upto);
      return;
    }
    // Непрочитанное считаем по чужим сообщениям: свои читать незачем,
    // а служебные записи человек вообще не видит.
    if (!isMessage(entry) || entry.author === this.me) return;
    if (entry.idx > (this.lastIncoming.get(entry.doc) || 0)) {
      this.lastIncoming.set(entry.doc, entry.idx);
    }
  }

  /** Сколько чужих сообщений в диалоге пришло после нашего курсора. */
  unreadIn(doc) {
    const last = this.lastIncoming.get(doc) || 0;
    const read = this.readCursor.get(doc) || 0;
    if (last <= read) return 0;
    // Точное число знаем только по записям, лежащим в памяти. Для
    // открытого диалога это окно, для остальных — то, что пришло за сеанс.
    return this._countIncomingAfter(doc, read);
  }

  _countIncomingAfter(doc, after) {
    if (doc === this.doc) {
      return this.view.filter(
        (e) => e.idx > after && isMessage(e) && e.author !== this.me
               && !this.isDeleted(doc, e.idx)).length;
    }
    // Диалог не открыт — его записей в памяти нет. Считаем по разнице
    // номеров: она завышает счёт на служебные записи, но показать
    // «есть непрочитанное» важнее, чем показать точный ноль.
    return (this.lastIncoming.get(doc) || 0) - after;
  }

  /** Непрочитанное по всем диалогам — число для бейджа на вкладке. */
  unreadTotal() {
    let total = 0;
    for (const doc of this.lastIncoming.keys()) total += this.unreadIn(doc);
    return total;
  }

  isDeleted(doc, idx) {
    return this.deleted.has(`${doc} ${idx}`);
  }

  /** Текст сообщения с учётом правок. */
  textOf(entry) {
    return this.edits.get(`${entry.doc} ${entry.idx}`)?.text ?? entry.payload.text ?? '';
  }

  isEdited(entry) {
    return this.edits.has(`${entry.doc} ${entry.idx}`);
  }

  /** Докуда дочитал собеседник: по этому номеру рисуется галочка. */
  peerReadIdx(doc) {
    return this.peerRead.get(doc) || 0;
  }

  /** Номер, до которого есть что отмечать прочитанным. */
  unreadUpto(doc) {
    return this.lastIncoming.get(doc) || 0;
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
