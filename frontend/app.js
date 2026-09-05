// Сборка: сессия, локальное хранилище, соединение, отрисовка.

import { Connection } from './connection.js';
import { dialogId } from './protocol.js';
import { Session } from './session.js';
import { Storage } from './storage.js';
import { Store, WINDOW } from './store.js';

const $ = (id) => document.getElementById(id);

const gate = $('gate'), app = $('app');
const logEl = $('log'), peopleEl = $('people'), chatHead = $('chatHead');
const composer = $('composer'), input = $('input'), statusEl = $('status');

let storage, store, conn;
let me = null;
let people = [];
let peerId = null;
let loadingOlder = false;

// --- вход --------------------------------------------------------------

let mode = 'login';

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('name').hidden = mode === 'login';
    $('name').required = mode === 'register';
    $('auth').querySelector('.primary').textContent = mode === 'login' ? 'Войти' : 'Создать';
    $('authError').hidden = true;
  };
});

$('auth').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('authError');
  err.hidden = true;
  try {
    const res = mode === 'login'
      ? await Session.login($('login').value, $('password').value)
      : await Session.register($('login').value, $('password').value, $('name').value);
    Session.save(res);
    await start(res);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
};

$('logout').onclick = () => {
  Session.clear();
  location.reload();
};

// --- запуск ------------------------------------------------------------

async function start(session) {
  gate.hidden = true;
  app.hidden = false;

  storage = await Storage.open();
  store = new Store(storage, render);

  conn = new Connection({
    token: session.token,
    store,
    // Курсоры отправляются по всем диалогам, известным локально.
    docs: () => knownDocs(),
    onReady: onReady,
    onStatus: (s) => { statusEl.textContent = s; statusEl.className = 'status ' + s; },
  });
  conn.setAuthor(session.me.id);
  conn.open();
}

function knownDocs() {
  // До первого READY список людей неизвестен — курсоров нет, сервер пришлёт
  // состав системы, и следующее подключение уже отправит полную карту.
  return people.filter((u) => u.id !== me?.id).map((u) => dialogId(me.id, u.id));
}

async function onReady(user, users) {
  me = user;
  people = users;
  $('myName').textContent = me.name;
  conn.setAuthor(me.id);
  renderPeople();
  if (peerId) await openDialog(peerId);
}

// --- диалоги -----------------------------------------------------------

async function openDialog(id) {
  peerId = id;
  const doc = dialogId(me.id, peerId);
  chatHead.textContent = people.find((u) => u.id === peerId)?.name || peerId;
  composer.hidden = false;
  renderPeople();

  await store.openDoc(doc);
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

const saved = Session.load();
if (saved) start(saved);
else gate.hidden = false;
