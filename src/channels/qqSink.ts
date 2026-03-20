import type { OutboundSink } from '../gateway/router.js';
import { createBufferedSink } from './bufferedSink.js';
import { QQ_ROUTE_C2C, QQ_ROUTE_CHANNEL, type QQClient } from './qqClient.js';

export function createQQSink(params: {
  client: QQClient;
  routeKind: typeof QQ_ROUTE_C2C | typeof QQ_ROUTE_CHANNEL;
  chatId: string;
  userId: string;
}): OutboundSink & { flush: () => Promise<void> } {
  const buffered = createBufferedSink({
    maxLen: 1800,
    flushIntervalMs: 700,
    send: async (text) =>
      params.client.sendText({
        routeKind: params.routeKind,
        chatId: params.chatId,
        text,
      }),
    edit: async () => {
      throw new Error('QQ sink does not support message edit streaming');
    },
  });

  return {
    sendAgentText: buffered.sendText,
    sendText: buffered.sendText,
    breakTextStream: buffered.breakMessage,
    flush: buffered.flush,
    getDeliveryState: buffered.getState,
  };
}
