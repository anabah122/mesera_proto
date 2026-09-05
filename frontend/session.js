// Сессия: вход, регистрация, хранение токена.
// Токен переживает перезагрузку страницы и предъявляется в кадре HELLO.

const KEY = 'mesera.session';

export const Session = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  },

  save(session) {
    localStorage.setItem(KEY, JSON.stringify(session));
  },

  clear() {
    localStorage.removeItem(KEY);
  },

  async register(login, password, name) {
    return post('/api/register', { login, password, name });
  },

  async login(login, password) {
    return post('/api/login', { login, password });
  },
};

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
