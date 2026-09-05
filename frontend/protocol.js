// Типы кадров chat.v1. Держим в синхроне с backend/protocol.py.
export const T = {
  HELLO: 'hello',
  TX: 'tx',
  FETCH: 'fetch',
  PING: 'ping',
  READY: 'ready',
  SYNCED: 'synced',
  ACK: 'ack',
  NACK: 'nack',
  EVT: 'evt',
  RESET: 'reset',
  PONG: 'pong',
};

export function txid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Идентификатор диалога детерминирован для пары: кто пишет первым — неважно.
// Правило повторяет backend/dialogs.py.
export function dialogId(a, b) {
  return 'd:' + [a, b].sort().join(':');
}
