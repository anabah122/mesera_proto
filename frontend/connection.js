// Транспорт: сокет, вход в сессию, проверка живости, переподключение.
// О содержимом транзакций не знает — только доставляет кадры.

import { DOC_USERS, WINDOW } from './store.js?v=11';
import { T, txid } from './protocol.js?v=11';

const PING_INTERVAL = 30000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15000;

export class Connection {
  constructor({ token, store, docs, onReady, onStatus, onFatal }) {
    this._token = token;
    this._store = store;
    this._docs = docs;          // () => список документов, чьи курсоры шлём
    this._onReady = onReady;
    this._onStatus = onStatus;
    this._onFatal = onFatal;    // сессия отвергнута — переподключаться незачем
    this._openDoc = null;       // документ, открытый на экране
    this._dead = false;
    this._ws = null;
    this._backoff = BACKOFF_MIN;
    this._pingTimer = null;
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

  // Догрузка истории с сервера — когда в локальной базе больше ничего нет.
  fetchOlder(doc, before, limit) {
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
    this._pingTimer = setInterval(() => this._ping(), PING_INTERVAL);
  }

  async _onFrame(f) {
    switch (f.t) {
      case T.READY:
        this._onReady(f.me, f.users);
        break;

      case T.EVT:
        await this._store.commit(f);
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
    });
  }

  close() {
    this._dead = true;
    clearInterval(this._pingTimer);
    this._ws?.close();
  }

  _onClose() {
    clearInterval(this._pingTimer);
    this._onStatus('offline');
    if (this._dead) return;
    const wait = this._backoff + Math.random() * 300;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);
    setTimeout(() => this.open(), wait);
  }
}
