// Страница чата: локальное хранилище, соединение, отрисовка.
// Авторизации здесь нет — без токена сразу уходим на страницу входа.

import { Connection } from './connection.js?v=9';
import { EmojiPad } from './emoji.js?v=9';
import { prepare, upload } from './image.js?v=9';
import { dialogId } from './protocol.js?v=9';
import { Session } from './session.js?v=9';
import { Storage } from './storage.js?v=9';
import { DOC_USERS, Store, WINDOW } from './store.js?v=9';

const $ = (id) => document.getElementById(id);

const app = $('app');
const logEl = $('log'), peopleEl = $('people'), chatHead = $('chatHead');
const composer = $('composer'), input = $('input'), statusEl = $('status');
const viewer = $('viewer'), viewerImg = $('viewerImg');
const replyBar = $('replyBar'), emojiPad = $('emojiPad');

// На какое сообщение отвечаем. Сбрасывается после отправки и при смене диалога.
let replyTo = null;

let storage, store, conn;
let me = null;
let people = [];
let peerId = null;
let loadingOlder = false;

// --- сессия -----------------------------------------------------------

const session = Session.load();
// Страница чата без токена не работает — отправляем на вход.
if (!session) location.replace('/');

$('logout').onclick = () => {
  Session.clear();
  location.replace('/');
};

function toGate(reason) {
  Session.clear();
  if (reason) sessionStorage.setItem('mesera.authError', reason);
  location.replace('/');
}

// --- запуск ------------------------------------------------------------

async function start(session) {
  // Журналы этого пользователя, а не браузера: в соседней вкладке может
  // работать другой человек, его база отдельная.
  storage = await Storage.open(session.me.id);

  // Перерисовка идёт через onStoreChange: он обновляет и список людей,
  // и ленту — одного render мало, сайдбар остался бы прежним.
  store = new Store(storage, onStoreChange);
  // Состав, известный с прошлого сеанса: список людей есть до соединения.
  await store.loadUsers();

  conn = new Connection({
    token: session.token,
    store,
    // Курсоры отправляются по всем диалогам, известным локально.
    docs: () => knownDocs(),
    onReady: onReady,
    onStatus: (s) => { statusEl.textContent = s; statusEl.className = 'status ' + s; },
    // Токен протух — возвращаем на вход вместо бесконечных переподключений.
    onFatal: (reason) => toGate(reason),
  });
  conn.setAuthor(session.me.id);
  conn.open();
}

function knownDocs() {
  // Журнал состава — всегда: из него строится список людей.
  const docs = [DOC_USERS];
  if (me) {
    for (const u of people) if (u.id !== me.id) docs.push(dialogId(me.id, u.id));
  }
  return docs;
}

async function onReady(user, users) {
  me = user;
  $('myName').textContent = me.name;
  conn.setAuthor(me.id);
  // ready — стартовый снимок. Дальше состав живёт транзакциями журнала,
  // поэтому снимок кладём в тот же контейнер, что и они.
  for (const u of users) if (!store.users.has(u.id)) store.users.set(u.id, u);
  refreshPeople();
  if (peerId) await openDialog(peerId);
}

// Единственный источник списка людей — журнал состава.
function refreshPeople() {
  people = store.userList();
  renderPeople();
}

// --- диалоги -----------------------------------------------------------

async function openDialog(id) {
  peerId = id;
  clearReply();
  const doc = dialogId(me.id, peerId);
  chatHead.textContent = people.find((u) => u.id === peerId)?.name || peerId;
  composer.hidden = false;
  renderPeople();

  await store.openDoc(doc);
  conn.setOpenDoc(doc);
  // Стартовое окно: если локально пусто, забираем хвост с сервера.
  if (!store.view.length) conn.fetchOlder(doc, 0, WINDOW);
  input.focus();
}

// Прокрутка к началу истории — сначала локальная база, потом сервер.
logEl.onscroll = async () => {
  if (logEl.scrollTop > 40 || loadingOlder || !store?.doc) return;
  loadingOlder = true;
  const got = await store.older();
  if (!got && store.oldestIdx() > 1) {
    conn.fetchOlder(store.doc, store.oldestIdx(), WINDOW);
  }
  loadingOlder = false;
};

composer.onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !peerId) return;
  conn.send(dialogId(me.id, peerId), 'msg.send', withReply({ text }));
  input.value = '';
  clearReply();
};

// --- ответы ------------------------------------------------------------

// Ответ несёт номер оригинала и его отрывок: показать цитату можно сразу,
// не догружая старое сообщение из глубины журнала.
function withReply(payload) {
  if (!replyTo) return payload;
  return {
    ...payload,
    reply: {
      idx: replyTo.idx,
      author: replyTo.author,
      text: quote(replyTo),
    },
  };
}

function quote(entry) {
  if (entry.op === 'msg.image') return 'Картинка';
  return (entry.payload.text || '').slice(0, 120);
}

function startReply(entry) {
  replyTo = entry;
  replyBar.querySelector('.reply-who').textContent = nameOf(entry.author);
  replyBar.querySelector('.reply-text').textContent = quote(entry);
  replyBar.hidden = false;
  input.focus();
}

