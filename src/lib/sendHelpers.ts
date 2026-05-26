import { WebClient } from '@slack/web-api';
import { withFeedbackButton } from '../feedback/button';

export type SlackSendPayload = string | { text?: string; blocks?: any[]; skipFeedbackButton?: boolean };

export type Sender = (message: SlackSendPayload) => Promise<void>;

/**
 * Wraps `chat.postMessage` for a specific channel/thread, and auto-appends the
 * 🐞 feedback button to every message that has any visible content. Internal-
 * beta debugging primitive — see src/feedback/button.ts for the rationale.
 *
 * Callers can opt out by passing `skipFeedbackButton: true` (used by the
 * feedback flow itself to avoid recursive button-on-thank-you-message etc).
 */
export function buildChannelSender(
  client: WebClient,
  channelId: string,
  threadTs?: string
): Sender {
  return async (message: SlackSendPayload) => {
    const base: any = { channel: channelId };
    if (threadTs) base.thread_ts = threadTs;

    if (typeof message === 'string') {
      const args = withFeedbackButton({ ...base, text: message });
      await client.chat.postMessage(args as any);
      return;
    }

    const skip = (message as any).skipFeedbackButton;
    const raw = { ...base, text: message.text ?? 'Notification', blocks: message.blocks };
    const args = skip ? raw : withFeedbackButton(raw);
    await client.chat.postMessage(args as any);
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

/**
 * Direct `chat.postMessage` wrapper that auto-appends the 🐞 feedback button.
 * Use this in place of `client.chat.postMessage(...)` when sending DMs from
 * functions/cron paths that don't go through buildChannelSender (createTask,
 * recordProgress, progressCheck, nudgeProgress, etc).
 *
 * Same opt-out via `skipFeedbackButton: true` if a specific message shouldn't
 * carry one (e.g. the feedback flow's own thank-you).
 */
export async function postMessageWithFeedback(
  client: WebClient,
  args: Parameters<WebClient['chat']['postMessage']>[0] & { skipFeedbackButton?: boolean }
): Promise<any> {
  const { skipFeedbackButton, ...rest } = args as any;
  const final = skipFeedbackButton ? rest : withFeedbackButton(rest);
  return client.chat.postMessage(final);
}
