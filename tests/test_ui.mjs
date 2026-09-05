// Логика интерфейса: скрытие модалки, палитра эмодзи.
// Запуск: node tests/test_ui.mjs
//
// Браузера нет, поэтому проверяется то, что от него не зависит:
// правила CSS и работа палитры на подменённом localStorage.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const css = readFileSync(new URL('../frontend/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../frontend/chat.html', import.meta.url), 'utf8');

const tests = {
  // --- модалка -------------------------------------------------------------

  'hidden перебивает display у любого элемента'() {
    // Регрессия: .viewer с display:flex показывался поверх приложения
    // даже с атрибутом hidden — правило display в классе сильнее.
    assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important/,
      'без этого правила hidden не скрывает элементы с display в классе');
  },

  'элементы, которые прячутся, объявлены скрытыми в разметке'() {
    for (const id of ['viewer', 'replyBar', 'emojiPad']) {
      const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
      assert.ok(tag, `элемент ${id} не найден`);
      assert.match(tag[0], /\bhidden\b/, `${id} должен быть скрыт изначально`);
    }
  },

  'модалка перекрывает всё остальное'() {
    const rule = css.match(/\.viewer\s*{([^}]*)}/);
    assert.ok(rule, 'правило .viewer не найдено');
    assert.match(rule[1], /position:\s*fixed/);
    const z = Number(rule[1].match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    assert.ok(z >= 100, `слой модалки слишком низкий: ${z}`);
  },

  // --- палитра -------------------------------------------------------------

  'палитра — готовый компонент, лежащий локально'() {
    const src = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    assert.match(src, /vendor\/picker\.js/, 'пикер не подключён из vendor');
    assert.doesNotMatch(src, /https?:\/\//, 'в рантайме не должно быть внешних загрузок');
  },

  'файлы пикера на месте'() {
    for (const f of ['picker.js', 'database.js', 'emoji-data.json']) {
      const size = statSync(new URL('../frontend/vendor/' + f, import.meta.url)).size;
      assert.ok(size > 100, `${f} пустой или отсутствует`);
    }
  },

  // --- вложения ------------------------------------------------------------

  'кнопка вложения и вставка из буфера подключены'() {
    // Регрессия: обработчики пропали вместе с вырезанной палитрой.
    const src = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    assert.match(src, /\$\('attach'\)\.onclick/, 'кнопка вложения не подключена');
    assert.match(src, /\$\('file'\)\.onchange/, 'выбор файла не обрабатывается');
    assert.match(src, /input\.onpaste/, 'вставка из буфера не обрабатывается');
    assert.match(src, /msg\.image/, 'картинка не отправляется в журнал');
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
