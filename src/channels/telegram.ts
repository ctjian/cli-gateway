import { Bot, type Api } from 'grammy';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
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

  const configuredChatIds = new Set<number>();

  const tgCommands = [
    { command: 'help', description: 'Show commands' },
    { command: 'ui', description: 'Set UI mode (verbose/summary)' },
    { command: 'workspace', description: 'Show/set workspace' },
    { command: 'cron', description: 'Manage scheduler jobs' },
    { command: 'new', description: 'Reset conversation session' },
    { command: 'last', description: 'Show last run output' },
    { command: 'replay', description: 'Replay a run output' },
  ];

  // Best-effort: register commands in common scopes.
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
  void setChatMenuButton(config.telegramToken, {}, fetch).catch((err) =>
    log.warn('Telegram setChatMenuButton(default) error', err),
  );

  // Ensure webhook is disabled for long polling.
  void bot.api
    .deleteWebhook({ drop_pending_updates: false })
    .catch((err) => log.warn('Telegram deleteWebhook error', err));

  void startPolling({
    botApi: bot.api,
    router,
    config,
    configuredChatIds,
    tgCommands,
  });

  log.info('Telegram adapter started (custom long polling)');

  return {
    createSink: (chatId, threadId, userId) =>
      createTelegramSink(
        bot,
        Number(chatId),
        threadId ? Number(threadId) : null,
        userId,
      ),
  };
}

async function startPolling(params: {
  botApi: Api;
  router: GatewayRouter;
  config: AppConfig;
  configuredChatIds: Set<number>;
  tgCommands: Array<{ command: string; description: string }>;
}): Promise<void> {
  const allowedUpdates = ['message', 'callback_query'] as const;
  let offset = 0;

  for (;;) {
    try {
      const updates = await params.botApi.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: allowedUpdates as any,
      });

      for (const upd of updates) {
        offset = Math.max(offset, upd.update_id + 1);

        if (upd.message?.text) {
          void handleTextMessage({
            router: params.router,
            config: params.config,
            botApi: params.botApi,
            configuredChatIds: params.configuredChatIds,
            tgCommands: params.tgCommands,
            message: upd.message as any,
          });
          continue;
        }

        if (upd.callback_query?.data) {
          void handleCallbackQuery({
            router: params.router,
            config: params.config,
            botApi: params.botApi,
            callback: upd.callback_query as any,
          });
        }
      }
    } catch (err: any) {
      log.error('Telegram getUpdates error; retrying in 2s', err);
      await sleep(2000);
    }
  }
}

async function handleTextMessage(params: {
  router: GatewayRouter;
  config: AppConfig;
  botApi: Api;
  configuredChatIds: Set<number>;
  tgCommands: Array<{ command: string; description: string }>;
  message: any;
}): Promise<void> {
  const text = String(params.message.text ?? '').trim();
  if (!text) return;

  const chatId = Number(params.message.chat?.id);
  const threadId = params.message.message_thread_id
    ? Number(params.message.message_thread_id)
    : null;

  const fromId = String(params.message.from?.id ?? 'unknown');

  log.info('telegram inbound message', {
    chatId,
    fromId,
    text: text.slice(0, 120),
  });

  // Ensure commands are visible in this chat.
  if (!params.configuredChatIds.has(chatId)) {
    params.configuredChatIds.add(chatId);

    void params.botApi
      .setMyCommands(params.tgCommands, {
        scope: { type: 'chat', chat_id: chatId },
      })
      .catch((err) => log.warn('Telegram setMyCommands(chat) error', err));

    void setChatMenuButton(params.config.telegramToken!, { chatId }, fetch).catch(
      (err) => log.warn('Telegram setChatMenuButton(chat) error', err),
    );
  }

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: String(chatId),
    threadId: threadId ? String(threadId) : null,
    userId: fromId,
  };

  // /start should show help, not fall through to the agent.
  const normalizedText = text.startsWith('/start') ? '/help' : text;

  const isCommandMessage = normalizedText.startsWith('/');
  const sink = isCommandMessage
    ? createTelegramCommandSink(params.botApi, { chatId, threadId })
    : createTelegramSink(params.botApi as any, chatId, threadId, fromId);

  // Emoji reaction: acknowledge that we're processing.
  void setMessageReaction(
    params.config.telegramToken!,
    {
      chatId,
      messageId: Number(params.message.message_id),
      emoji: '🤔',
      isBig: false,
    },
    fetch,
  ).catch(() => {
    // ignore
  });

  const p = params.router.handleUserMessage(key, normalizedText, sink);

  void p
    .then(async () => {
      await setMessageReaction(
        params.config.telegramToken!,
        {
          chatId,
          messageId: Number(params.message.message_id),
          emoji: '🕊',
          isBig: false,
        },
        fetch,
      );
    })
    .catch(async (error) => {
      log.error('Telegram router handler error', error);
      try {
        await setMessageReaction(
          params.config.telegramToken!,
          {
            chatId,
            messageId: Number(params.message.message_id),
            emoji: '😢',
            isBig: false,
          },
          fetch,
        );
      } catch {
        // ignore
      }
    });
}

