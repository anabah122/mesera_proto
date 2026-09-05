// Подготовка картинки к отправке.
//
// Сжатие идёт в браузере: сервер хранит то, что пришло, и не держит
// кодировщик. Фото с телефона (несколько мегабайт) превращается
// в WebP на пару сотен килобайт — на экране разницы не видно.

// Длинная сторона после сжатия. Больше не нужно: в ленте картинка
// показывается меньше, а полный размер открывается тем же файлом.
const MAX_SIDE = 1600;
const QUALITY = 0.75;

// Предел на исходный файл. Снимок с современного телефона укладывается
// с большим запасом; всё что крупнее — почти наверняка не фотография.
const MAX_INPUT = 25 * 1024 * 1024;

export const MAX_INPUT_BYTES = MAX_INPUT;

/** Сжимает картинку и отдаёт Blob, готовый к отправке. */
export async function prepare(file) {
  if (!file.type.startsWith('image/')) throw new Error('это не картинка');
  if (file.size > MAX_INPUT) throw new Error('картинка больше 25 МБ');

  // GIF может быть анимированным, а canvas сохранил бы только первый кадр.
  // Отправляем как есть, если он и так небольшой.
  if (file.type === 'image/gif') {
    if (file.size > 2 * 1024 * 1024) throw new Error('гифка больше 2 МБ');
    return file;
  }

  const bitmap = await load(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  // WebP умеют все живые браузеры; на старых toBlob вернёт PNG вместо
  // запрошенного типа, и тогда пробуем JPEG.
  let blob = await toBlob(canvas, 'image/webp', QUALITY);
  if (!blob || blob.type !== 'image/webp') {
    blob = await toBlob(canvas, 'image/jpeg', QUALITY);
  }
  if (!blob) throw new Error('не удалось обработать картинку');

  // Сжатие иногда даёт больший файл, чем оригинал — у маленьких картинок
  // и скриншотов с плоскими цветами. Тогда исходник лучше.
  if (blob.size >= file.size && TYPES.has(file.type)) return file;
  return blob;
}

const TYPES = new Set(['image/webp', 'image/jpeg', 'image/png', 'image/gif']);

function load(file) {
  // createImageBitmap быстрее и не держит элемент в документе, но
  // в старых браузерах его нет — там идём через <img>.
  if (globalThis.createImageBitmap) return createImageBitmap(file);

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('картинка не читается'));
    };
    img.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Отправляет подготовленный файл и возвращает его описание. */
export async function upload(blob, token) {
  const body = new FormData();
  // Имя роли не играет — сервер выдаёт своё, случайное.
  body.append('file', blob, 'image');

  const res = await fetch('/api/upload?token=' + encodeURIComponent(token), {
    method: 'POST',
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'не удалось загрузить');
  return data;
}
