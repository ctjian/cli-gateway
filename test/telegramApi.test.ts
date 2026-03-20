import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendChatAction,
  sendMessageDraft,
  setChatMenuButton,
  setMessageReaction,
} from '../src/channels/telegramApi.js';

test('sendMessageDraft calls sendMessageDraft', async () => {
  const calls: Array<{ method: string; body: any }> = [];

  const fakeFetch = async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as any;
  };

  await sendMessageDraft(
    't',
    { chatId: 1, threadId: null, draftId: 2, text: 'hi' },
    fakeFetch as any,
  );

  expect(calls, 'sendMessageDraft', {
    chat_id: 1,
    draft_id: 2,
    text: 'hi',
  });
});

test('setMessageReaction calls setMessageReaction', async () => {
  const calls: Array<{ method: string; body: any }> = [];

  const fakeFetch = async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as any;
  };

  await setMessageReaction(
    't',
    { chatId: 1, messageId: 3, emoji: '🕊', isBig: false },
    fakeFetch as any,
  );

  expect(calls, 'setMessageReaction', {
    chat_id: 1,
    message_id: 3,
    reaction: [{ type: 'emoji', emoji: '🕊' }],
    is_big: false,
  });
});

test('sendChatAction calls sendChatAction', async () => {
  const calls: Array<{ method: string; body: any }> = [];

  const fakeFetch = async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as any;
  };

  await sendChatAction(
    't',
    { chatId: 1, threadId: 9, action: 'typing' },
    fakeFetch as any,
  );

  expect(calls, 'sendChatAction', {
    chat_id: 1,
    message_thread_id: 9,
    action: 'typing',
  });
});

test('setChatMenuButton calls setChatMenuButton', async () => {
  const calls: Array<{ method: string; body: any }> = [];

  const fakeFetch = async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as any;
  };

  await setChatMenuButton('t', { chatId: 1 }, fakeFetch as any);

  expect(calls, 'setChatMenuButton', {
    chat_id: 1,
    menu_button: { type: 'commands' },
  });
});

function expect(
  calls: Array<{ method: string; body: any }>,
  expectedMethod: string,
  expectedBody: any,
): void {
  const call = calls.find((c) => c.method === expectedMethod);
  assert.ok(call, `missing ${expectedMethod}`);
  assert.deepEqual(call.body, expectedBody);
}