async function handleCallbackQuery(params: {
  router: GatewayRouter;
  config: AppConfig;
  botApi: Api;
  callback: any;
}): Promise<void> {
  const data = String(params.callback.data ?? '');

  // Always answer quickly so the Telegram client doesn't hang.
  try {
    await params.botApi.answerCallbackQuery(params.callback.id, {
      text: 'Processing...',
      show_alert: false,
    });
  } catch {
    // ignore
  }

  try {
    if (!data.startsWith('acpperm:')) return;

    const parts = data.split(':');
    const sessionKey = parts[1] ?? '';
    const requestId = parts[2] ?? '';
    const decision = parts[3] ?? '';

    if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
      return;
    }

    const actorUserId = String(params.callback.from?.id ?? '');

    log.info('telegram permission click', {
      actorUserId,
      sessionKey,
      requestId,
      decision,
    });

    const res = await params.router.handlePermissionUi({
      platform: 'telegram',
      sessionKey,
      requestId,
      decision,
      actorUserId,
    });

    log.info('telegram permission result', {
      ok: res.ok,
      message: res.message,
    });

    const msg = params.callback.message;
    if (msg) {
      const emoji = decision === 'allow' ? '👍' : '👎';
      void setMessageReaction(
        params.config.telegramToken!,
        {
          chatId: Number(msg.chat.id),
          messageId: Number(msg.message_id),
          emoji,
          isBig: false,
        },
        fetch,
      ).catch(() => {
        // ignore
      });

      if (res.ok) {
        try {
          await params.botApi.editMessageReplyMarkup(Number(msg.chat.id), Number(msg.message_id), {
            reply_markup: { inline_keyboard: [] },
          } as any);
        } catch {
          // ignore
        }
      }

      try {
        await params.botApi.sendMessage(Number(msg.chat.id), res.message, {
          message_thread_id: msg.message_thread_id ?? undefined,
        });
      } catch (error) {
        log.error('Telegram permission reply error', error);
      }
    }
  } catch (error) {
    log.error('Telegram callback handler error', error);
  }
}

function createTelegramCommandSink(
  botApi: Api,
  params: { chatId: number; threadId: number | null },
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
      await botApi.sendMessage(params.chatId, out, {
        message_thread_id: params.threadId ?? undefined,
      });
    },
    sendUi: async (event) => {
      const header = `[${event.kind}] ${event.title}`;
      const body = event.detail && event.mode === 'verbose' ? `\n\n${event.detail}` : '';
      await botApi.sendMessage(params.chatId, `${header}${body}`, {
        message_thread_id: params.threadId ?? undefined,
      });
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
