import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import type { ConversationKey } from '../src/gateway/sessionStore.js';
import {
  createTelegramCommandSink,
  parseTelegramPermissionCallbackData,
  queueTelegramTextBurst,
  remapTelegramInlineCommand,
  shouldDebounceTelegramTextBurst,
  splitTelegramMessageChunks,
  syncTelegramCommandsForChat,
} from '../src/channels/telegram.js';

function createConfig() {
  return {
    discordToken: undefined,
    discordAllowChannelId: undefined,
    telegramToken: undefined,
    feishuAppId: undefined,
    feishuAppSecret: undefined,
    feishuVerificationToken: undefined,
    feishuListenPort: 3030,
    acpAgentCommand: 'node',
    acpAgentArgs: [],
    workspaceRoot: '/tmp/cli-gateway-test',
    dbPath: ':memory:',
    schedulerEnabled: false,
    runtimeIdleTtlSeconds: 999,
    maxBindingRuntimes: 5,
    uiDefaultMode: 'verbose',
    uiJsonMaxChars: 1000,
    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 0,
  };
}

test('commands with @bot suffix are handled', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const out: string[] = [];
  await router.handleUserMessage(key, '/help@claw7testbot', {
    sendText: async (t: string) => out.push(t),
  } as any);

  assert.ok(out.join('\n').includes('可用命令：'));

  router.close();
  db.close();
});

test('Telegram inline aliases remap to canonical slash commands', () => {
  const inlineCommands = [
    { name: 'research-lit', description: 'Research', inputHint: null },
  ];

  assert.equal(
    remapTelegramInlineCommand('/research_lit', inlineCommands as any),
    '/research-lit',
  );
  assert.equal(
    remapTelegramInlineCommand('/research_lit@botname topic', inlineCommands as any),
    '/research-lit topic',
  );
});

test('Telegram permission callback parser accepts short token and legacy forms', () => {
  assert.deepEqual(parseTelegramPermissionCallbackData('acpperm:t:shorttoken:a'), {
    kind: 'token',
    token: 'shorttoken',
    decision: 'allow',
  });
  assert.deepEqual(parseTelegramPermissionCallbackData('acpperm:t:shorttoken:d'), {
    kind: 'token',
    token: 'shorttoken',
    decision: 'deny',
  });
  assert.deepEqual(parseTelegramPermissionCallbackData('acpperm:s1:r1:allow'), {
    kind: 'legacy',
    sessionKey: 's1',
    requestId: 'r1',
    decision: 'allow',
  });
});

test('Telegram permission callback parser rejects malformed data', () => {
  assert.equal(parseTelegramPermissionCallbackData(''), null);
  assert.equal(parseTelegramPermissionCallbackData('acpperm:t::a'), null);
  assert.equal(parseTelegramPermissionCallbackData('acpperm:t:token:x'), null);
  assert.equal(parseTelegramPermissionCallbackData('acpperm:s1:r1:x'), null);
  assert.equal(parseTelegramPermissionCallbackData('hello:s1:r1:allow'), null);
});

test('Telegram command sync descriptions show canonical command name', async () => {
  const calls: Array<{ commands: any[]; scope: any }> = [];
  const bot = {
    api: {
      setMyCommands: async (commands: any[], scope: any) => {
        calls.push({ commands, scope });
      },
    },
  };

  await syncTelegramCommandsForChat({
    bot: bot as any,
    chatId: 123,
    baseCommands: [{ command: 'help', description: '显示帮助' }],
    inlineCommands: [
      { name: 'research-lit', description: '查找相关工作', inputHint: null },
    ],
    signatures: new Map(),
  });

  const synced = calls.at(-1)?.commands ?? [];
  const dynamic = synced.find((item) => item.command === 'research_lit');
  assert.ok(dynamic);
  assert.ok(String(dynamic.description).includes('cli-inline /research_lit -> /research-lit: 查找相关工作'));
});

test('Telegram command sink renders permission with inline keyboard + HTML', async () => {
  const calls: any[] = [];
  const bot = {
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push({ method: 'sendMessage', args });
        return { message_id: calls.length };
      },
    },
  } as any;

  const sink = createTelegramCommandSink(
    bot,
    1,
    null,
    'u1',
    () => ({
      allowData: 'acpperm:t:shorttoken:a',
      denyData: 'acpperm:t:shorttoken:d',
    }),
  );

  await sink.requestPermission!({
    uiMode: 'summary',
    sessionKey: 'session-very-long',
    requestId: 'request-very-long',
    toolTitle: 'terminal/create',
    toolKind: 'execute',
  });

  const call = calls.find((c) => c.method === 'sendMessage');
  assert.ok(call);
  assert.equal(call.args[0], 1);
  assert.equal(call.args[2].parse_mode, 'HTML');

  const inlineKeyboard = call.args[2]?.reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(inlineKeyboard));
  const row = inlineKeyboard[0];
  assert.ok(Array.isArray(row));
  assert.equal(String(row[0]?.callback_data ?? ''), 'acpperm:t:shorttoken:a');
  assert.equal(String(row[1]?.callback_data ?? ''), 'acpperm:t:shorttoken:d');
});

test('Telegram command replies split long help text into multiple messages', () => {
  const text = ['可用命令：', ...Array.from({ length: 300 }, (_, i) => `/cmd-${i}`)].join('\n');
  const chunks = splitTelegramMessageChunks(text, 120);

  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length <= 120),
    Array(chunks.length).fill(true),
  );
  assert.equal(chunks.join('\n'), text);
});

test('Telegram long plain text bursts are debounced, commands are not', () => {
  assert.equal(
    shouldDebounceTelegramTextBurst({
      rawText: 'A'.repeat(3000),
      resources: [],
      isCommand: false,
    }),
    true,
  );
  assert.equal(
    shouldDebounceTelegramTextBurst({
      rawText: 'short text',
      resources: [],
      isCommand: false,
    }),
    false,
  );
  assert.equal(
    shouldDebounceTelegramTextBurst({
      rawText: '/help ' + 'A'.repeat(4000),
      resources: [],
      isCommand: true,
    }),
    false,
  );
  assert.equal(
    shouldDebounceTelegramTextBurst({
      rawText: 'A'.repeat(3000),
      resources: [{ uri: 'x' } as any],
      isCommand: false,
    }),
    false,
  );
});

test('Telegram long plain text burst queue merges nearby chunks into one dispatch', async () => {
  const pending = new Map();
  const flushed: any[] = [];

  queueTelegramTextBurst({
    pendingTextBursts: pending as any,
    burstKey: 'chat:-:u',
    chatId: 1,
    chatType: 'private',
    userId: 'u',
    threadId: null,
    rawText: 'A'.repeat(3200),
    resources: [],
    messageId: 1,
    flush: (burst) => flushed.push(burst),
  });
  queueTelegramTextBurst({
    pendingTextBursts: pending as any,
    burstKey: 'chat:-:u',
    chatId: 1,
    chatType: 'private',
    userId: 'u',
    threadId: null,
    rawText: 'B'.repeat(1200),
    resources: [],
    messageId: 2,
    flush: (burst) => flushed.push(burst),
  });

  await new Promise((r) => setTimeout(r, 1300));

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].texts, ['A'.repeat(3200), 'B'.repeat(1200)]);
  assert.deepEqual(flushed[0].messageIds, [1, 2]);
});
