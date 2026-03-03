import { Bot } from 'grammy';

import type {
  CliInlineCommand,
  GatewayRouter,
  OutboundSink,
} from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createTelegramSink } from './telegramSink.js';
import { setChatMenuButton, setMessageReaction } from './telegramApi.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
  ) => OutboundSink & { flush: () => Promise<void> };
};

export async function startTelegram(
  router: GatewayRouter,
  config: AppConfig,
): Promise<TelegramController | null> {
  if (!config.telegramToken) {
    log.info('Telegram disabled: missing TELEGRAM_TOKEN');
    return null;
  }

  const bot = new Bot(config.telegramToken);
  const chatCommandSignatures = new Map<number, string>();

  const tgCommands = [
    { command: 'help', description: 'Show commands' },
    { command: 'ui', description: 'Set UI mode (verbose/summary)' },
    { command: 'workspace', description: 'Show/set workspace' },
    { command: 'cron', description: 'Manage scheduler jobs' },
    { command: 'new', description: 'Reset conversation session' },
    { command: 'last', description: 'Show last run output' },
    { command: 'replay', description: 'Replay a run output' },
  ];

  // Best-effort: register commands.
  void bot.api
    .setMyCommands(tgCommands)
    .catch((err) => log.warn('Telegram setMyCommands(default) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_private_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(private) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_group_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(group) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_chat_administrators' } })
    .catch((err) => log.warn('Telegram setMyCommands(admins) error', err));

  // Force Telegram UI to show the command menu button.
  void setChatMenuButton(config.telegramToken, {}, fetch).catch((err: unknown) =>
    log.warn('Telegram setChatMenuButton(default) error', err),
  );

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';

    // Always answer quickly so the client doesn't spin.
    try {
      await ctx.answerCallbackQuery({ text: 'Processing...', show_alert: false });
    } catch {
      // ignore
    }

    if (!data.startsWith('acpperm:')) return;

    try {
      const parts = data.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
        return;
      }

      const actorUserId = String(ctx.from?.id ?? '');

      const res = await router.handlePermissionUi({
        platform: 'telegram',
        sessionKey,
        requestId,
        decision,
        actorUserId,
      });

      const msg = ctx.callbackQuery.message;
      if (msg) {
        const emoji = decision === 'allow' ? '👍' : '👎';
        void setMessageReaction(
          config.telegramToken,
          {
            chatId: msg.chat.id,
            messageId: msg.message_id,
            emoji,
            isBig: false,
          },
          fetch,
        ).catch(() => {
          // ignore
        });

        if (res.ok) {
          try {
            await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // ignore
          }
        }
      }

      // Visible confirmation.
      try {
        await ctx.reply(res.message);
      } catch (error) {
        log.error('Telegram permission reply error', error);
      }
    } catch (error) {
      log.error('Telegram callback handler error', error);
      try {
        await ctx.reply('Internal error.');
      } catch {
        // ignore
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text?.trim() ?? '';
      if (!text) return;

      log.info('telegram inbound message', {
        chatId: ctx.chat.id,
        fromId: ctx.from?.id,
        text: text.slice(0, 120),
      });

      // Per-chat: ensure menu button is commands.
      void setChatMenuButton(config.telegramToken, { chatId: ctx.chat.id }, fetch).catch(
        () => {
          // ignore
        },
      );

      const threadId = ctx.message.message_thread_id
        ? String(ctx.message.message_thread_id)
        : null;

      const userId = String(ctx.from?.id ?? 'unknown');

      const key: ConversationKey = {
        platform: 'telegram',
        chatId: String(ctx.chat.id),
        threadId,
        userId,
      };

      const inlineCommands = router.listCliInlineCommands(key);

      // Keep Telegram chat-scope command menu in sync with CLI inline commands.
      void syncTelegramCommandsForChat({
        bot,
        chatId: ctx.chat.id,
        baseCommands: tgCommands,
        inlineCommands,
        signatures: chatCommandSignatures,
      }).catch(() => {
        // ignore
      });

      // /start should show help, not fall through to the agent.
      const remapped = remapTelegramInlineCommand(text, inlineCommands);
      const normalizedText = remapped.startsWith('/start') ? '/help' : remapped;

      const sink = normalizedText.startsWith('/')
        ? createTelegramCommandSink(bot, ctx.chat.id, threadId ? Number(threadId) : null)
        : createTelegramSink(
            bot,
            config.telegramToken,
            ctx.chat.id,
            threadId ? Number(threadId) : null,
            userId,
          );

      // Emoji reaction: processing.
      void setMessageReaction(
        config.telegramToken,
        {
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
          emoji: '🤔',
          isBig: false,
        },
        fetch,
      ).catch(() => {
        // ignore
      });

      // IMPORTANT: do not await; grammY processes updates sequentially.
      const p = router.handleUserMessage(key, normalizedText, sink);

      void p
        .then(async () => {
          await setMessageReaction(
            config.telegramToken,
            {
              chatId: ctx.chat.id,
              messageId: ctx.message.message_id,
              emoji: '🕊',
              isBig: false,
            },
            fetch,
          );

          // Commands may change after this run (available_commands_update).
          void syncTelegramCommandsForChat({
            bot,
            chatId: ctx.chat.id,
            baseCommands: tgCommands,
            inlineCommands: router.listCliInlineCommands(key),
            signatures: chatCommandSignatures,
          }).catch(() => {
            // ignore
          });
        })
        .catch(async (error) => {
          log.error('Telegram router handler error', error);
          try {
            await setMessageReaction(
              config.telegramToken,
              {
                chatId: ctx.chat.id,
                messageId: ctx.message.message_id,
                emoji: '😢',
                isBig: false,
              },
              fetch,
            );
          } catch {
            // ignore
          }
        });
    } catch (error) {
      log.error('Telegram message handler error', error);
    }
  });

  bot.catch((err) => {
    log.error('Telegram bot error', err);
  });

  void startLongPolling(bot);

  return {
    createSink: (chatId, threadId, userId) =>
      createTelegramSink(
        bot,
        config.telegramToken,
        Number(chatId),
        threadId ? Number(threadId) : null,
        userId,
      ),
  };
}

