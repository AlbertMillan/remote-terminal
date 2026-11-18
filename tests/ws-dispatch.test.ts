import { describe, it, expect } from 'vitest';
import { handlerFor } from '../src/server/websocket/handler.js';
import { CLIENT_MESSAGE_TYPES } from '../src/server/websocket/protocol.js';

describe('WebSocket dispatch', () => {
  it('has a handler for every client message type but auth', () => {
    for (const type of CLIENT_MESSAGE_TYPES) {
      if (type === 'auth') expect(handlerFor(type), type).toBeUndefined();
      else expect(handlerFor(type), type).toBeTypeOf('function');
    }
  });

  it('never resolves an inherited property as a handler', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(handlerFor(type), type).toBeUndefined();
    }
  });
});
