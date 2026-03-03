import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramSink } from '../src/channels/telegramSink.js';

function createFakeBot() {
  const calls: any[] = [];

  const bot = {
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push({ method: 'sendMessage', args });
        return { message_id: calls.length };
      },
      editMessageText: async (...args: any[]) => {
        calls.push({ method: 'editMessageText', args });
      },
    },
  } as any;

  return { bot, calls };
}

test('telegram sink renders permission with inline keyboard + HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'fs/read_text_file',
    toolKind: 'read',
  });

  const call = calls.find((c) => c.method === 'sendMessage');
  assert.ok(call);
  assert.equal(call.args[0], 1);
  assert.equal(call.args[2].parse_mode, 'HTML');
  assert.ok(call.args[2].reply_markup);
});

test('telegram sink renders UI events with HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');
  await sink.sendUi!({
    kind: 'plan',
    mode: 'verbose',
    title: 'Plan updated',
    detail: '{"x":1}',
  });

  const call = calls.at(-1);
  assert.equal(call.method, 'sendMessage');
  assert.equal(call.args[2].parse_mode, 'HTML');
});

test('telegram sink streams agent text in private chat and sends final message on flush', async () => {
  const { bot, calls } = createFakeBot();
  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.sendAgentText!('a');
  await sink.sendAgentText!('b');
  await sink.flush();

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(!calls.some((c) => c.method === 'editMessageText'));

  const state = sink.getDeliveryState?.();
  assert.ok(state);
  assert.ok(state.messageId);
});

test('telegram sink private chat edits message for incremental agent text', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1', {
    flushIntervalMs: 5,
  });

  await sink.sendAgentText!('x');
  await new Promise((r) => setTimeout(r, 25));
  await sink.sendAgentText!('y');
  await new Promise((r) => setTimeout(r, 25));
  await sink.flush();

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
});

test('telegram sink private sendText uses standalone message path', async () => {
  const { bot, calls } = createFakeBot();
  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.sendText('[tool] terminal/create');
  await sink.flush();

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
});

test('telegram sink buffers summary tool UI until final flush in private chat', async () => {
  const { bot, calls } = createFakeBot();
  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'terminal/create',
  });

  assert.equal(calls.length, 0);

  await sink.sendAgentText!('done');
  await sink.flush();

  const sentMessages = calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].args[1], 'done');
  assert.ok(String(sentMessages[1].args[1]).includes('[tools]'));
  assert.ok(String(sentMessages[1].args[1]).includes('terminal/create'));
});

test('telegram sink falls back to send+edit in group chat', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', -1, null, 'u1');
  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
});

test('telegram group sink renders permission and UI', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', -1, null, 'u1');

  await sink.requestPermission!({
    uiMode: 'summary',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'terminal/create',
    toolKind: 'execute',
  });

  await sink.sendUi!({
    kind: 'tool',
    mode: 'verbose',
    title: 'terminal/create',
    detail: '{"a":1}',
  });

  const permission = calls.find((c) => c.method === 'sendMessage');
  assert.ok(permission);
  assert.equal(permission.args[2].parse_mode, 'HTML');
  assert.ok(permission.args[2].reply_markup);

  const ui = calls.at(-1);
  assert.equal(ui.method, 'sendMessage');
  assert.equal(ui.args[2].parse_mode, 'HTML');
  assert.ok(String(ui.args[1]).includes('<pre><code>'));
});
