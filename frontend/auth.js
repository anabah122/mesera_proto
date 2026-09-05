// Страница входа. Знает только про HTTP-авторизацию.
// Ни сокета, ни IndexedDB здесь нет: подняв токен, уходим на /chat.

import { Session } from './session.js?v=11';

const $ = (id) => document.getElementById(id);

// Уже авторизован — на странице входа делать нечего.
if (Session.load()) location.replace('/chat');

// Причина, по которой чат вернул нас сюда (протухший токен).
const kicked = sessionStorage.getItem('mesera.authError');
if (kicked) {
  sessionStorage.removeItem('mesera.authError');
  $('authError').textContent = kicked;
  $('authError').hidden = false;
}

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
  const submit = $('auth').querySelector('.primary');
  err.hidden = true;
  submit.disabled = true;
  try {
    const res = mode === 'login'
      ? await Session.login($('login').value, $('password').value)
      : await Session.register($('login').value, $('password').value, $('name').value);
    Session.save(res);
    location.assign('/chat');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    submit.disabled = false;
  }
};
