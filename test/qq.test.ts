import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchQQInbound,
  extractQQImageResources,
  normalizeQQInboundMessage,
  normalizeQQInboundText,
  parseQQRouteKind,
} from '../src/channels/qq.js';
import { QQ_ROUTE_C2C, QQ_ROUTE_CHANNEL } from '../src/channels/qqClient.js';
import { SHARED_CHAT_SCOPE_USER_ID } from '../src/gateway/sessionStore.js';

test('qq c2c event maps to private conversation key', () => {
  const result = normalizeQQInboundMessage(
    {
      author: { user_openid: 'u-open' },
      content: 'hello',
      id: 'm1',
    },
    QQ_ROUTE_C2C,
  );

  assert.ok(result);
  assert.deepEqual(result.key, {
    platform: 'qq',
    chatId: 'u-open',
    threadId: QQ_ROUTE_C2C,
    userId: 'u-open',
    scopeUserId: null,
  });
  assert.equal(result.text, 'hello');
  assert.equal(result.sinkChatId, 'u-open');
});

test('qq channel @ event maps to shared scope key', () => {
  const result = normalizeQQInboundMessage(
    {
      author: { user_openid: 'u-open' },
      channel_id: 'channel-1',
      content: '<@123> hi',
      id: 'm2',
    },
    QQ_ROUTE_CHANNEL,
  );

  assert.ok(result);
  assert.deepEqual(result.key, {
    platform: 'qq',
    chatId: 'channel-1',
    threadId: QQ_ROUTE_CHANNEL,
    userId: 'u-open',
    scopeUserId: SHARED_CHAT_SCOPE_USER_ID,
  });
  assert.equal(result.text, 'hi');
  assert.equal(result.sinkChatId, 'channel-1');
});

test('qq mention stripping removes repeated leading mentions', () => {
  assert.equal(
    normalizeQQInboundText(' <@123>  <@456>   test  ', QQ_ROUTE_CHANNEL),
    'test',
  );
  assert.equal(normalizeQQInboundText('  hello  ', QQ_ROUTE_C2C), 'hello');
});

test('qq image resource extraction keeps image urls only', () => {
  const resources = extractQQImageResources([
    {
      url: '//cdn.qq.com/a.png',
      content_type: 'image/png',
    },
    {
      tencent_url: 'https://cdn.qq.com/a.png',
      content_type: 'image/png',
    },
    {
      url: 'https://cdn.qq.com/file.txt',
      content_type: 'text/plain',
    },
    {
      url: 'https://cdn.qq.com/b.jpg?x=1',
      content_type: 'image',
    },
  ]);

  assert.deepEqual(resources, [
    { uri: 'https://cdn.qq.com/a.png', mimeType: 'image/png' },
    { uri: 'https://cdn.qq.com/b.jpg?x=1', mimeType: 'image/*' },
  ]);
});

test('qq attachment-only channel message is accepted after mention stripping', () => {
  const result = normalizeQQInboundMessage(
    {
      author: { user_openid: 'u-open' },
      channel_id: 'channel-1',
      content: '<@123>',
      attachments: [{ url: 'https://cdn.qq.com/a.png', content_type: 'image/png' }],
    },
    QQ_ROUTE_CHANNEL,
  );

  assert.ok(result);
  assert.equal(result.text, '');
  assert.deepEqual(result.resources, [
    { uri: 'https://cdn.qq.com/a.png', mimeType: 'image/png' },
  ]);
});

test('qq route kind parser supports scheduler round-trip', () => {
  assert.equal(parseQQRouteKind(QQ_ROUTE_C2C), QQ_ROUTE_C2C);
  assert.equal(parseQQRouteKind(QQ_ROUTE_CHANNEL), QQ_ROUTE_CHANNEL);
  assert.equal(parseQQRouteKind('telegram-thread'), null);
  assert.equal(parseQQRouteKind(null), null);
});

test('qq dispatch forwards normalized payload into router', async () => {
  const calls: any[] = [];
  const sent: any[] = [];
  const router = {
    handleUserMessage: async (...args: any[]) => {
      calls.push(args);
    },
  };
  const client = {
    sendText: async (payload: any) => {
      sent.push(payload);
      return { id: '1' };
    },
  };

  dispatchQQInbound(
    router as any,
    client as any,
    {
      author: { user_openid: 'u-open' },
      channel_id: 'channel-1',
      content: '<@123> hi',
      attachments: [{ url: 'https://cdn.qq.com/a.png', content_type: 'image/png' }],
    },
    QQ_ROUTE_CHANNEL,
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].platform, 'qq');
  assert.equal(calls[0][0].threadId, QQ_ROUTE_CHANNEL);
  assert.equal(calls[0][0].scopeUserId, SHARED_CHAT_SCOPE_USER_ID);
  assert.equal(calls[0][1], 'hi');
  assert.deepEqual(calls[0][3], {
    resources: [{ uri: 'https://cdn.qq.com/a.png', mimeType: 'image/png' }],
  });

  await calls[0][2].sendText('pong');
  await calls[0][2].flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    routeKind: QQ_ROUTE_CHANNEL,
    chatId: 'channel-1',
    text: 'pong',
  });
});
