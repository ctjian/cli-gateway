import { InlineKeyboard, type Bot } from 'grammy';

import type { OutboundSink } from '../gateway/router.js';
import type { PermissionUiRequest, UiEvent } from '../gateway/types.js';
import { createBufferedSink } from './bufferedSink.js';

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_SEND_RETRY_DELAY_MS = 250;

type ToolUiEvent = Extract<UiEvent, { kind: 'tool' }>;
type TelegramPermissionCallbackData = {
  allowData: string;
  allowAlwaysData?: string;
  denyData: string;
};
type BuildTelegramPermissionCallbackData = (
  req: PermissionUiRequest,
) => TelegramPermissionCallbackData;

export function createTelegramSink(
  bot: Bot,
  _token: string,
  chatId: number,
  threadId: number | null,
  userId: string,
  opts?: {
    flushIntervalMs?: number;
    buildPermissionCallbackData?: BuildTelegramPermissionCallbackData;
  },
): OutboundSink & { flush: () => Promise<void> } {
  const isPrivateChat = chatId > 0;
  const toolUiMessageById = new Map<string, number>();
  let toolUiFallbackSeq = 0;
  const buildPermissionCallbackData =
    opts?.buildPermissionCallbackData ?? defaultTelegramPermissionCallbackData;

  if (!isPrivateChat) {
    const buffered = createBufferedSink({
      maxLen: 3800,
      flushIntervalMs: 700,
      send: async (text) => {
        const msg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: threadId ?? undefined,
        });
        return { id: String(msg.message_id) };
      },
      edit: async (id, text) => {
        // grammY typings currently don't expose message_thread_id for editMessageText.
        await bot.api.editMessageText(chatId, Number(id), text, {
          ...(threadId ? ({ message_thread_id: threadId } as any) : {}),
        });
      },
    });

    return {
      sendAgentText: buffered.sendText,
      sendText: buffered.sendText,
      breakTextStream: buffered.breakMessage,
      flush: buffered.flush,
      getDeliveryState: buffered.getState,
      requestPermission: async (req) => {
        const { allowData, allowAlwaysData, denyData } = buildPermissionCallbackData(req);

        const keyboard = new InlineKeyboard().text('✅ Once', allowData);
        if (allowAlwaysData) {
          keyboard.text('🔓 Always', allowAlwaysData);
        }
        keyboard.text('❌ Deny', denyData);

        const toolKind = req.toolKind ? ` (${req.toolKind})` : '';
        const reqShort = String(req.requestId ?? '').slice(0, 8) || 'unknown';
        const text = [
          `Permission: ${req.toolTitle}${toolKind}`,
          req.debugHint ? `debug: ${req.debugHint}` : '',
          `request=${reqShort}`,
          `Only user ${userId} can approve.`,
        ]
          .filter(Boolean)
          .join('\n');

        await bot.api.sendMessage(chatId, escapeHtml(text), {
          message_thread_id: threadId ?? undefined,
          reply_markup: keyboard,
          parse_mode: 'HTML',
        });
      },
      sendUi: async (event) => {
        if (event.kind === 'tool') {
          await upsertToolUiMessage({
            bot,
            chatId,
            threadId,
            event,
            toolUiMessageById,
            nextFallbackKey: () => `tool:${++toolUiFallbackSeq}`,
          });
          return;
        }

        const safeTitle = truncate(event.title, 500);
        const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(safeTitle)}`;

        if (event.detail && event.mode === 'verbose') {
          await sendTelegramHtmlCodeChunks(
            bot,
            chatId,
            threadId,
            header,
            event.detail,
            3200,
          );
          return;
        }

        await bot.api.sendMessage(chatId, header, {
          message_thread_id: threadId ?? undefined,
          parse_mode: 'HTML',
        });
      },
    };
  }

  // Private chat path: stream assistant text by editing one message.
  const agentBuffered = createBufferedSink({
    maxLen: 3800,
    flushIntervalMs: opts?.flushIntervalMs ?? 650,
    send: async (text) => {
      const msg = await sendTelegramMessageWithRetry(bot, chatId, threadId, text);
      return { id: String(msg.message_id) };
    },
    edit: async (id, text) => {
      await editTelegramMessageWithRetry(bot, chatId, threadId, id, text);
    },
  });
  return {
    sendAgentText: agentBuffered.sendText,
    breakTextStream: agentBuffered.breakMessage,
    sendText: async (delta: string) => {
      if (!delta.trim()) return;
      await sendTelegramTextChunks(bot, chatId, threadId, delta);
    },
    flush: async () => {
      await agentBuffered.flush();
    },
    getDeliveryState: agentBuffered.getState,
    requestPermission: async (req) => {
      const { allowData, allowAlwaysData, denyData } = buildPermissionCallbackData(req);

      const keyboard = new InlineKeyboard().text('✅ Once', allowData);
      if (allowAlwaysData) {
        keyboard.text('🔓 Always', allowAlwaysData);
      }
      keyboard.text('❌ Deny', denyData);

      const toolKind = req.toolKind ? ` (${req.toolKind})` : '';
      const reqShort = String(req.requestId ?? '').slice(0, 8) || 'unknown';
      const msgText = [
        `Permission: ${req.toolTitle}${toolKind}`,
        req.debugHint ? `debug: ${req.debugHint}` : '',
        `request=${reqShort}`,
        `Only user ${userId} can approve.`,
      ]
        .filter(Boolean)
        .join('\n');

      await bot.api.sendMessage(chatId, escapeHtml(msgText), {
        message_thread_id: threadId ?? undefined,
        reply_markup: keyboard,
        parse_mode: 'HTML',
      });
    },
    sendUi: async (event) => {
      if (event.kind === 'tool') {
        await upsertToolUiMessage({
          bot,
          chatId,
          threadId,
          event,
          toolUiMessageById,
          nextFallbackKey: () => `tool:${++toolUiFallbackSeq}`,
        });
        return;
      }

      const safeTitle = truncate(event.title, 500);
      const header = `<b>[${escapeHtml(event.kind)}]</b> ${escapeHtml(safeTitle)}`;

      if (event.detail && event.mode === 'verbose') {
        await sendTelegramHtmlCodeChunks(
          bot,
          chatId,
          threadId,
          header,
          event.detail,
          3200,
        );
        return;
      }

      await bot.api.sendMessage(chatId, header, {
        message_thread_id: threadId ?? undefined,
        parse_mode: 'HTML',
      });
    },
  };
}

async function upsertToolUiMessage(params: {
  bot: Bot;
  chatId: number;
  threadId: number | null;
  event: ToolUiEvent;
  toolUiMessageById: Map<string, number>;
  nextFallbackKey: () => string;
}): Promise<void> {
  const key = params.event.toolCallId?.trim() || params.nextFallbackKey();
  const text = formatToolUiText(params.event);
  const existingId = params.toolUiMessageById.get(key);

  if (!existingId) {
    const msg = await params.bot.api.sendMessage(params.chatId, text, {
      message_thread_id: params.threadId ?? undefined,
      parse_mode: 'HTML',
    });
    params.toolUiMessageById.set(key, msg.message_id);
    return;
  }

  try {
    await params.bot.api.editMessageText(params.chatId, existingId, text, {
      ...(params.threadId ? ({ message_thread_id: params.threadId } as any) : {}),
      parse_mode: 'HTML',
    });
  } catch {
    const msg = await params.bot.api.sendMessage(params.chatId, text, {
      message_thread_id: params.threadId ?? undefined,
      parse_mode: 'HTML',
    });
    params.toolUiMessageById.set(key, msg.message_id);
  }
}

function formatToolUiText(event: ToolUiEvent): string {
  const header = `[tool] ${truncate(event.title, 500)}`;
  const content =
    event.detail && event.mode === 'verbose'
      ? `${header}\n\n${event.detail}`
      : header;
  const code = escapeHtml(truncate(content, 3300));
  return `<pre><code>${code}</code></pre>`;
}

function defaultTelegramPermissionCallbackData(
  req: PermissionUiRequest,
): TelegramPermissionCallbackData {
  return {
    allowData: `acpperm:${req.sessionKey}:${req.requestId}:allow`,
    allowAlwaysData: `acpperm:${req.sessionKey}:${req.requestId}:allow_prefix`,
    denyData: `acpperm:${req.sessionKey}:${req.requestId}:deny`,
  };
}

function splitTelegramMessageChunks(text: string, maxLen = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = String(text ?? '').trim();

  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;

    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);

    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

async function sendTelegramTextChunks(
  bot: Bot,
  chatId: number,
  threadId: number | null,
  text: string,
): Promise<void> {
  const chunks = splitTelegramMessageChunks(text, TELEGRAM_TEXT_LIMIT);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await sendTelegramMessageWithRetry(bot, chatId, threadId, chunk);
  }
}

async function sendTelegramHtmlCodeChunks(
  bot: Bot,
  chatId: number,
  threadId: number | null,
  headerHtml: string,
  detailText: string,
  bodyMaxLen = 3200,
): Promise<void> {
  const chunks = splitTelegramMessageChunks(detailText, bodyMaxLen);
  if (!chunks.length) {
    await sendTelegramMessageWithRetry(bot, chatId, threadId, headerHtml, {
      parse_mode: 'HTML',
    });
    return;
  }

  for (const chunk of chunks) {
    const code = escapeHtml(chunk);
    await sendTelegramMessageWithRetry(
      bot,
      chatId,
      threadId,
      `${headerHtml}\n\n<pre><code>${code}</code></pre>`,
      {
        parse_mode: 'HTML',
      },
    );
  }
}

async function sendTelegramMessageWithRetry(
  bot: Bot,
  chatId: number,
  threadId: number | null,
  text: string,
  extra?: Record<string, unknown>,
): Promise<{ message_id: number }> {
  const payload = {
    message_thread_id: threadId ?? undefined,
    ...(extra ?? {}),
  };

  try {
    return await bot.api.sendMessage(chatId, text, payload as any);
  } catch {
    await sleep(TELEGRAM_SEND_RETRY_DELAY_MS);
    return await bot.api.sendMessage(chatId, text, payload as any);
  }
}

async function editTelegramMessageWithRetry(
  bot: Bot,
  chatId: number,
  threadId: number | null,
  messageId: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const payload = {
    ...(threadId ? ({ message_thread_id: threadId } as any) : {}),
    ...(extra ?? {}),
  };

  try {
    await bot.api.editMessageText(chatId, Number(messageId), text, payload);
  } catch (error) {
    if (isNoopEditError(error)) return;
    await sleep(TELEGRAM_SEND_RETRY_DELAY_MS);
    await bot.api.editMessageText(chatId, Number(messageId), text, payload);
  }
}

function isNoopEditError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  const lowered = message.toLowerCase();

  return (
    lowered.includes('message is not modified') ||
    lowered.includes('message not modified') ||
    lowered.includes('content must be different')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