function clearReply() {
  replyTo = null;
  replyBar.hidden = true;
}

$('replyCancel').onclick = clearReply;

function nameOf(id) {
  if (id === me?.id) return 'Вы';
  return store.users.get(id)?.name || id;
}

// --- просмотр картинки -------------------------------------------------

function openViewer(src) {
  viewerImg.src = src;
  viewer.hidden = false;
}

function closeViewer() {
  viewer.hidden = true;
  // Освобождаем картинку: незачем держать её в памяти закрытой.
  viewerImg.removeAttribute('src');
}

// Клик в любом месте закрывает — как по фону, так и по самой картинке.
viewer.onclick = closeViewer;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!viewer.hidden) closeViewer();
    else if (!pad.hidden) pad.close();
    else if (replyTo) clearReply();
  }
});

// --- эмодзи ------------------------------------------------------------

const pad = new EmojiPad(emojiPad, insert);

$('emoji').onclick = (e) => {
  e.stopPropagation();
  pad.toggle();
};

// Клик мимо палитры закрывает её.
document.addEventListener('click', (e) => {
  if (!pad.hidden && !pad.contains(e.target) && e.target !== $('emoji')) pad.close();
});

// Вставка идёт в позицию курсора, а не в конец строки.
function insert(ch) {
  const at = input.selectionStart ?? input.value.length;
  const to = input.selectionEnd ?? at;
  input.value = input.value.slice(0, at) + ch + input.value.slice(to);
  input.focus();
  input.selectionStart = input.selectionEnd = at + ch.length;
}

// --- отрисовка ---------------------------------------------------------

function renderPeople() {
  peopleEl.replaceChildren(
    ...people
      .filter((u) => u.id !== me.id)
      .map((u) => {
        const el = document.createElement('button');
        el.className = 'person' + (u.id === peerId ? ' active' : '');
        el.innerHTML = '<span class="who"></span><span class="hint"></span>';
        el.children[0].textContent = u.name;
        el.children[1].textContent = '@' + u.login;
        el.onclick = () => openDialog(u.id);
        return el;
      })
  );
}

// Время отправки берётся из самой транзакции: ts проставляет сервер
// в момент записи, поэтому у всех участников он одинаковый.
function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function bubble(entry, meta, cls) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;

  // Цитата над телом: отрывок пришёл вместе с ответом, догружать нечего.
  const reply = entry.payload.reply;
  if (reply) {
    const q = document.createElement('div');
    q.className = 'quote';
    q.innerHTML = '<div class="quote-who"></div><div class="quote-text"></div>';
    q.children[0].textContent = nameOf(reply.author);
    q.children[1].textContent = reply.text;
    // Клик по цитате прокручивает к оригиналу, если он в окне.
    q.onclick = () => scrollTo(reply.idx);
    el.append(q);
  }

  if (entry.op === 'msg.image') {
    const img = document.createElement('img');
    img.className = 'shot';
    img.loading = 'lazy';
    img.src = '/api/file/' + entry.payload.file;
    img.onclick = () => openViewer(img.src);
    el.append(img);
  } else {
    el.append(document.createTextNode(entry.payload.text ?? ''));
  }

  // Подпись снизу: время у отправленного, состояние у неподтверждённого.
  const foot = document.createElement('div');
  foot.className = 'meta';
  foot.textContent = meta;
  el.append(foot);

  // Ответить можно только на записанное: у неподтверждённого нет номера.
  if (entry.idx) {
    el.dataset.idx = entry.idx;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reply-btn';
    btn.title = 'Ответить';
    btn.textContent = '↩';
    btn.onclick = () => startReply(entry);
    el.append(btn);
  }
  return el;
}

// Прокрутка к оригиналу с короткой подсветкой.
function scrollTo(idx) {
  const target = logEl.querySelector(`[data-idx="${idx}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 900);
}

// Изменение store перерисовывает и список людей, и ленту: новый участник
// должен появляться в сайдбаре сам, без перезагрузки.
function onStoreChange() {
  if (me) refreshPeople();
  render();
}

function render() {
  if (!me || !store?.doc) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  const before = logEl.scrollHeight;

  logEl.replaceChildren(
    // Подтверждённое — в порядке номеров, назначенных сервером.
    ...store.view.map((e) =>
      bubble(e, clock(e.ts), e.author === me.id ? 'own' : '')
    ),
    // Неподтверждённое — ниже, номера у него ещё нет.
    ...store.unconfirmed()
      .filter((i) => i.doc === store.doc)
      .map((i) =>
        bubble(i, i.failed ? 'не отправлено: ' + i.reason : 'отправка…',
               'own ' + (i.failed ? 'failed' : 'pending'))
      )
  );

  // При догрузке вверх удерживаем позицию, иначе прижимаемся к низу.
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  else if (logEl.scrollHeight > before) logEl.scrollTop += logEl.scrollHeight - before;
}

// --- старт -------------------------------------------------------------

if (session) {
  // Промис обязателен к обработке: молча упавший старт оставил бы
  // пустой экран без единого сообщения.
  start(session).catch((e) => toGate(e.message));
}
