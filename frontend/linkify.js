/* Разбор текста сообщения на узлы: обычный текст и кликаемые ссылки.

Текст сообщения приходит от другого пользователя, поэтому вставляется
только узлами. Через innerHTML он стал бы разметкой.
*/

const LINK_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

// Хвостовая пунктуация чаще принадлежит фразе, а не адресу: "см. (site.com)."
// Закрывающие скобки режем только лишние — те, что не открыты внутри адреса,
// иначе ссылка на википедию потеряет "(значения)".
export function trimTail(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      const head = url.slice(0, end);
      const opened = head.split(open).length - 1;
      const closed = head.split(ch).length - 1;
      if (opened >= closed) break;   // скобка парная — она часть адреса
    } else if (!'.,;:!?'.includes(ch)) {
      break;
    }
    end--;
  }
  return url.slice(0, end);
}

// Разбор строки на куски: {text} и {url}. Без DOM, поэтому проверяем тестом.
export function split(text) {
  const parts = [];
  let at = 0;
  for (const hit of text.matchAll(LINK_RE)) {
    const url = trimTail(hit[0]);
    if (hit.index > at) parts.push({ text: text.slice(at, hit.index) });
    parts.push({ url });
    at = hit.index + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

// Адрес без схемы браузер считает относительным путём — дописываем https.
export function href(url) {
  return url.startsWith('www.') ? 'https://' + url : url;
}

export function linkify(text) {
  return split(text).map((part) => {
    if (part.text !== undefined) return document.createTextNode(part.text);
    const link = document.createElement('a');
    link.href = href(part.url);
    link.textContent = part.url;
    link.target = '_blank';
    // noopener: страница по ссылке иначе получит доступ к window.opener.
    link.rel = 'noopener noreferrer';
    return link;
  });
}
