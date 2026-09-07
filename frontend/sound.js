// Сигнал о новом сообщении.
//
// Тон синтезируется на месте, а не грузится файлом: короткий сигнал
// дешевле сгенерировать, чем держать в репозитории бинарник и тянуть
// его по сети.

// Две ноты вверх — короткий сигнал, не раздражающий при частых сообщениях.
const NOTES = [[880, 0], [1174, 0.09]];
const LENGTH = 0.16;
const VOLUME = 0.09;

export class Sound {
  constructor() {
    this._ctx = null;
    this.enabled = true;
  }

  /** Проигрывает сигнал. Сбой звука не должен ронять приём сообщения. */
  play() {
    if (!this.enabled) return;
    try {
      const ctx = this._context();
      if (!ctx) return;
      // Браузер держит контекст остановленным, пока по странице не кликнут.
      if (ctx.state === 'suspended') ctx.resume();
      for (const [freq, delay] of NOTES) this._note(ctx, freq, delay);
    } catch {
      // Звук — не то, ради чего стоит терять сообщение.
    }
  }

  _context() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    // Контекст один на страницу: браузер ограничивает их число.
    if (!this._ctx) this._ctx = new Ctor();
    return this._ctx;
  }

  _note(ctx, freq, delay) {
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;

    // Плавное затухание: резкий обрыв даёт щелчок.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + LENGTH);

    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + LENGTH);
  }
}
