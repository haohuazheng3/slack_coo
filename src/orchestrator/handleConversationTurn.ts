import { WebClient } from '@slack/web-api';
import { FunctionRegistry } from './functionRegistry';
import { runAiOrchestrator } from './runAiOrchestrator';
import { conversationStore } from './conversationStore';
import { prisma } from '../lib/prisma';
import { buildChannelSender, buildUserMessagePayload, getConversationKey } from '../lib/sendHelpers';
import { createLogger } from '../lib/logger';

const log = createLogger('Turn');

export type ConversationTurnInput = {
  client: WebClient;
  registry: FunctionRegistry;
  userId: string;
  channelId: string;
  teamId?: string | null;
  enterpriseId?: string | null;

  threadTs?: string;

  fallbackTs?: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/**
 * Centralizes the "Slack event -> AI turn -> Slack reply + conversation persist" flow.
 * Used by app_mention, app.message (DM), and any other entrypoint that should hand off to the AI.
 */
export async function handleConversationTurn(input: ConversationTurnInput): Promise<void> {
  const {
    client,
    registry,
    userId,
    channelId,
    teamId,
    enterpriseId,
    threadTs,
    fallbackTs,
    text,
    metadata,
  } = input;

  const conversationKey = getConversationKey(channelId, threadTs, fallbackTs);
  const sendThreadTs = threadTs ?? fallbackTs;

  const send = buildChannelSender(client, channelId, sendThreadTs);

  const userPayload = buildUserMessagePayload({ userId, channelId, text, metadata });
  conversationStore.append(conversationKey, { role: 'user', content: userPayload });

  const result = await runAiOrchestrator({
    registry,
    messages: conversationStore.get(conversationKey),
    context: {
      slack: {
        client,
        channelId,
        userId,
        rawText: text,
        threadTs: sendThreadTs,
        teamId: teamId ?? null,
        enterpriseId: enterpriseId ?? null,
        send,
      },
      prisma,
    },
  });

  if (result.finalReply) {
    try {
      await send(result.finalReply);
    } catch (err) {
      log.warn('Failed to send final reply', { error: String(err), channelId });
    }
    conversationStore.append(conversationKey, {
      role: 'assistant',
      content: result.finalReply,
    });
  }

  for (const tool of result.toolResults) {
    log.info(`Tool ${tool.name} -> ${tool.status}`, { message: tool.message });
    if (tool.status === 'success' && tool.data) {
      conversationStore.append(conversationKey, {
        role: 'assistant',
        content: `ToolResult: ${JSON.stringify({ name: tool.name, data: tool.data })}`,
      });
    } else if (tool.status === 'error') {
      try {
        await send(`⚠️ ${tool.name} failed: ${tool.message ?? 'Unknown error'}`);
      } catch (err) {
        log.warn('Failed to send tool error notice', { error: String(err) });
      }
    }
  }
}
