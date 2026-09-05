// Палитра эмодзи: вкладки по категориям, поиск, недавно использованные.
//
// Данные лежат в emoji-data.js — файл собран один раз, в рантайме
// ничего не загружается. Готовый компонент (emoji-picker-element)
// не подошёл: он тянет свою базу с CDN и заводит собственную IndexedDB
// ради того, что здесь укладывается в один файл.

import { GROUPS } from './emoji-data.js?v=9';

const RECENT_KEY = 'mesera.emoji.recent';
const RECENT_MAX = 32;

export class EmojiPad {
  constructor(root, onPick) {
    this._root = root;
    this._onPick = onPick;
    this._group = 0;
    this._query = '';
    this._build();
  }

  get hidden() {
    return this._root.hidden;
  }

  toggle() {
    this._root.hidden = !this._root.hidden;
    if (!this._root.hidden) {
      // Недавние могли пополниться с прошлого открытия.
      if (this._group === -1) this._renderCells();
      this._search.focus();
    }
  }

  close() {
    this._root.hidden = true;
  }

  contains(node) {
    return this._root.contains(node);
  }

  // --- разметка -----------------------------------------------------------

  _build() {
    this._root.classList.add('emoji-pad');
    this._root.replaceChildren();

    this._search = document.createElement('input');
    this._search.className = 'emoji-search';
    this._search.placeholder = 'Поиск';
    this._search.oninput = () => {
      this._query = this._search.value.trim().toLowerCase();
      this._renderCells();
    };
    // Enter в поиске вставляет первое совпадение.
    this._search.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = this._cells.querySelector('.emoji-cell');
      if (first) this._pick(first.textContent);
    };

    this._tabs = document.createElement('div');
    this._tabs.className = 'emoji-tabs';

    this._cells = document.createElement('div');
    this._cells.className = 'emoji-cells';

    // Недавние идут первой вкладкой: обычно нужны именно они.
    const tabs = [{ t: 'Недавние', i: '🕘', id: -1 }]
      .concat(GROUPS.map((g, n) => ({ t: g.t, i: g.i, id: n })));

    this._tabButtons = tabs.map((tab) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'emoji-tab';
      el.textContent = tab.i;
      el.title = tab.t;
      el.onclick = () => {
        this._group = tab.id;
        this._query = '';
        this._search.value = '';
        this._syncTabs();
        this._renderCells();
      };
      return el;
    });

    this._tabs.replaceChildren(...this._tabButtons);
    this._root.append(this._search, this._tabs, this._cells);

    // Недавних может не быть — тогда открываем смайлы.
    this._group = recent().length ? -1 : 0;
    this._syncTabs();
    this._renderCells();
  }

  _syncTabs() {
    const active = this._group === -1 ? 0 : this._group + 1;
    this._tabButtons.forEach((el, n) => el.classList.toggle('active', n === active));
  }

  // --- содержимое ---------------------------------------------------------

  _list() {
    if (this._query) {
      // Поиск идёт по всем категориям сразу, а не внутри открытой.
      const found = [];
      for (const g of GROUPS) {
        for (const [ch, name] of g.e) {
          if (name.toLowerCase().includes(this._query)) found.push(ch);
          if (found.length >= 120) return found;
        }
      }
      return found;
    }
    if (this._group === -1) return recent();
    return GROUPS[this._group].e.map(([ch]) => ch);
  }

  _renderCells() {
    const list = this._list();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'emoji-empty';
      empty.textContent = this._query ? 'Ничего не найдено' : 'Здесь появятся недавние';
      this._cells.replaceChildren(empty);
      return;
    }

    this._cells.replaceChildren(...list.map((ch) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'emoji-cell';
      el.textContent = ch;
      el.onclick = () => this._pick(ch);
      return el;
    }));
    this._cells.scrollTop = 0;
  }

  _pick(ch) {
    remember(ch);
    this._onPick(ch);
  }
}

// --- недавние ---------------------------------------------------------------

function recent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function remember(ch) {
  // Повтор поднимается наверх, а не задваивается.
  const list = [ch, ...recent().filter((x) => x !== ch)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Приватный режим может запретить запись — палитра и без этого работает.
  }
}
