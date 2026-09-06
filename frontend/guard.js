// Перехват сбоев палитры эмодзи.
//
// emoji-picker-element грузит свою базу сам, уже при импорте, и при
// неудаче роняет необработанный промис. Раньше это уносило весь чат:
// страница оставалась пустой из-за украшения.
//
// Модуль отдельный, потому что импорты в ES-модулях выполняются раньше
// любого кода в теле файла — перехват должен встать до импорта пикера.

window.addEventListener('unhandledrejection', (e) => {
  const from = String(e.reason?.stack || e.reason || '');
  if (!from.includes('database.js') && !from.includes('picker.js')) return;

  // Чат работает и без палитры — прячем кнопку и живём дальше.
  e.preventDefault();
  const hide = (id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  };
  hide('emoji');
  hide('emojiPad');
});
