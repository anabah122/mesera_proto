// Сессия: вход, регистрация, хранение токена.
//
// Токен живёт в sessionStorage — у каждой вкладки он свой. Сервер выдаёт
// на пользователя сколько угодно токенов и не считает их конкурентами,
// поэтому все вкладки работают одновременно и на равных: read-only здесь
// нет, каждая пишет и получает чужие транзакции через сокет.
//
// Чтобы новая вкладка не требовала повторного входа, последний вход
// запоминается в localStorage. Оттуда вкладка берёт токен один раз при
// открытии и дальше держит свою копию: логаут в одной вкладке не роняет
// соседние на середине набранного сообщения.

const KEY = 'mesera.session';

export const Session = {
  load() {
    const own = read(sessionStorage);
    if (own) return own;

    // Первое открытие вкладки: наследуем последний вход браузера.
    const shared = read(localStorage);
    if (shared) write(sessionStorage, shared);
    return shared;
  },

  save(session) {
    write(sessionStorage, session);
    write(localStorage, session);
  },

  clear() {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  },

  async register(login, password, name) {
    return post('/api/register', { login, password, name });
  },

  async login(login, password) {
    return post('/api/login', { login, password });
  },
};

function read(store) {
  try {
    const session = JSON.parse(store.getItem(KEY));
    // Без идентификатора нельзя открыть хранилище пользователя.
    return session?.token && session?.me?.id ? session : null;
  } catch {
    return null;
  }
}

function write(store, session) {
  try {
    store.setItem(KEY, JSON.stringify(session));
  } catch {
    // Приватный режим может запретить запись — сессия проживёт в памяти.
  }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'ошибка запроса');
  return data;
}
