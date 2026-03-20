import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import {
  createRun,
  createSession,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';

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

test('/help prints built-in commands without requiring binding', async () => {
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
  await router.handleUserMessage(key, '/help', {
    sendText: async (t: string) => out.push(t),
  } as any);

  const text = out.join('\n');
  assert.ok(text.includes('可用命令：'));
  assert.ok(text.includes('/ui'));
  assert.ok(text.includes('/cli'));
  assert.ok(text.includes('/workspace'));
  assert.ok(text.includes('/stop'));
  assert.ok(text.includes('/whitelist'));
  assert.ok(text.includes('显示帮助'));

  router.close();
  db.close();
});

test('/help merges ACP commands with local Claude skills and shows Telegram alias', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cli-gateway-help-'),
  );
  let router: GatewayRouter | null = null;

  try {
    fs.mkdirSync(path.join(workspaceRoot, '.claude', 'skills', 'research-lit'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        workspaceRoot,
        '.claude',
        'skills',
        'research-lit',
        'SKILL.md',
      ),
      '# Research Lit\nFind related work quickly.\n',
      'utf8',
    );

    router = new GatewayRouter({
      db,
      config: { ...createConfig(), workspaceRoot } as any,
    });

    const key: ConversationKey = {
      platform: 'telegram',
      chatId: 'c',
      threadId: null,
      userId: 'u',
    };

    createSession(db, {
      sessionKey: 's1',
      agentCommand: 'npx',
      agentArgs: ['-y', '@zed-industries/claude-code-acp@latest'],
      cwd: workspaceRoot,
      loadSupported: false,
    });
    upsertBinding(db, key, 's1');

    createRun(db, {
      runId: 'r1',
      sessionKey: 's1',
      promptText: 'hello',
    });

    db.prepare(
      `
      INSERT INTO events(run_id, seq, method, payload_json, created_at)
      VALUES(?, ?, 'session/update', ?, ?)
      `,
    ).run(
      'r1',
      1,
      JSON.stringify({
        sessionId: 'acp-s1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Review my current changes', input: null },
          ],
        },
      }),
      Date.now(),
    );

    const out: string[] = [];
    await router.handleUserMessage(key, '/help', {
      sendText: async (t: string) => out.push(t),
    } as any);

    const text = out.join('\n');
    assert.ok(text.includes('CLI Inline Commands:'));
    assert.ok(text.includes('/review (cli-inline) - 审查当前改动'));
    assert.ok(text.includes('/research_lit -> /research-lit (cli-inline) - 快速查找相关工作'));
  } finally {
    router?.close();
    db.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('/help keeps original description for unknown inline commands', async () => {
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

  createSession(db, {
    sessionKey: 's2',
    agentCommand: 'npx',
    agentArgs: ['-y', '@zed-industries/claude-code-acp@latest'],
    cwd: '/tmp',
    loadSupported: false,
  });
  upsertBinding(db, key, 's2');

  createRun(db, {
    runId: 'r2',
    sessionKey: 's2',
    promptText: 'hello',
  });

  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run(
    'r2',
    1,
    JSON.stringify({
      sessionId: 'acp-s2',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'foo-bar', description: 'Do custom thing', input: null },
        ],
      },
    }),
    Date.now(),
  );

  const out: string[] = [];
  await router.handleUserMessage(key, '/help', {
    sendText: async (t: string) => out.push(t),
  } as any);

  const text = out.join('\n');
  assert.ok(text.includes('/foo_bar -> /foo-bar (cli-inline) - Do custom thing'));

  router.close();
  db.close();
});
