import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';

import type {
  CliInlineCommand,
  GatewayRouter,
  OutboundSink,
  UserResource,
} from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { PermissionUiRequest } from '../gateway/types.js';
import {
  SHARED_CHAT_SCOPE_USER_ID,
  type ConversationKey,
} from '../gateway/sessionStore.js';
import {
  listTelegramBuiltinCommands,
  localizeInlineCommandDescription,
  toTelegramCommandName,
} from '../gateway/commandCatalog.js';
import { createTelegramSink } from './telegramSink.js';
import { setChatMenuButton, sendChatAction } from './telegramApi.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
  ) => OutboundSink & { flush: () => Promise<void> };
};

const TELEGRAM_PERMISSION_CALLBACK_PREFIX = 'acpperm';
const TELEGRAM_PERMISSION_CALLBACK_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 650;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;
const TELEGRAM_TEXT_LIMIT = 4096;

type TelegramPermissionDecision = 'allow' | 'allow_prefix' | 'deny';
export type ParsedTelegramPermissionCallbackData =
  | {
      kind: 'token';
      token: string;
      decision: TelegramPermissionDecision;
    }
  | {
      kind: 'legacy';
      sessionKey: string;
      requestId: string;
      decision: TelegramPermissionDecision;
    };
type PendingTelegramPermission = {
  sessionKey: string;
  requestId: string;
  actorUserId: string;
  createdAt: number;
};


