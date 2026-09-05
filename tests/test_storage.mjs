// Хранилище: своя база на пользователя.
// Запуск: node tests/test_storage.mjs
//
// В Node нет IndexedDB — подменяем его заглушкой, которая запоминает,
// с каким именем базу открывали. Проверяется адресация, не сам движок.

import assert from 'node:assert/strict';

const opened = [];

globalThis.indexedDB = {
  open(name) {
    opened.push(name);
    const req = { result: fakeDb(), onsuccess: null, onerror: null, onupgradeneeded: null };
    // Открытие асинхронно, как в браузере.
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  },
};

function fakeDb() {
  return {
    createObjectStore() {},
    transaction() {
      return { objectStore: () => ({ put() {}, get: () => ({}), delete() {} }) };
    },
  };
}

const { Storage } = await import('../frontend/storage.js');

const tests = {
  async 'база названа по пользователю'() {
    opened.length = 0;
    await Storage.open('u_alice');
    assert.deepEqual(opened, ['mesera:u_alice']);
  },

  async 'разные пользователи получают разные базы'() {
    opened.length = 0;
    await Storage.open('u_alice');
    await Storage.open('u_bob');
    assert.equal(new Set(opened).size, 2, 'журналы разных людей попали в одну базу');
  },

  async 'один пользователь всегда открывает ту же базу'() {
    opened.length = 0;
    await Storage.open('u_alice');
    await Storage.open('u_alice');
    assert.equal(new Set(opened).size, 1, 'вкладки одного человека разошлись по базам');
  },

  async 'без идентификатора хранилище не открывается'() {
    // Иначе журналы всех пользователей легли бы в одну общую базу.
    await assert.rejects(() => Storage.open(), /идентификатор/);
    await assert.rejects(() => Storage.open(''), /идентификатор/);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

const total = Object.keys(tests).length;
if (failed) {
  console.error(`\nпровалено: ${failed} из ${total}`);
  process.exit(1);
}
console.log(`ok (${total})`);
