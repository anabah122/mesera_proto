// Страница чата: локальное хранилище, соединение, отрисовка.
// Авторизации здесь нет — без токена сразу уходим на страницу входа.

import { Connection } from './connection.js?v=5';
import { dialogId } from './protocol.js?v=5';
import { Session } from './session.js?v=5';
import { Storage } from './storage.js?v=5';
import { DOC_USERS, Store, WINDOW } from './store.js?v=5';

const $ = (id) => document.getElementById(id);

const app = $('app');
const logEl = $('log'), peopleEl = $('people'), chatHead = $('chatHead');
const composer = $('composer'), input = $('input'), statusEl = $('status');

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

  store = new Store(storage, render);

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
  conn.send(dialogId(me.id, peerId), 'msg.send', { text });
  input.value = '';
};

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

function bubble(text, meta, cls) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = '<div class="meta"></div>';
  el.firstChild.textContent = meta;
  el.append(text);
  return el;
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
      bubble(e.payload.text, '#' + e.idx, e.author === me.id ? 'own' : '')
    ),
    // Неподтверждённое — ниже, номера у него ещё нет.
    ...store.unconfirmed()
      .filter((i) => i.doc === store.doc)
      .map((i) =>
        bubble(i.payload.text, i.failed ? 'не отправлено: ' + i.reason : 'отправка…',
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