async function startLongPolling(bot: Bot): Promise<void> {
  for (;;) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      log.warn('Telegram deleteWebhook error', err);
    }

    log.info('Telegram long polling start', {
      allowedUpdates: ['message', 'callback_query'],
      dropPendingUpdates: true,
    });

    try {
      await bot.start({
        allowed_updates: ['message', 'callback_query'],
      });
      log.warn('Telegram polling stopped; restarting in 2s');
    } catch (err) {
      log.error('Telegram polling error; restarting in 2s', err);
    }

    await sleep(2000);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function remapTelegramInlineCommand(
  text: string,
  inlineCommands: CliInlineCommand[],
): string {
  if (!text.startsWith('/')) return text;

  const parts = text.trim().split(/\s+/);
  const first = parts[0] ?? '';

  const at = first.indexOf('@');
  const cmdToken = at >= 0 ? first.slice(0, at) : first;
  if (!cmdToken.startsWith('/')) return text;

  const cmd = cmdToken.slice(1).toLowerCase();
  if (!cmd) return text;

  const aliasMap = new Map<string, string>();
  for (const item of inlineCommands) {
    const tg = toTelegramCommandName(item.name);
    if (!tg || tg === item.name) continue;
    if (!aliasMap.has(tg)) aliasMap.set(tg, item.name);
  }

  const mapped = aliasMap.get(cmd);
  if (!mapped) return text;

  parts[0] = `/${mapped}`;
  return parts.join(' ');
}

async function syncTelegramCommandsForChat(params: {
  bot: Bot;
  chatId: number;
  baseCommands: Array<{ command: string; description: string }>;
  inlineCommands: CliInlineCommand[];
  signatures: Map<number, string>;
}): Promise<void> {
  const merged = [...params.baseCommands];
  const seen = new Set<string>(params.baseCommands.map((c) => c.command));

  for (const item of params.inlineCommands) {
    const command = toTelegramCommandName(item.name);
    if (!command || seen.has(command)) continue;

    merged.push({
      command,
      description: truncateTelegramDescription(
        `cli-inline: ${item.description || item.name}`,
      ),
    });
    seen.add(command);

    // Telegram Bot API hard limit.
    if (merged.length >= 100) break;
  }

  const signature = JSON.stringify(merged);
  if (params.signatures.get(params.chatId) === signature) return;

  await params.bot.api.setMyCommands(merged, {
    scope: { type: 'chat', chat_id: params.chatId },
  });
  params.signatures.set(params.chatId, signature);
}

function toTelegramCommandName(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
    .replace(/[^a-z0-9_]/g, '');

  if (!normalized) return null;
  if (normalized.length > 32) return null;
  if (!/^[a-z]/.test(normalized)) return null;
  return normalized;
}

function truncateTelegramDescription(text: string): string {
  const trimmed = text.trim() || 'cli-inline command';
  if (trimmed.length <= 256) return trimmed;
  return trimmed.slice(0, 253) + '...';
}

function createTelegramCommandSink(
  bot: Bot,
  chatId: number,
  threadId: number | null,
): OutboundSink & { flush: () => Promise<void> } {
  let text = '';

  return {
    sendText: async (delta: string) => {
      text += delta;
    },
    flush: async () => {
      const out = text.trim();
      text = '';
      if (!out) return;
      await bot.api.sendMessage(chatId, out, {
        message_thread_id: threadId ?? undefined,
      });
    },
    sendUi: async (event) => {
      const header = `[${event.kind}] ${event.title}`;
      const body = event.detail && event.mode === 'verbose' ? `\n\n${event.detail}` : '';
      await bot.api.sendMessage(chatId, `${header}${body}`, {
        message_thread_id: threadId ?? undefined,
      });
    },
  };
}
