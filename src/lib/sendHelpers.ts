import { WebClient } from '@slack/web-api';

export type SlackSendPayload = string | { text?: string; blocks?: any[] };

export type Sender = (message: SlackSendPayload) => Promise<void>;

export function buildChannelSender(
  client: WebClient,
  channelId: string,
  threadTs?: string
): Sender {
  return async (message: SlackSendPayload) => {
    const base: any = { channel: channelId };
    if (threadTs) base.thread_ts = threadTs;

    if (typeof message === 'string') {
      await client.chat.postMessage({ ...base, text: message });
      return;
    }

    await client.chat.postMessage({
      ...base,
      text: message.text ?? 'Notification',
      blocks: message.blocks,
    });
  };
}

export function getConversationKey(
  channelId: string,
  threadTs?: string,
  fallbackTs?: string
): string {
  if (threadTs) return `${channelId}:${threadTs}`;
  if (channelId.startsWith('D')) return `DM:${channelId}`;
  return `${channelId}:${fallbackTs ?? 'root'}`;
}

export function buildUserMessagePayload(payload: {
  userId: string;
  channelId: string;
  text: string;
  metadata?: Record<string, unknown>;
}): string {
  const body: Record<string, unknown> = {
    userId: payload.userId,
    channelId: payload.channelId,
    text: payload.text,
  };
  if (payload.metadata) body.metadata = payload.metadata;
  return ['Incoming Slack message:', JSON.stringify(body, null, 2)].join('\n');
}

export async function openDm(client: WebClient, userId: string): Promise<string | null> {
  try {
    const res = await client.conversations.open({ users: userId });
    const id = (res as any).channel?.id;
    return id ?? userId;
  } catch {
    return null;
  }
}
