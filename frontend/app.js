// Страница чата: локальное хранилище, соединение, отрисовка.
// Авторизации здесь нет — без токена сразу уходим на страницу входа.

// Первым: перехват сбоев палитры должен встать до её импорта.
import './guard.js?v=28';
import { Connection } from './connection.js?v=28';
import './vendor/picker.js?v=28';
import { prepare, upload } from './image.js?v=28';
import { dialogId } from './protocol.js?v=28';
import { Session } from './session.js?v=28';
import { Storage } from './storage.js?v=28';
import { DOC_USERS, isMessage, Store, WINDOW } from './store.js?v=28';
import { Badge } from './badge.js?v=28';
import { Sound } from './sound.js?v=28';
import { linkify } from './linkify.js?v=28';
import { Presence, presenceLabel } from './presence.js?v=28';

// Сколько сообщений держим в DOM. Окно в памяти больше, но рисовать его
// целиком нельзя: на телефоне тысячи узлов кладут вкладку.
const RENDER_LIMIT = 200;

// Сколько записей добавлено сверх лимита кнопкой «показать ещё».
// Сбрасывается при смене диалога: новый диалог начинается с хвоста.
let shownExtra = 0;

const $ = (id) => document.getElementById(id);

const app = $('app');
const logEl = $('log'), peopleEl = $('people'), chatHead = $('chatHead');
const composer = $('composer'), input = $('input'), statusEl = $('status');
const viewer = $('viewer'), viewerImg = $('viewerImg');
const replyBar = $('replyBar'), emojiPad = $('emojiPad');

// На какое сообщение отвечаем. Сбрасывается после отправки и при смене диалога.
let replyTo = null;

// Какое сообщение правим. Отправка уходит правкой, а не новым сообщением.
let editing = null;

const badge = new Badge();
const sound = new Sound();
const presence = new Presence(() => onPresenceChange());

let storage, store, conn;
let me = null;
let people = [];
let peerId = null;
let loadingOlder = false;

// --- сессия -----------------------------------------------------------

const session = Session.load();
// Страница чата без токена не работает — отправляем на вход.
if (!session) location.replace('/');

// --- меню действий -----------------------------------------------------

const menu = $('menu');

$('menuBtn').onclick = (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
};

document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});

$('logout').onclick = () => {
  Session.clear();
  location.replace('/');
};

$('wipe').onclick = async () => {
  menu.hidden = true;
  if (!confirm('Удалить локальные данные? История заново загрузится с сервера.')) return;
  try {
    // Соединение с базой закрываем сами: пока оно живо, удаление повиснет.
    conn?.stop();
    storage?.close();
    await Storage.wipe(session.me.id);
    location.reload();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'status failed';
  }
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
  store = new Store(storage, onStoreChange, onIncoming);
  store.me = session.me.id;
  // Состав, известный с прошлого сеанса: список людей есть до соединения.
  await store.loadUsers();
  // Курсоры прочитанного с прошлого сеанса: бейдж честен сразу после
  // перезагрузки, не дожидаясь досыла.
  await store.loadRead(knownDocs());
  refreshBadge();

  conn = new Connection({
    token: session.token,
    store,
    // Курсоры отправляются по всем диалогам, известным локально.
    docs: () => knownDocs(),
    onReady: onReady,
    onStatus: (s) => {
      statusEl.textContent = s;
      statusEl.className = 'status ' + s;
      // Оборвалась связь — про чужое присутствие мы больше ничего не знаем.
      if (s === 'offline') presence.clear();
    },
    onPresence: (id, online, lastSeen) => presence.set(id, online, lastSeen),
    // Токен протух — возвращаем на вход вместо бесконечных переподключений.
    onFatal: (reason) => toGate(reason),
  });
  conn.setAuthor(session.me.id);
  conn.open();
}

function knownDocs() {
  // Кто мы — берём из сессии, а не из me: HELLO собирается до прихода
  // READY, и на первом подключении me ещё пуст. Пока здесь стояло me,
  // курсоры по диалогам не отправлялись вовсе, и сервер каждый раз
  // досылал переписку с нуля.
  const myId = session?.me?.id;
  // Журнал состава — всегда: из него строится список людей.
  const docs = [DOC_USERS];
  if (!myId) return docs;

  // Собеседники известны из журнала состава, поднятого из локальной базы
  // ещё до соединения, поэтому список полон уже на первом HELLO.
  for (const u of store.userList()) {
    if (u.id !== myId) docs.push(dialogId(myId, u.id));
  }
  return docs;
}

