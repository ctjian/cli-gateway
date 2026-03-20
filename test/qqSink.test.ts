import test from 'node:test';
import assert from 'node:assert/strict';

import { createQQSink } from '../src/channels/qqSink.js';
import { QQ_ROUTE_C2C } from '../src/channels/qqClient.js';

function createClient() {
  const calls: Array<{ routeKind: string; chatId: string; text: string }> = [];
  return {
    calls,
    client: {
      sendText: async (payload: { routeKind: string; chatId: string; text: string }) => {
        calls.push(payload);
        return { id: String(calls.length) };
      },
    },
  };
}

test('qq sink buffers and flushes text', async () => {
  const { client, calls } = createClient();
  const sink = createQQSink({
    client: client as any,
    routeKind: QQ_ROUTE_C2C,
    chatId: 'open-id',
    userId: 'open-id',
  });

  await sink.sendText('hello');
  await sink.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    routeKind: QQ_ROUTE_C2C,
    chatId: 'open-id',
    text: 'hello',
  });
});

test('qq sink rotates to a new message after breakTextStream', async () => {
  const { client, calls } = createClient();
  const sink = createQQSink({
    client: client as any,
    routeKind: QQ_ROUTE_C2C,
    chatId: 'open-id',
    userId: 'open-id',
  });

  await sink.sendAgentText!('a');
  await sink.breakTextStream!();
  await sink.sendAgentText!('b');
  await sink.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, 'a');
  assert.equal(calls[1].text, 'b');
});
