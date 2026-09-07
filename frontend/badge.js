// Бейдж непрочитанного: красный кружок с цифрой на иконке вкладки
// и число в заголовке.
//
// Иконка рисуется на canvas, а не лежит файлом: бинарников в репозитории
// нет, а нарисовать кружок с цифрой дешевле, чем держать набор картинок
// на каждое число.

const SIZE = 64;
const TITLE = 'mesera';

// Больше трёх знаков в кружок не влезает — дальше показываем предел.
const MAX_SHOWN = 99;

export class Badge {
  constructor(doc = document) {
    this._doc = doc;
    this._link = null;
    this._shown = null;   // что уже нарисовано: лишний раз не перерисовываем
  }

  /** Показывает число непрочитанных. Ноль убирает бейдж. */
  set(count) {
    const value = Math.max(0, Math.floor(count) || 0);
    if (value === this._shown) return;
    this._shown = value;
    this._doc.title = value ? `(${value}) ${TITLE}` : TITLE;
    this._paint(value);
  }

  _paint(count) {
    const canvas = this._doc.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this._drawBase(ctx);
    if (count) this._drawCount(ctx, count);
    this._apply(canvas.toDataURL('image/png'));
  }

  // Основа — та же в обоих состояниях: узнаваемая иконка вкладки.
  _drawBase(ctx) {
    ctx.fillStyle = '#2f6fed';
    ctx.beginPath();
    ctx.roundRect(4, 4, SIZE - 8, SIZE - 8, 14);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('m', SIZE / 2, SIZE / 2 + 2);
  }

  _drawCount(ctx, count) {
    const text = count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
    // Кружок растёт под длину числа, иначе трёхзначное вылезает за края.
    const radius = text.length > 2 ? 22 : 19;
    const cx = SIZE - radius - 1, cy = radius + 1;

    // Обводка цветом фона: кружок читается поверх любой основы.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e5342b';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${text.length > 2 ? 24 : 30}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
  }

  _apply(href) {
    if (!this._link) {
      this._link = this._doc.querySelector('link[rel~="icon"]')
        || this._doc.head.appendChild(Object.assign(
          this._doc.createElement('link'), { rel: 'icon' }));
    }
    this._link.href = href;
  }
}
