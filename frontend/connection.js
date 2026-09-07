// Транспорт: сокет, вход в сессию, проверка живости, переподключение.
// О содержимом транзакций не знает — только доставляет кадры.

import { DOC_USERS, WINDOW } from './store.js?v=25';
import { T, txid } from './protocol.js?v=25';

const PING_INTERVAL = 30000;
// Не чаще раза в две секунды: прокрутка длинной истории иначе рождает
// транзакцию на каждое движение.
const READ_INTERVAL = 2000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15000;

export class Connection {
  constructor({ token, store, docs, onReady, onStatus, onFatal, onPresence }) {
    this._token = token;
    this._store = store;
    this._docs = docs;          // () => список документов, чьи курсоры шлём
    this._onReady = onReady;
    this._onStatus = onStatus;
    this._onFatal = onFatal;    // сессия отвергнута — переподключаться незачем
    this._onPresence = onPresence;
    this._openDoc = null;       // документ, открытый на экране
    this._dead = false;
    this._ws = null;
    this._backoff = BACKOFF_MIN;
    this._pingTimer = null;
    this._readSent = new Map();  // doc -> докуда просили отметить
    this._readDone = new Map();  // doc -> докуда отметка уже ушла
    this._readTimer = null;
  }

  open() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._ws = new WebSocket(`${scheme}//${location.host}/ws`);
    this._ws.onopen = () => this._onOpen();
    this._ws.onmessage = (e) => this._onFrame(JSON.parse(e.data));
    this._ws.onclose = () => this._onClose();
    this._ws.onerror = () => this._ws.close();
  }

  send(doc, op, payload) {
    const id = txid();
    this._store.addPending(id, doc, op, payload);
    this._push({ t: T.TX, txid: id, doc, op, payload });
  }

  /** Отмечает диалог прочитанным до указанного номера.
   *
   * Отметка идёт не чаще раза в READ_INTERVAL: при прокрутке длинной
   * истории каждое движение давало бы свою транзакцию. Последний номер
   * не теряется — он уходит отложенной отправкой, когда пауза истечёт.
   */
  markRead(doc, upto) {
    if (!doc || !upto) return;
    // Назад курсор не двигаем и уже отмеченное не повторяем.
    if (upto <= (this._readSent.get(doc) || 0)) return;
    this._readSent.set(doc, upto);

    if (this._readTimer) return;
    this._flushRead();
    // Пауза держится, даже если отмечать больше нечего: иначе первая же
    // отметка после неё ушла бы без задержки, и троттлинг не работал бы.
    this._readTimer = setTimeout(() => {
      this._readTimer = null;
      this._flushRead();
    }, READ_INTERVAL);
  }

  _flushRead() {
    for (const [doc, upto] of this._readSent) {
      if (upto <= (this._readDone.get(doc) || 0)) continue;
      this._readDone.set(doc, upto);
      this.send(doc, 'msg.read', { upto });
    }
  }

  // Догрузка истории с сервера — когда в локальной базе больше ничего нет.
  fetchOlder(doc, before, limit) {
    // Ответ придёт одной пачкой EVTS — она же и закроет пакет.
    this._openBatch();
    this._push({ t: T.FETCH, doc, before, limit });
  }

  _push(frame) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
    }
  }

  async _onOpen() {
    this._backoff = BACKOFF_MIN;
    this._onStatus('online');
    this._push({
      t: T.HELLO,
      token: this._token,
      cursors: await this._store.cursors(this._docs()),
    });
    // Досыл после HELLO идёт по документам, кадр на документ; экран трогаем
    // один раз, когда придёт SYNCED — он и есть конец досыла.
    this._syncing = true;
    this._openBatch();
    this._pingTimer = setInterval(() => this._ping(), PING_INTERVAL);
  }

  async _onFrame(f) {
    switch (f.t) {
      case T.READY:
        this._onReady(f.me, f.users, f.online || []);
        break;

      case T.PRESENCE:
        this._onPresence?.(f.id, f.online, f.last_seen);
        break;

      case T.EVT:
        // Живое сообщение: пришло прямо сейчас, рисуем сразу.
        await this._store.commit(f);
        break;

      case T.EVTS:
        // Досыл истории. Пачка целиком лежит в одном кадре, поэтому её
        // границы известны — экран трогаем один раз, когда она разобрана.
        await this._store.commitAll(f.entries);
        // FETCH завершается самой пачкой: ждать SYNCED тут нечего, он
        // приходит только после HELLO.
        if (!this._syncing) this._closeBatch();
        break;

      case T.ACK: {
        // Подтверждение несёт только номер — тело берём из своей очереди.
        const item = this._store.pending.get(f.txid);
        if (item) {
          await this._store.commit({
            doc: f.doc, idx: f.idx, txid: f.txid,
            op: item.op, payload: item.payload,
            author: this._author, ts: Date.now(),
          });
        }
        break;
      }

      case T.NACK:
        // Фатальный отказ относится не к транзакции, а к самой сессии:
        // токен недействителен, дальше подключаться нечем.
        if (f.fatal) {
          this._dead = true;
          this._onFatal?.(f.reason);
        } else {
          this._store.markFailed(f.txid, f.reason);
        }
        break;

      case T.RESET:
        // Разрыв больше окна досыла — журнал документа пересобирается.
        // Сразу забираем хвост, иначе документ остался бы пустым на экране.
        await this._store.reset(f.doc);
        this._push({ t: T.FETCH, doc: f.doc, before: 0, limit: WINDOW });
        break;

      case T.SYNCED:
        this._syncing = false;
        this._closeBatch();
        // Отметка, отправленная в оборванный сокет, могла не доехать:
        // считаем её неотправленной и досылаем вместе с остальным.
        this._readDone.clear();
        this._flushRead();
        // Досыл окончен: только теперь повторяем неподтверждённое, иначе
        // новая транзакция получила бы номер раньше, чем клиент дочитал старое.
        for (const item of this._store.unconfirmed()) {
          this._push({ t: T.TX, txid: item.txid, doc: item.doc, op: item.op, payload: item.payload });
        }
        break;
    }
  }

  setAuthor(id) {
    this._author = id;
    // Store отличает своё от чужого по этому же идентификатору:
    // непрочитанное считается только по сообщениям собеседника.
    this._store.me = id;
  }

  // Пакет держится обещанием: store перерисует экран, когда мы его закроем.
  _openBatch() {
    if (this._endBatch) return;
    this._store.batch(() => new Promise((done) => { this._endBatch = done; }));
  }

  _closeBatch() {
    this._endBatch?.();
    this._endBatch = null;
  }

  // Какой диалог открыт — по нему сверяется idx в heartbeat.
  setOpenDoc(doc) {
    this._openDoc = doc;
  }

  // Heartbeat несёт курсоры: idx открытого диалога и ts общих действий.
  // Сервер досылает всё, чего у нас нет, не дожидаясь переподключения.
  _ping() {
    this._push({
      t: T.PING,
      doc: this._openDoc || '',
      idx: this._openDoc ? (this._store.heads.get(this._openDoc) || 0) : 0,
      users_idx: this._store.heads.get(DOC_USERS) || 0,
      ts: this._store.lastTs || 0,
      // Открытая в фоне вкладка — ещё не присутствие: человек может
      // не возвращаться к ней сутками.
      active: !document.hidden,
    });
  }

  close() {
    this._dead = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._readTimer);
    this._ws?.close();
  }

  /** Закрывает соединение навсегда: переподключения не будет. */
  stop() {
    this._stopped = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._readTimer);
    this._ws?.close();
  }

  _onClose() {
    clearInterval(this._pingTimer);
    // Иначе оборванный досыл запер бы перерисовку до конца сеанса.
    this._closeBatch();
    this._onStatus('offline');
    // Остановлено намеренно — не воскрешаем.
    if (this._stopped) return;
    if (this._dead) return;
    const wait = this._backoff + Math.random() * 300;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);
    setTimeout(() => this.open(), wait);
  }
}
