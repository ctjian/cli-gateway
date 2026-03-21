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

function getInlineKeyboardData(call: any): {
  allow: string;
  allowAlways: string;
  deny: string;
} {
  const inlineKeyboard = call?.args?.[2]?.reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(inlineKeyboard));
  const row = inlineKeyboard[0];
  assert.ok(Array.isArray(row));
  return {
    allow: String(row[0]?.callback_data ?? ''),
    allowAlways: String(row[1]?.callback_data ?? ''),
    deny: String(row[row.length - 1]?.callback_data ?? ''),
  };
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

  const keyboard = getInlineKeyboardData(call);
  assert.equal(keyboard.allow, 'acpperm:s:r:allow');
  assert.equal(keyboard.allowAlways, 'acpperm:s:r:allow_prefix');
  assert.equal(keyboard.deny, 'acpperm:s:r:deny');
});

test('telegram sink uses injected permission callback builder', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 'token', 1, null, 'u1', {
    buildPermissionCallbackData: () => ({
      allowData: 'acpperm:t:shorttoken:a',
      denyData: 'acpperm:t:shorttoken:d',
    }),
  });

  await sink.requestPermission!({
    uiMode: 'summary',
    sessionKey: 'session-very-long',
    requestId: 'request-very-long',
    toolTitle: 'terminal/create',
    toolKind: 'execute',
  });

  const call = calls.find((c) => c.method === 'sendMessage');
  assert.ok(call);
  const keyboard = getInlineKeyboardData(call);
  assert.equal(keyboard.allow, 'acpperm:t:shorttoken:a');
  assert.equal(keyboard.deny, 'acpperm:t:shorttoken:d');
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

test('telegram sink updates tool UI by toolCallId in private chat', async () => {
  const { bot, calls } = createFakeBot();
  const sink = createTelegramSink(bot, 'token', 1, null, 'u1');

  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'terminal/create · started',
    toolCallId: 'tc-1',
    stage: 'start',
  });

  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'terminal/create · running',
    toolCallId: 'tc-1',
    stage: 'update',
  });

  await sink.sendUi!({
    kind: 'tool',
    mode: 'summary',
    title: 'terminal/create · completed',
    toolCallId: 'tc-1',
    stage: 'complete',
  });

  const sends = calls.filter((c) => c.method === 'sendMessage');
  const edits = calls.filter((c) => c.method === 'editMessageText');

  assert.equal(sends.length, 1);
  assert.equal(edits.length, 2);
  assert.ok(String(sends[0].args[1]).includes('started'));
  assert.ok(String(edits[1].args[2]).includes('completed'));
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

  const keyboard = getInlineKeyboardData(permission);
  assert.equal(keyboard.allow, 'acpperm:s:r:allow');
  assert.equal(keyboard.allowAlways, 'acpperm:s:r:allow_prefix');
  assert.equal(keyboard.deny, 'acpperm:s:r:deny');

  const ui = calls.at(-1);
  assert.equal(ui.method, 'sendMessage');
  assert.equal(ui.args[2].parse_mode, 'HTML');
  assert.ok(String(ui.args[1]).includes('<pre><code>'));
});