async function onReady(user, users, online) {
  me = user;
  // Снимок присутствия на момент подключения: дальше его правят кадры.
  presence.reset(online);
  $('myName').textContent = me.name;
  conn.setAuthor(me.id);
  // ready — стартовый снимок. Дальше состав живёт транзакциями журнала,
  // поэтому снимок кладём в тот же контейнер, что и они.
  for (const u of users) {
    if (!store.users.has(u.id)) store.users.set(u.id, u);
    // Только запоминаем время визита: кто в сети — сказал снимок в READY,
    // и трогать присутствие здесь нельзя.
    presence.seen(u.id, u.last_seen);
  }
  refreshPeople();
  if (peerId) await openDialog(peerId);
}

// Шапка диалога: имя собеседника и его присутствие. Рисуется отдельно —
// присутствие меняется, пока диалог открыт.
function renderHead() {
  if (!peerId) return;
  const name = people.find((u) => u.id === peerId)?.name || peerId;
  const online = presence.isOnline(peerId);

  const state = document.createElement('span');
  state.className = 'peer-state' + (online ? ' online' : '');
  state.textContent = presenceLabel(online, presence.lastSeen(peerId));

  chatHead.replaceChildren(backButton(), document.createTextNode(name), state);
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
  clearEdit();
  shownExtra = 0;
  // На узком экране показывается что-то одно: список или переписка.
  app.classList.add('at-dialog');
  const doc = dialogId(me.id, peerId);
  renderHead();
  composer.hidden = false;
  renderPeople();

  await store.openDoc(doc);
  conn.setOpenDoc(doc);
  // Стартовое окно: если локально пусто, забираем хвост с сервера.
  if (!store.view.length) conn.fetchOlder(doc, 0, WINDOW);
  // Диалог открыли — накопившееся в нём прочитано.
  markReadHere();
  input.focus();
}

// Прокрутка к началу истории — сначала локальная база, потом сервер.
logEl.onscroll = async () => {
  if (logEl.scrollTop > 40 || loadingOlder || !store?.doc) return;
  loadingOlder = true;
  markReadHere();
  const got = await store.older();
  if (!got && store.oldestIdx() > 1) {
    conn.fetchOlder(store.doc, store.oldestIdx(), WINDOW);
  }
  loadingOlder = false;
};

// Высота поля идёт за содержимым: сброс, затем замер по scrollHeight.
// Пол и потолок заданы в CSS (min-height / max-height): пустое поле
// остаётся в одну строку, переросшее скроллится внутри себя.
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

input.addEventListener('input', autoGrow);

// Enter отправляет, Shift+Enter переносит строку. На узких экранах
// клавиатуры Enter обычно и есть перенос, поэтому там не перехватываем.
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  if (window.matchMedia('(max-width: 640px)').matches) return;
  e.preventDefault();
  composer.requestSubmit();
});

composer.onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !peerId) return;

  if (editing) {
    conn.send(editing.doc, 'msg.edit', { target: editing.idx, text });
    clearEdit();
    return;
  }

  conn.send(dialogId(me.id, peerId), 'msg.send', withReply({ text }));
  input.value = '';
  autoGrow();
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
  return store.textOf(entry).slice(0, 120);
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

$('replyCancel').onclick = () => (editing ? clearEdit() : clearReply());

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
    else if (!emojiPad.hidden) emojiPad.hidden = true;
    else if (editing) clearEdit();
    else if (replyTo) clearReply();
  }
});

// --- эмодзи ------------------------------------------------------------

// Готовый компонент emoji-picker-element: полный набор, поиск, тона кожи,
// недавние. Лежит в vendor/ — в рантайме внешних загрузок нет.
const picker = document.createElement('emoji-picker');
// Полный адрес от текущей страницы, а не путь от корня: браузер считает
// запрос по абсолютному пути обращением в другое адресное пространство
// и режет его политикой Private Network Access.
picker.dataSource = new URL('vendor/emoji-data.json?v=28', location.href).href;
picker.locale = 'ru';
picker.addEventListener('emoji-click', (e) => insert(e.detail.unicode));
emojiPad.append(picker);

// Полосу прокрутки внутри палитры прячем: колесом листается по-прежнему,
// а сама полоса отъедает колонку. Компонент не отдаёт эту часть наружу
// через ::part, поэтому стиль кладём прямо в его теневое дерево.
const padStyle = document.createElement('style');
padStyle.textContent = `
  .tabpanel { scrollbar-width: none; scrollbar-gutter: auto; }
  .tabpanel::-webkit-scrollbar { width: 0; }
`;
picker.shadowRoot.append(padStyle);