type PendingTelegramMediaGroup = {
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  mediaGroupId: string;
  texts: string[];
  resources: UserResource[];
  messageIds: number[];
  flushTimer: ReturnType<typeof setTimeout> | null;
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
  const pendingMediaGroups = new Map<string, PendingTelegramMediaGroup>();
  const pendingPermissions = new Map<string, PendingTelegramPermission>();

  const tgCommands = listTelegramBuiltinCommands();

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

  const buildPermissionCallbackDataForActor =
    (actorUserId: string) =>
    (req: PermissionUiRequest) =>
      createTelegramPermissionCallbackData({
        req,
        actorUserId,
        pendingPermissions,
      });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';

    // Always answer quickly so the client doesn't spin.
    try {
      await ctx.answerCallbackQuery({ text: 'Processing...', show_alert: false });
    } catch {
      // ignore
    }

    const parsed = parseTelegramPermissionCallbackData(data);
    if (!parsed) return;

    let res: { ok: boolean; message: string } = {
      ok: false,
      message: 'Permission request expired.',
    };
    let shouldClearMarkup = false;

    try {
      const actorUserId = String(ctx.from?.id ?? '');

      if (parsed.kind === 'token') {
        pruneExpiredTelegramPermissions(pendingPermissions);
        const pending = pendingPermissions.get(parsed.token);

        if (!pending) {
          shouldClearMarkup = true;
        } else if (
          isTelegramPermissionActorRestricted(pending.actorUserId) &&
          pending.actorUserId !== actorUserId
        ) {
          res = { ok: false, message: 'Not authorized.' };
        } else {
          res = await router.handlePermissionUi({
            platform: 'telegram',
            sessionKey: pending.sessionKey,
            requestId: pending.requestId,
            decision: parsed.decision,
            actorUserId,
          });

          shouldClearMarkup = shouldFinalizeTelegramPermissionResult(res);
          if (shouldClearMarkup) {
            pendingPermissions.delete(parsed.token);
          }
        }
      } else {
        res = await router.handlePermissionUi({
          platform: 'telegram',
          sessionKey: parsed.sessionKey,
          requestId: parsed.requestId,
          decision: parsed.decision,
          actorUserId,
        });
        shouldClearMarkup = shouldFinalizeTelegramPermissionResult(res);
      }

      const msg = ctx.callbackQuery.message;
      if (msg && shouldClearMarkup) {
        try {
          await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          // ignore
        }
      }

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

  bot.on('message', async (ctx) => {
    try {
      const message = ctx.message as any;
      const rawText = extractTelegramInboundText(message);
      const resources = await extractTelegramImageResources(
        bot,
        config.telegramToken,
        message,
      );
      const mediaGroupId = extractTelegramMediaGroupId(message);

      if (mediaGroupId) {
        queueTelegramMediaGroup({
          pendingMediaGroups,
          groupKey: `${ctx.chat.id}:${mediaGroupId}`,
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          userId: String(ctx.from?.id ?? 'unknown'),
          fromId: ctx.from?.id,
          threadId: message.message_thread_id
            ? String(message.message_thread_id)
            : null,
          mediaGroupId,
          rawText,
          resources,
          messageId: Number(message.message_id),
          flush: (group) =>
            dispatchTelegramInbound({
              bot,
              router,
              config,
              tgCommands,
              chatCommandSignatures,
              pendingPermissions,
              chatId: group.chatId,
              chatType: group.chatType,
              userId: group.userId,
              fromId: group.fromId,
              threadId: group.threadId,
              rawText: mergeTelegramTexts(group.texts),
              resources: dedupeTelegramResources(group.resources),
              mediaGroupId: group.mediaGroupId,
            }),
        });
        return;
      }

      if (!rawText.trim() && resources.length === 0) return;
      dispatchTelegramInbound({
        bot,
        router,
        config,
        tgCommands,
        chatCommandSignatures,
        pendingPermissions,
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        userId: String(ctx.from?.id ?? 'unknown'),
        fromId: ctx.from?.id,
        threadId: message.message_thread_id
          ? String(message.message_thread_id)
          : null,
        rawText,
        resources,
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
        {
          buildPermissionCallbackData: buildPermissionCallbackDataForActor(userId),
        },
      ),
  };
}

function queueTelegramMediaGroup(params: {
  pendingMediaGroups: Map<string, PendingTelegramMediaGroup>;
  groupKey: string;
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  mediaGroupId: string;
  rawText: string;
  resources: UserResource[];
  messageId: number;
  flush: (group: PendingTelegramMediaGroup) => void;
}): void {
  const {
    pendingMediaGroups,
    groupKey,
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    mediaGroupId,
    rawText,
    resources,
    messageId,
    flush,
  } = params;

  const pending = pendingMediaGroups.get(groupKey) ?? {
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    mediaGroupId,
    texts: [],
    resources: [],
    messageIds: [],
    flushTimer: null,
  };

  if (rawText.trim()) {
    pending.texts.push(rawText.trim());
  }
  if (resources.length > 0) {
    pending.resources.push(...resources);
  }
  pending.messageIds.push(messageId);

  if (pending.flushTimer) {
    clearTimeout(pending.flushTimer);
  }

  pending.flushTimer = setTimeout(() => {
    const current = pendingMediaGroups.get(groupKey);
    if (!current) return;

    pendingMediaGroups.delete(groupKey);
    if (current.flushTimer) {
      clearTimeout(current.flushTimer);
      current.flushTimer = null;
    }

    flush(current);
  }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);

  pendingMediaGroups.set(groupKey, pending);
}

function dispatchTelegramInbound(params: {
  bot: Bot;
  router: GatewayRouter;
  config: AppConfig;
  tgCommands: Array<{ command: string; description: string }>;
  chatCommandSignatures: Map<number, string>;
  pendingPermissions: Map<string, PendingTelegramPermission>;
  chatId: number;
  chatType: string;
  userId: string;
  fromId?: number;
  threadId: string | null;
  rawText: string;
  resources: UserResource[];
  mediaGroupId?: string;
}): void {
  const {
    bot,
    router,
    config,
    tgCommands,
    chatCommandSignatures,
    pendingPermissions,
    chatId,
    chatType,
    userId,
    fromId,
    threadId,
    rawText,
    resources,
    mediaGroupId,
  } = params;
  const normalizedResources = dedupeTelegramResources(resources);

  if (!rawText.trim() && normalizedResources.length === 0) return;

  log.info('telegram inbound message', {
    chatId,
    fromId,
    text: rawText.slice(0, 120),
    imageCount: normalizedResources.length,
    mediaGroupId,
    groupedMessageCount: 0,
  });

  // Per-chat: ensure menu button is commands.
  void setChatMenuButton(config.telegramToken, { chatId }, fetch).catch(() => {
    // ignore
  });

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: String(chatId),
    threadId,
    userId,
    scopeUserId: chatType === 'private' ? null : SHARED_CHAT_SCOPE_USER_ID,
  };

  const inlineCommands = router.listCliInlineCommands(key);

  // Keep Telegram chat-scope command menu in sync with CLI inline commands.
  void syncTelegramCommandsForChat({
    bot,
    chatId,
    baseCommands: tgCommands,
    inlineCommands,
    signatures: chatCommandSignatures,
  }).catch(() => {
    // ignore
  });

  // /start should show help, not fall through to the agent.
  const remapped = remapTelegramInlineCommand(rawText, inlineCommands);
  const normalizedText = remapped.startsWith('/start') ? '/help' : remapped;
  const isCommand = normalizedText.startsWith('/');
  const shouldEnableTyping =
    !isCommand || !isFastTelegramLocalCommand(normalizedText);

  const sink = isCommand
    ? createTelegramCommandSink(
        bot,
        chatId,
        threadId ? Number(threadId) : null,
        userId,
        (req) =>
          createTelegramPermissionCallbackData({
            req,
            actorUserId: userId,
            pendingPermissions,
          }),
      )
    : createTelegramSink(
        bot,
        config.telegramToken,
        chatId,
        threadId ? Number(threadId) : null,
        userId,
        {
          buildPermissionCallbackData: (req) =>
            createTelegramPermissionCallbackData({
              req,
              actorUserId: userId,
              pendingPermissions,
            }),
        },
      );

  const stopTyping = startTelegramTyping({
    token: config.telegramToken,
    chatId,
    threadId: threadId ? Number(threadId) : null,
    enabled: shouldEnableTyping,
  });

  // IMPORTANT: do not await; grammY processes updates sequentially.
  const p = router.handleUserMessage(
    key,
    normalizedText,
    sink,
    isCommand ? undefined : { resources: normalizedResources },
  );

  void p
    .then(async () => {
      stopTyping();

      // Commands may change after this run (available_commands_update).
      void syncTelegramCommandsForChat({
        bot,
        chatId,
        baseCommands: tgCommands,
        inlineCommands: router.listCliInlineCommands(key),
        signatures: chatCommandSignatures,
      }).catch(() => {
        // ignore
      });
    })
    .catch(async (error) => {
      stopTyping();
      log.error('Telegram router handler error', error);
    });
}

async function sendTelegramTyping(params: {
  token: string;
  chatId: number;
  threadId: number | null;
  enabled: boolean;
}): Promise<void> {
  try {
    await sendChatAction(
      params.token,
      {
        chatId: params.chatId,
        threadId: params.threadId,
        action: 'typing',
      },
      fetch,
    );
  } catch (error) {
    log.debug('Telegram typing indicator error', error);
  }
}

function startTelegramTyping(params: {
  token: string;
  chatId: number;
  threadId: number | null;
  enabled: boolean;
}): () => void {
  if (!params.enabled) return () => {};

  let stopped = false;

  void sendTelegramTyping(params);

  const timer = setInterval(() => {
    if (stopped) return;
    void sendTelegramTyping(params);
  }, TELEGRAM_TYPING_INTERVAL_MS);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

async function startLongPolling(bot: Bot): Promise<void> {
  let firstBoot = true;

  for (;;) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: firstBoot });
    } catch (err) {
      log.warn('Telegram deleteWebhook error', err);
    }

    log.info('Telegram long polling start', {
      allowedUpdates: ['message', 'callback_query'],
      dropPendingUpdates: firstBoot,
    });

    try {
      await bot.start({
        allowed_updates: ['message', 'callback_query'],
      });
      log.warn('Telegram polling stopped; restarting in 2s');
    } catch (err) {
      log.error('Telegram polling error; restarting in 2s', err);
    }

    firstBoot = false;
    await sleep(2000);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseTelegramPermissionCallbackData(
  data: string,
): ParsedTelegramPermissionCallbackData | null {
  if (!data.startsWith(`${TELEGRAM_PERMISSION_CALLBACK_PREFIX}:`)) return null;

  const parts = data.split(':');
  if (parts.length !== 4) return null;

  if (parts[1] === 't') {
    const token = parts[2] ?? '';
    const decision = shortTelegramPermissionDecision(parts[3]);
    if (!token || !decision) return null;
    return { kind: 'token', token, decision };
  }

  const sessionKey = parts[1] ?? '';
  const requestId = parts[2] ?? '';
  const decision = longTelegramPermissionDecision(parts[3]);
  if (!sessionKey || !requestId || !decision) return null;
  return { kind: 'legacy', sessionKey, requestId, decision };
}

function createTelegramPermissionCallbackData(params: {
  req: PermissionUiRequest;
  actorUserId: string;
  pendingPermissions: Map<string, PendingTelegramPermission>;
}): { allowData: string; allowAlwaysData: string; denyData: string } {
  pruneExpiredTelegramPermissions(params.pendingPermissions);

  const token = createTelegramPermissionToken();
  params.pendingPermissions.set(token, {
    sessionKey: params.req.sessionKey,
    requestId: params.req.requestId,
    actorUserId: params.actorUserId,
    createdAt: Date.now(),
  });

  return {
    allowData: `${TELEGRAM_PERMISSION_CALLBACK_PREFIX}:t:${token}:a`,
    allowAlwaysData: `${TELEGRAM_PERMISSION_CALLBACK_PREFIX}:t:${token}:p`,
    denyData: `${TELEGRAM_PERMISSION_CALLBACK_PREFIX}:t:${token}:d`,
  };
}

function createTelegramPermissionToken(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20);
}

function pruneExpiredTelegramPermissions(
  pendingPermissions: Map<string, PendingTelegramPermission>,
): void {
  if (pendingPermissions.size === 0) return;

  const expiresBefore = Date.now() - TELEGRAM_PERMISSION_CALLBACK_TTL_MS;
  for (const [token, pending] of pendingPermissions.entries()) {
    if (pending.createdAt >= expiresBefore) continue;
    pendingPermissions.delete(token);
  }
}

function shouldFinalizeTelegramPermissionResult(res: {
  ok: boolean;
  message: string;
}): boolean {
  if (res.ok) return true;
  return [
    'Permission request expired.',
    'No pending permission request.',
    'No active runtime. Send a message first.',
    'Unknown session binding.',
  ].includes(res.message);
}

function isTelegramPermissionActorRestricted(actorUserId: string): boolean {
  const normalized = actorUserId.trim();
  return normalized !== '' && normalized !== 'unknown';
}

function shortTelegramPermissionDecision(
  raw: string,
): TelegramPermissionDecision | null {
  if (raw === 'a') return 'allow';
  if (raw === 'p') return 'allow_prefix';
  if (raw === 'A') return 'allow_prefix'; // backward compatibility
  if (raw === 'd') return 'deny';
  return null;
}

function longTelegramPermissionDecision(
  raw: string,
): TelegramPermissionDecision | null {
  if (raw === 'allow' || raw === 'allow_prefix' || raw === 'deny') return raw;
  if (raw === 'allow_always') return 'allow_prefix'; // backward compatibility
  return null;
}

export function remapTelegramInlineCommand(
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

function extractTelegramInboundText(message: any): string {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.caption === 'string') return message.caption;
  return '';
}

function extractTelegramMediaGroupId(message: any): string | null {
  const raw = message?.media_group_id;
  if (raw === null || raw === undefined) return null;
  const id = String(raw).trim();
  return id || null;
}

function mergeTelegramTexts(texts: string[]): string {
  if (texts.length === 0) return '';

  const out: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const normalized = String(text ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out.join('\n');
}

function dedupeTelegramResources(resources: UserResource[]): UserResource[] {
  if (resources.length === 0) return [];

  const out: UserResource[] = [];
  const seen = new Set<string>();

  for (const item of resources) {
    const uri = String(item?.uri ?? '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({
      uri,
      mimeType: item?.mimeType?.trim() || undefined,
    });
  }

  return out;
}

function dedupeTelegramMessageIds(ids: number[]): number[] {
  if (ids.length === 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();

  for (const item of ids) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

async function extractTelegramImageResources(
  bot: Bot,
  token: string,
  message: any,
): Promise<UserResource[]> {
  const out: UserResource[] = [];
  const seen = new Set<string>();

  const addByFileId = async (
    fileId: string | undefined,
    mimeType: string | undefined,
  ): Promise<void> => {
    if (!fileId) return;
    try {
      const file = await bot.api.getFile(fileId);
      const filePath = String((file as any)?.file_path ?? '').trim();
      if (!filePath) return;
      const uri = `https://api.telegram.org/file/bot${token}/${filePath}`;
      if (seen.has(uri)) return;
      seen.add(uri);
      out.push({ uri, mimeType: mimeType?.trim() || undefined });
    } catch (error) {
      log.warn('telegram getFile(image) error', error);
    }
  };

  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length > 0) {
    const weight = (item: any): number => {
      const fileSize = Number(item?.file_size ?? 0);
      if (Number.isFinite(fileSize) && fileSize > 0) return fileSize;
      const width = Number(item?.width ?? 0);
      const height = Number(item?.height ?? 0);
      return Math.max(0, width * height);
    };

    const best = photos
      .slice()
      .sort((a: any, b: any) => weight(a) - weight(b))
      .at(-1);
    await addByFileId(best?.file_id, 'image/jpeg');
  }

  const document = message?.document;
  if (
    document?.file_id &&
    typeof document?.mime_type === 'string' &&
    document.mime_type.toLowerCase().startsWith('image/')
  ) {
    await addByFileId(document.file_id, document.mime_type);
  }

  return out;
}

export async function syncTelegramCommandsForChat(params: {
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
      description: formatTelegramInlineDescription(item),
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

function formatTelegramInlineDescription(item: CliInlineCommand): string {
  const command = toTelegramCommandName(item.name) ?? item.name;
  const canonical = command !== item.name ? ` -> /${item.name}` : '';
  const desc = localizeInlineCommandDescription(item.name, item.description);
  return truncateTelegramDescription(`cli-inline /${command}${canonical}: ${desc}`);
}

function truncateTelegramDescription(text: string): string {
  const trimmed = text.trim() || 'cli-inline 命令';
  if (trimmed.length <= 256) return trimmed;
  return trimmed.slice(0, 253) + '...';
}

function isFastTelegramLocalCommand(text: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] ?? '').toLowerCase();
  const at = first.indexOf('@');
  const cmd = at > 1 && first.startsWith('/') ? first.slice(0, at) : first;
  const sub = parts[1] ?? '';

  if (cmd === '/help' || cmd === '/start' || cmd === '/ui') return true;

  if (cmd === '/cli') {
    return !sub || sub === 'show';
  }

  if (cmd === '/whitelist' || cmd === '/wl') {
    return !sub || sub === 'list' || sub === 'show';
  }

  if (cmd === '/trust') {
    return !sub || sub === 'status' || sub === 'show';
  }

  if (cmd === '/cron') {
    return !sub || sub === 'help' || sub === 'list';
  }

  return false;
}

export function splitTelegramMessageChunks(
  text: string,
  maxLen = TELEGRAM_TEXT_LIMIT,
): string[] {
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

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function createTelegramCommandSink(
  bot: Bot,
  chatId: number,
  threadId: number | null,
  userId: string,
  buildPermissionCallbackData: (req: PermissionUiRequest) => {
    allowData: string;
    allowAlwaysData?: string;
    denyData: string;
  },
): OutboundSink & { flush: () => Promise<void> } {
  let text = '';

  const sendChunkWithRetry = async (chunk: string): Promise<void> => {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        message_thread_id: threadId ?? undefined,
      });
      return;
    } catch (error) {
      log.warn('telegram command chunk send failed (attempt 1)', error);
    }

    await sleep(250);
    await bot.api.sendMessage(chatId, chunk, {
      message_thread_id: threadId ?? undefined,
    });
  };

  return {
    sendText: async (delta: string) => {
      text += delta;
    },
    flush: async () => {
      const out = text.trim();
      if (!out) return;

      const chunks = splitTelegramMessageChunks(out);
      let sentCount = 0;

      for (const chunk of chunks) {
        if (!chunk) continue;
        await sendChunkWithRetry(chunk);
        sentCount += 1;
      }

      if (sentCount >= chunks.length) {
        text = '';
      } else {
        text = chunks.slice(sentCount).join('\n');
      }
    },
    requestPermission: async (req) => {
      const { allowData, allowAlwaysData, denyData } =
        buildPermissionCallbackData(req);
      const keyboard = new InlineKeyboard().text('✅ Once', allowData);
      if (allowAlwaysData) {
        keyboard.text('🔓 Always', allowAlwaysData);
      }
      keyboard.text('❌ Deny', denyData);

      const toolKind = req.toolKind ? ` (${req.toolKind})` : '';
      const prefix =
        req.uiMode === 'summary' ? '[permission]' : 'Permission required:';
      const msgText = `${prefix} ${req.toolTitle}${toolKind}. Only user ${userId} can approve.`;

      await bot.api.sendMessage(chatId, escapeTelegramHtml(msgText), {
        message_thread_id: threadId ?? undefined,
        reply_markup: keyboard,
        parse_mode: 'HTML',
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
