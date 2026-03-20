import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { log } from '../logging.js';

export const QQ_ROUTE_C2C = 'qq:c2c';
export const QQ_ROUTE_CHANNEL = 'qq:channel';

const QQ_INTENTS = {
  AT_MESSAGES: 1 << 25,
  DIRECT_MESSAGE: 1 << 12,
};

const DEFAULT_QQ_INTENTS = QQ_INTENTS.AT_MESSAGES | QQ_INTENTS.DIRECT_MESSAGE;
const QQ_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const QQ_RECONNECT_DELAY_MS = 5_000;
const QQ_DEFAULT_API_BASE = 'https://api.sgroup.qq.com';
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const QQ_TOKEN_ENDPOINT = 'https://bots.qq.com/app/getAppAccessToken';

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

type GatewayInfo = {
  url: string;
};

type GatewayPayload = {
  op?: number;
  t?: string;
  s?: number | null;
  d?: any;
};

export type QQMessageAuthor = {
  id?: string;
  user_openid?: string;
  union_openid?: string;
  bot?: boolean;
};

export type QQMessageAttachment = {
  url?: string;
  tencent_url?: string;
  content_type?: string;
  filename?: string;
  file_name?: string;
};

export type QQMessageEvent = {
  id?: string;
  content?: string;
  channel_id?: string;
  guild_id?: string;
  author?: QQMessageAuthor;
  attachments?: QQMessageAttachment[];
};

type SendMessageOptions = {
  msgId?: string;
  eventId?: string;
};

export class QQClient extends EventEmitter {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly sandbox: boolean;
  private readonly intents: number;

  private tokenCache: TokenCache | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectEnabled = true;
  private seq: number | null = null;
  private heartbeatIntervalMs = 30_000;
  private connectingPromise: Promise<void> | null = null;

  constructor(params: {
    appId: string;
    clientSecret: string;
    sandbox: boolean;
    intents?: number;
  }) {
    super();
    this.appId = params.appId;
    this.clientSecret = params.clientSecret;
    this.sandbox = params.sandbox;
    this.intents = params.intents ?? DEFAULT_QQ_INTENTS;
  }

  async connect(): Promise<void> {
    if (this.connectingPromise) {
      await this.connectingPromise;
      return;
    }

    this.reconnectEnabled = true;
    this.connectingPromise = this.connectOnce().finally(() => {
      this.connectingPromise = null;
    });
    await this.connectingPromise;
  }

  async close(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();

    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    if (
      ws.readyState === WebSocket.CLOSING ||
      ws.readyState === WebSocket.CLOSED
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close(1000, 'Normal closure');
    }).catch(() => {
      // ignore close errors
    });
  }

  async getAccessToken(): Promise<string> {
    const res = await fetch(QQ_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });

    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`qq token error: http=${res.status} body=${JSON.stringify(json)}`);
    }

    const token = String(json?.access_token ?? '').trim();
    const expiresIn = Number(json?.expires_in ?? 0);
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('qq token error: missing access_token/expires_in');
    }

    this.tokenCache = {
      accessToken: token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    return token;
  }

  async ensureValidToken(): Promise<string> {
    if (
      this.tokenCache &&
      Date.now() + QQ_TOKEN_REFRESH_SKEW_MS < this.tokenCache.expiresAtMs
    ) {
      return this.tokenCache.accessToken;
    }

    return this.getAccessToken();
  }

  async getWebSocketInfo(): Promise<GatewayInfo> {
    const token = await this.ensureValidToken();
    const res = await fetch(`${this.apiBase}/gateway/bot`, {
      headers: {
        authorization: `QQBot ${token}`,
      },
    });

    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`qq gateway error: http=${res.status} body=${JSON.stringify(json)}`);
    }

    const url = String(json?.url ?? '').trim();
    if (!url) {
      throw new Error('qq gateway error: missing url');
    }

    return { url };
  }

  async sendText(params: {
    routeKind: typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL;
    chatId: string;
    text: string;
    options?: SendMessageOptions;
  }): Promise<{ id: string }> {
    const route = params.routeKind;
    if (route === QQ_ROUTE_C2C) {
      return this.sendC2CMessage(params.chatId, params.text, params.options);
    }
    return this.sendChannelMessage(params.chatId, params.text, params.options);
  }

  private get apiBase(): string {
    return this.sandbox ? QQ_SANDBOX_API_BASE : QQ_DEFAULT_API_BASE;
  }

  private async connectOnce(): Promise<void> {
    const gateway = await this.getWebSocketInfo();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(gateway.url);
      this.ws = ws;

      ws.once('open', () => {
        settled = true;
        resolve();
      });

      ws.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          this.emit('error', error);
        }
      });

      ws.on('message', (data) => {
        void this.handleMessage(data).catch((error) => this.emit('error', error));
      });

      ws.on('close', (code, reason) => {
        this.ws = null;
        this.stopHeartbeat();
        this.emit('disconnected', { code, reason: reason.toString() });
        if (this.reconnectEnabled && code !== 1000) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    const payload = JSON.parse(data.toString()) as GatewayPayload;
    if (typeof payload.s === 'number') {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case 0:
        this.handleDispatch(payload.t, payload.d);
        return;
      case 10:
        this.heartbeatIntervalMs = Number(payload.d?.heartbeat_interval ?? 30_000);
        await this.authenticate();
        return;
      case 11:
        return;
      default:
        return;
    }
  }

  private async authenticate(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const token = await this.ensureValidToken();
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: 'cli-gateway',
            $device: 'cli-gateway',
          },
        },
      }),
    );
  }

  private handleDispatch(type: string | undefined, data: any): void {
    switch (type) {
      case 'READY':
        this.startHeartbeat();
        this.emit('ready');
        return;
      case 'C2C_MESSAGE_CREATE':
        this.emit('c2c_message', data as QQMessageEvent);
        return;
      case 'AT_MESSAGE_CREATE':
        this.emit('at_message', data as QQMessageEvent);
        return;
      default:
        return;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          op: 1,
          d: this.seq,
        }),
      );
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.emit('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        log.warn('QQ reconnect error', error);
        this.emit('error', error);
      });
    }, QQ_RECONNECT_DELAY_MS);
  }

  private async sendChannelMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ id: string }> {
    return this.sendJson(`/channels/${channelId}/messages`, {
      content: text,
      msg_id: normalizeOptionalString(options?.msgId),
      event_id: normalizeOptionalString(options?.eventId),
    });
  }

  private async sendC2CMessage(
    openId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ id: string }> {
    return this.sendJson(`/v2/users/${openId}/messages`, {
      content: text,
      msg_id: normalizeOptionalString(options?.msgId),
      event_id: normalizeOptionalString(options?.eventId),
    });
  }

  private async sendJson(
    path: string,
    payload: Record<string, string | null>,
  ): Promise<{ id: string }> {
    const token = await this.ensureValidToken();
    const body = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== null),
    );

    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`qq send error: http=${res.status} body=${JSON.stringify(json)}`);
    }

    const id = String(json?.id ?? json?.message?.id ?? '').trim() || 'sent';
    return { id };
  }
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