$('emoji').onclick = (e) => {
  e.stopPropagation();
  emojiPad.hidden = !emojiPad.hidden;
};

// Клик мимо палитры закрывает её.
document.addEventListener('click', (e) => {
  if (!emojiPad.hidden && !emojiPad.contains(e.target) && e.target !== $('emoji')) {
    emojiPad.hidden = true;
  }
});

// Вставка идёт в позицию курсора, а не в конец строки.
function insert(ch) {
  const at = input.selectionStart ?? input.value.length;
  const to = input.selectionEnd ?? at;
  input.value = input.value.slice(0, at) + ch + input.value.slice(to);
  autoGrow();
  input.focus();
  input.selectionStart = input.selectionEnd = at + ch.length;
}

// --- картинки ----------------------------------------------------------

$('attach').onclick = () => $('file').click();

$('file').onchange = (e) => {
  const file = e.target.files[0];
  if (file) sendImage(file);
  // Сбрасываем, иначе повторный выбор того же файла не даст события.
  e.target.value = '';
};

// Вставка из буфера: скриншот отправляется без сохранения на диск.
input.onpaste = (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  sendImage(item.getAsFile());
};

async function sendImage(file) {
  if (!peerId) return;
  const doc = dialogId(me.id, peerId);
  try {
    // Сжатие и загрузка идут мимо сокета: в журнал попадёт только id.
    const blob = await prepare(file);
    const saved = await upload(blob, session.token);
    conn.send(doc, 'msg.image', withReply({ file: saved.id, size: saved.size }));
    clearReply();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'status failed';
  }
}

// Возврат к списку людей: на узком экране диалог занимает весь экран.
function backButton() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'icon back';
  el.title = 'К списку';
  el.textContent = '←';
  el.onclick = () => app.classList.remove('at-dialog');
  return el;
}

// --- оповещения --------------------------------------------------------

// Живое чужое сообщение: звук и бейдж. Досыл истории сюда не попадает —
// иначе после разрыва пришла бы очередь сигналов.
function onIncoming(entry) {
  // Открытый диалог на видимой вкладке человек читает прямо сейчас:
  // отмечаем прочитанным, сигнал не нужен.
  if (entry.doc === store.doc && !document.hidden) {
    markReadHere();
    return;
  }
  sound.play();
}

/** Отмечает открытый диалог прочитанным — если человек его действительно видит. */
function markReadHere() {
  if (!store?.doc || document.hidden) return;
  conn?.markRead(store.doc, store.unreadUpto(store.doc));
  refreshBadge();
}

// Время визита само не стареет, но за полночь «был в 23:50» должно
// превратиться в «был 6 сент. в 23:50».
setInterval(() => { if (me) onPresenceChange(); }, 10 * 60000);

// Присутствие меняет и список людей, и шапку диалога.
function onPresenceChange() {
  if (!me) return;
  renderPeople();
  renderHead();
}

function refreshBadge() {
  badge.set(store?.unreadTotal() || 0);
}

// Возврат на вкладку — то же самое, что и прочтение: человек увидел
// накопившееся, значит курсор надо двинуть.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markReadHere();
});

// Клик и прокрутка в открытом диалоге тоже подтверждают прочтение:
// вкладка могла быть видимой всё время, и visibilitychange не сработает.
window.addEventListener('focus', markReadHere);

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
        // Под именем — присутствие: логин человек и так знает, а вот когда
        // собеседник был в сети, видно только здесь.
        const online = presence.isOnline(u.id);
        el.children[1].textContent = presenceLabel(online, presence.lastSeen(u.id));
        if (online) {
          el.children[0].append(dot());
          el.children[1].classList.add('online');
        }

        // Непрочитанное по этому собеседнику — та же цифра, что и на вкладке,
        // но только по его диалогу.
        const unread = store.unreadIn(dialogId(me.id, u.id));
        if (unread) {
          const mark = document.createElement('span');
          mark.className = 'unread';
          mark.textContent = unread > 99 ? '99+' : String(unread);
          el.append(mark);
        }

        el.onclick = () => openDialog(u.id);
        return el;
      })
  );
}

