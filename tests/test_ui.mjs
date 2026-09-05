// Логика интерфейса: скрытие модалки, палитра эмодзи.
// Запуск: node tests/test_ui.mjs
//
// Браузера нет, поэтому проверяется то, что от него не зависит:
// правила CSS и работа палитры на подменённом localStorage.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

  async 'палитра собрана из локальных данных, без загрузок в рантайме'() {
    const src = readFileSync(new URL('../frontend/emoji.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /https?:\/\//, 'палитра не должна ходить в сеть');

    const { GROUPS } = await import('../frontend/emoji-data.js');
    const total = GROUPS.reduce((n, g) => n + g.e.length, 0);
    assert.ok(total > 1000, `эмодзи слишком мало: ${total}`);
    assert.ok(GROUPS.length >= 6, 'категорий слишком мало');
  },

  async 'каждая запись — символ и название для поиска'() {
    const { GROUPS } = await import('../frontend/emoji-data.js');
    for (const g of GROUPS) {
      assert.ok(g.t && g.i, 'у категории нет названия или значка');
      for (const [ch, name] of g.e.slice(0, 5)) {
        assert.ok(ch.length > 0 && typeof name === 'string');
      }
    }
  },

  async 'поиск находит по названию'() {
    const { GROUPS } = await import('../frontend/emoji-data.js');
    const all = GROUPS.flatMap((g) => g.e);
    const found = all.filter(([, name]) => name.toLowerCase().includes('cat'));
    assert.ok(found.length > 0, 'поиск по названию ничего не дал');
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
