import type {
  GatewayRouter,
  OutboundSink,
  UserResource,
} from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import {
  SHARED_CHAT_SCOPE_USER_ID,
  type ConversationKey,
} from '../gateway/sessionStore.js';
import {
  QQ_ROUTE_C2C,
  QQ_ROUTE_CHANNEL,
  QQClient,
  type QQMessageAttachment,
  type QQMessageEvent,
} from './qqClient.js';
import { createQQSink } from './qqSink.js';

export type QQController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
  ) => OutboundSink & { flush: () => Promise<void> };
  close: () => Promise<void>;
};

/* c8 ignore start */
export async function startQQ(
  router: GatewayRouter,
  config: AppConfig,
): Promise<QQController | null> {
  if (!config.qqAppId || !config.qqClientSecret) {
    log.info('QQ disabled: missing QQ app id/client secret');
    return null;
  }

  const client = new QQClient({
    appId: config.qqAppId,
    clientSecret: config.qqClientSecret,
    sandbox: config.qqSandbox,
  });

  client.on('ready', () => {
    log.info('QQ connected', { sandbox: config.qqSandbox });
  });
  client.on('reconnecting', () => {
    log.warn('QQ reconnecting');
  });
  client.on('disconnected', (info) => {
    log.warn('QQ disconnected', info);
  });
  client.on('error', (error) => {
    log.error('QQ client error', error);
  });

  client.on('c2c_message', (message) => {
    dispatchQQInbound(router, client, message, QQ_ROUTE_C2C);
  });
  client.on('at_message', (message) => {
    dispatchQQInbound(router, client, message, QQ_ROUTE_CHANNEL);
  });

  await client.connect();

  return {
    createSink: (chatId, threadId, userId) => {
      const routeKind = parseQQRouteKind(threadId);
      if (!routeKind) {
        throw new Error(`Unsupported QQ route kind: ${threadId ?? '(null)'}`);
      }
      return createQQSink({ client, routeKind, chatId, userId });
    },
    close: () => client.close(),
  };
}
/* c8 ignore end */

export function dispatchQQInbound(
  router: GatewayRouter,
  client: QQClient,
  message: QQMessageEvent,
  routeKind: typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL,
): void {
  const inbound = normalizeQQInboundMessage(message, routeKind);
  if (!inbound) return;

  const sink = createQQSink({
    client,
    routeKind,
    chatId: inbound.sinkChatId,
    userId: inbound.key.userId,
  });

  void router
    .handleUserMessage(inbound.key, inbound.text, sink, {
      resources: inbound.resources,
    })
    .catch((error) => {
      log.error('QQ router handler error', error);
    });
}

export function normalizeQQInboundMessage(
  message: QQMessageEvent,
  routeKind: typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL,
): {
  key: ConversationKey;
  text: string;
  resources: UserResource[];
  sinkChatId: string;
} | null {
  const resources = extractQQImageResources(message.attachments);
  const text = normalizeQQInboundText(message.content ?? '', routeKind);

  if (routeKind === QQ_ROUTE_C2C) {
    const openId = extractQQUserId(message.author);
    if (!openId) return null;
    if (!text && resources.length === 0) return null;

    return {
      key: {
        platform: 'qq',
        chatId: openId,
        threadId: QQ_ROUTE_C2C,
        userId: openId,
        scopeUserId: null,
      },
      text,
      resources,
      sinkChatId: openId,
    };
  }

  const channelId = String(message.channel_id ?? '').trim();
  const userId = extractQQUserId(message.author);
  if (!channelId || !userId) return null;
  if (!text && resources.length === 0) return null;

  return {
    key: {
      platform: 'qq',
      chatId: channelId,
      threadId: QQ_ROUTE_CHANNEL,
      userId,
      scopeUserId: SHARED_CHAT_SCOPE_USER_ID,
    },
    text,
    resources,
    sinkChatId: channelId,
  };
}

export function normalizeQQInboundText(
  raw: string,
  routeKind: typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL,
): string {
  const text = String(raw ?? '');
  if (routeKind === QQ_ROUTE_C2C) {
    return text.trim();
  }

  let stripped = text;
  for (;;) {
    const next = stripped.replace(/^\s*<@[^>]+>\s*/u, '');
    if (next === stripped) break;
    stripped = next;
  }

  return stripped.trim();
}

export function extractQQImageResources(
  attachments: QQMessageAttachment[] | undefined,
): UserResource[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const out: UserResource[] = [];
  const seen = new Set<string>();

  for (const attachment of attachments) {
    if (!isQQImageAttachment(attachment)) continue;

    const uri = normalizeQQResourceUri(attachment.url ?? attachment.tencent_url ?? '');
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);

    const mimeType = normalizeQQImageMimeType(attachment.content_type);
    out.push({
      uri,
      mimeType,
    });
  }

  return out;
}

export function parseQQRouteKind(
  threadId: string | null,
): typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL | null {
  if (threadId === QQ_ROUTE_C2C || threadId === QQ_ROUTE_CHANNEL) {
    return threadId;
  }
  return null;
}

function extractQQUserId(author: QQMessageEvent['author']): string {
  return String(author?.user_openid ?? author?.id ?? '').trim();
}

function normalizeQQImageMimeType(contentType: string | undefined): string {
  const normalized = String(contentType ?? '').trim().toLowerCase();
  if (normalized.startsWith('image/')) return normalized;
  return 'image/*';
}

function normalizeQQResourceUri(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return '';
}

function isQQImageAttachment(attachment: QQMessageAttachment): boolean {
  const contentType = String(attachment.content_type ?? '').trim().toLowerCase();
  if (contentType === 'image' || contentType.startsWith('image/')) return true;

  const name = String(
    attachment.file_name ?? attachment.filename ?? attachment.url ?? attachment.tencent_url ?? '',
  ).trim().toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|heic)(?:\?|$)/u.test(name);
}
