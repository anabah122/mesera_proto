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

  // --- шрифт эмодзи --------------------------------------------------------

  'цветные эмодзи подключены своим шрифтом'() {
    // Системные эмодзи на Windows плоские; Noto выглядит одинаково везде.
    assert.match(css, /@font-face[\s\S]*?Noto Color Emoji/, 'шрифт не объявлен');
    assert.match(css, /url\('vendor\/font\/noto-color-emoji\.woff2'\)/,
      'шрифт должен лежать локально');
    assert.match(css, /font:[^;]*'Noto Color Emoji'/, 'шрифт не в стеке body');
    assert.match(css, /--emoji-font-family:\s*'Noto Color Emoji'/,
      'в Shadow DOM палитры шрифт не попадёт без этой переменной');
  },

  'файлы шрифтов на месте и это woff2'() {
    const names = [
      'noto-color-emoji',
      'noto-sans-latin-400', 'noto-sans-latin-500', 'noto-sans-latin-600',
      'noto-sans-cyrillic-400', 'noto-sans-cyrillic-500', 'noto-sans-cyrillic-600',
    ];
    for (const n of names) {
      const url = new URL(`../frontend/vendor/font/${n}.woff2`, import.meta.url);
      assert.ok(statSync(url).size > 1000, `${n} подозрительно мал`);
      assert.equal(readFileSync(url).subarray(0, 4).toString('latin1'), 'wOF2',
        `${n} не является woff2`);
    }
  },

  'кириллица подключена отдельным начертанием'() {
    // Без своего файла русский текст свалился бы на системный шрифт.
    assert.match(css, /noto-sans-cyrillic-400\.woff2/, 'кириллица не подключена');
    assert.match(css, /unicode-range:[^;]*U\+0400-045F/, 'нет диапазона кириллицы');
    assert.match(css, /font:[^;]*'Noto Sans'/, 'Noto Sans не первый в стеке');
  },

  'сервер отдаёт woff2 правильным типом'() {
    // Со сторонним типом браузер шрифт отвергает.
    const main = readFileSync(new URL('../backend/main.py', import.meta.url), 'utf8');
    assert.match(main, /add_type\("font\/woff2", "\.woff2"\)/);
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
  // --- устойчивость к сбою палитры ------------------------------------------

  'сбой палитры не уносит весь чат'() {
    // Регрессия: fetch за базой эмодзи резался политикой Private Network
    // Access, необработанный промис ронял app.js, страница была пустой.
    const guard = readFileSync(new URL('../frontend/guard.js', import.meta.url), 'utf8');
    assert.match(guard, /unhandledrejection/, 'перехват не поставлен');
    assert.match(guard, /preventDefault/, 'ошибка не гасится');

    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    const guardAt = app.indexOf("guard.js");
    const pickerAt = app.indexOf("vendor/picker.js");
    assert.ok(guardAt > 0 && guardAt < pickerAt,
      'перехват должен импортироваться до палитры, иначе не успеет');
  },

  'база эмодзи запрашивается адресом от страницы'() {
    // Путь от корня браузер считает обращением в чужое адресное
    // пространство и режет его.
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    assert.match(app, /dataSource = new URL\(/, 'путь снова абсолютный');
    assert.doesNotMatch(app, /dataSource = '\//, 'путь от корня не годится');
  },

  // --- меню и лимит отрисовки ----------------------------------------------

  'меню действий заменило кнопку выхода'() {
    assert.match(html, /id="menuBtn"/, 'кнопки меню нет');
    assert.match(html, /id="wipe"/, 'нет пункта удаления локальных данных');
    assert.match(html, /id="logout"[^>]*class="menu-item/, 'выход должен быть пунктом меню');
    const tag = html.match(/<div id="menu"[^>]*>/);
    assert.match(tag[0], /hidden/, 'меню должно быть закрыто изначально');
  },

  'удаление локальных данных стирает базу целиком'() {
    const storage = readFileSync(new URL('../frontend/storage.js', import.meta.url), 'utf8');
    assert.match(storage, /deleteDatabase/, 'база не удаляется');
    assert.match(storage, /onblocked/, 'удаление повиснет молча, если база открыта');

    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    // Пока сокет жив, он переподключится и снова откроет базу.
    assert.match(app, /conn\?\.stop\(\)/, 'соединение не останавливается перед удалением');
    assert.match(app, /storage\?\.close\(\)/, 'база не закрывается перед удалением');
  },

  'отрисовка ограничена, иначе длинный диалог кладёт телефон'() {
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    const limit = Number(app.match(/RENDER_LIMIT = (\d+)/)?.[1] ?? 0);
    assert.ok(limit > 0 && limit <= 300, `лимит отрисовки неразумен: ${limit}`);
    assert.match(app, /store\.view\.slice\(-\(RENDER_LIMIT/, 'лента рисуется целиком');
    assert.match(app, /shownExtra = 0/, 'счётчик не сбрасывается при смене диалога');
  },

  'форма регистрации требует слово и повтор пароля'() {
    const index = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
    assert.match(index, /id="password2"/, 'нет повтора пароля');
    assert.match(index, /id="invite"/, 'нет поля секретного слова');

    const auth = readFileSync(new URL('../frontend/auth.js', import.meta.url), 'utf8');
    assert.match(auth, /пароли не совпадают/, 'совпадение паролей не проверяется');
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