// Метка «в сети»: синяя точка рядом с именем.
function dot() {
  const el = document.createElement('span');
  el.className = 'dot';
  el.title = 'в сети';
  return el;
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
    // Текст берём с учётом правок: оригинал остаётся в журнале,
    // а на экране стоит последняя версия.
    const body = document.createElement('span');
    body.className = 'text';
    body.append(...linkify(entry.idx ? store.textOf(entry) : entry.payload.text ?? ''));
    el.append(body);
  }

  // Подпись снизу: время у отправленного, состояние у неподтверждённого.
  const foot = document.createElement('div');
  foot.className = 'meta';
  foot.textContent = entry.idx && store.isEdited(entry) ? meta + ' изменено' : meta;
  // Галочка на своём сообщении: собеседник дочитал до этого номера.
  if (cls.includes('own') && entry.idx && entry.idx <= store.peerReadIdx(store.doc)) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.title = 'Прочитано';
    tick.textContent = '✓✓';
    foot.append(tick);
  }
  el.append(foot);

  // Действия доступны только записанному: у неподтверждённого нет номера.
  if (entry.idx) {
    el.dataset.idx = entry.idx;
    el.append(actions(entry));
  }
  return el;
}

// Действия над сообщением: панель проявляется при наведении на пузырь.
// Удалять можно только своё — сервер это тоже проверяет.
function actions(entry) {
  const bar = document.createElement('div');
  bar.className = 'actions';
  bar.append(action('💬', 'Ответить', () => startReply(entry)));
  // Править и удалять можно только своё — сервер это тоже проверяет.
  if (entry.author === me.id) {
    if (entry.op === 'msg.send') {
      bar.append(action('✏️', 'Изменить', () => startEdit(entry)));
    }
    bar.append(action('🗑', 'Удалить', () => removeMessage(entry)));
  }
  return bar;
}

function action(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action';
  btn.title = title;
  btn.textContent = icon;
  btn.onclick = onClick;
  return btn;
}

function removeMessage(entry) {
  if (!confirm('Удалить сообщение?')) return;
  conn.send(entry.doc, 'msg.delete', { target: entry.idx });
}

// --- правка ------------------------------------------------------------

function startEdit(entry) {
  clearReply();
  editing = entry;
  input.value = store.textOf(entry);
  autoGrow();
  replyBar.querySelector('.reply-who').textContent = 'Изменение';
  replyBar.querySelector('.reply-text').textContent = store.textOf(entry);
  replyBar.hidden = false;
  input.focus();
}

function clearEdit() {
  editing = null;
  input.value = '';
  autoGrow();
  replyBar.hidden = true;
}

// Отметка о скрытой части истории. Клик показывает ещё одно окно.
function older(count) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'older';
  el.textContent = `Показать ещё (выше ${count})`;
  el.onclick = () => {
    shownExtra += RENDER_LIMIT;
    render();
  };
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
  // Досыл мог принести и чужие сообщения, и чужие отметки о прочтении —
  // бейдж пересчитываем после любой перерисовки.
  refreshBadge();
}

function render() {
  if (!me || !store?.doc) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  const before = logEl.scrollHeight;

  // Рисуем только хвост окна. Остальное лежит в памяти и в базе — его
  // видно после прокрутки вверх, но в разметку оно не попадает.
  // Отметки о прочтении живут в том же журнале, но человек их не видит:
  // в ленту идут только сообщения.
  const messages = store.view.filter(
    (e) => isMessage(e) && !store.isDeleted(store.doc, e.idx));
  const shown = messages.slice(-(RENDER_LIMIT + shownExtra));
  const hidden = messages.length - shown.length;

  logEl.replaceChildren(
    // Сколько записей осталось выше — иначе прокрутка молча упирается.
    ...(hidden > 0 ? [older(hidden)] : []),
    // Подтверждённое — в порядке номеров, назначенных сервером.
    ...shown.map((e) =>
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
  start(session).catch(fail);
}

// Сбой при запуске показываем на месте, а не уводим на страницу входа:
// на телефоне консоли нет, и пустой экран не объясняет ничего.
function fail(e) {
  const box = document.createElement('div');
  box.className = 'fail';
  box.innerHTML = '<h2></h2><p></p><button type="button">Очистить и войти заново</button>';
  box.children[0].textContent = 'Чат не запустился';
  box.children[1].textContent = e?.message || String(e);
  box.children[2].onclick = async () => {
    try {
      conn?.stop();
      storage?.close();
      await Storage.wipe(session.me.id);
    } catch {
      // Не вышло — всё равно уходим на вход, там сессия чистится.
    }
    Session.clear();
    location.replace('/');
  };
  document.body.replaceChildren(box);
}

// Ошибки после запуска тоже не должны оставлять пустой экран.
window.addEventListener('error', (e) => {
  if (!document.querySelector('.fail') && !me) fail(e.error || e.message);
});
