export type DeliveryState = {
  text: string;
  messageId: string | null;
};

export type UiMode = 'verbose' | 'summary';

export type PermissionUiRequest = {
  uiMode: UiMode;
  sessionKey: string;
  requestId: string;
  toolTitle: string;
  toolKind: string | null;
};

export type UiEvent =
  | {
      kind: 'plan' | 'task';
      mode: UiMode;
      title: string;
      detail?: string;
    }
  | {
      kind: 'tool';
      mode: UiMode;
      title: string;
      detail?: string;
    };

export type OutboundSink = {
  // Reserved for agent assistant content chunks.
  // Telegram private chats stream this via sendMessageDraft.
  sendAgentText?: (text: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  flush?: () => Promise<void>;
  getDeliveryState?: () => DeliveryState;

  requestPermission?: (req: PermissionUiRequest) => Promise<void>;
  sendUi?: (event: UiEvent) => Promise<void>;
};
