import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import type { ConversationKey } from '../src/gateway/sessionStore.js';
import {
  remapTelegramInlineCommand,
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
