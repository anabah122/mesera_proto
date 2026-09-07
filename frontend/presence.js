// Кто сейчас в сети.
//
// Присутствие живёт в памяти и приходит кадрами PRESENCE: в журнал его
// не пишут — оно меняется постоянно, а журнал хранится вечно. Клиент,
// не заставший чужой вход, получает снимок в READY.

// Короткий обрыв не должен мигать «офлайн»: в метро связь пропадает на
// секунды, а собеседник видел бы мерцание.
const OFFLINE_DELAY = 30000;

export class Presence {
  constructor(onChange) {
    this._onChange = onChange;
    this._online = new Set();
    this._lastSeen = new Map();  // id -> когда видели последний раз
    this._pending = new Map();   // id -> таймер отложенного офлайна
  }

  /** Снимок из READY: он — источник правды на момент подключения. */
  reset(ids) {
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this._online = new Set(ids);
    this._onChange?.();
  }

  /** Запоминает, когда человека видели последний раз. Присутствие не трогает. */
  seen(id, lastSeen) {
    if (!lastSeen) return;
    const known = this._lastSeen.get(id) || 0;
    if (lastSeen <= known) return;
    this._lastSeen.set(id, lastSeen);
    this._onChange?.();
  }

  set(id, online, lastSeen = 0) {
    if (lastSeen) this._lastSeen.set(id, lastSeen);

    const timer = this._pending.get(id);
    if (timer) {
      clearTimeout(timer);
      this._pending.delete(id);
    }

    if (online) {
      this._online.add(id);
      this._onChange?.();
      return;
    }

    // Уход показываем с задержкой: переподключение за это время
    // отменяет его, и мигания не видно.
    this._pending.set(id, setTimeout(() => {
      this._pending.delete(id);
      this._online.delete(id);
      this._onChange?.();
    }, OFFLINE_DELAY));
  }

  isOnline(id) {
    return this._online.has(id);
  }

  lastSeen(id) {
    return this._lastSeen.get(id) || 0;
  }

  /** Соединение потеряно: про чужое присутствие мы больше ничего не знаем. */
  clear() {
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this._online.clear();
    this._onChange?.();
  }
}

/** «в сети» или когда видели последний раз. */
export function presenceLabel(online, lastSeen) {
  if (online) return 'в сети';
  if (!lastSeen) return 'не в сети';

  const seen = new Date(lastSeen);
  const time = seen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Сегодняшнее время без даты читается само; за прошлые дни без неё
  // непонятно, о каком «16:01» речь.
  const today = new Date().toDateString() === seen.toDateString();
  if (today) return `был в ${time}`;

  const date = seen.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `был ${date} в ${time}`;
}
