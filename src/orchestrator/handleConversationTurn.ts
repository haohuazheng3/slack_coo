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
      // Feed the failure back to the AI so it can recover on the NEXT turn (e.g. CreateTask
      // returned needs_disambiguation → AI's next turn calls AskClarification with the
      // candidates). Do NOT echo the raw tool message to the user — those are AI-facing
      // instruction strings ("Call [AskClarification] first if unknown.") and they leak
      // internal mechanics. Surface a generic, calm acknowledgment instead.
      conversationStore.append(conversationKey, {
        role: 'assistant',
        content: `ToolResult: ${JSON.stringify({
          name: tool.name,
          status: 'error',
          message: tool.message,
          data: tool.data,
        })}`,
      });
      // For now, stay silent on tool errors at the chat level — the AI will often
      // self-recover in the same turn by emitting a recovery tool (e.g. AskClarification).
      // If a user actually needs to see something, the orchestrator's finalReply already
      // covers it (since the AI replies BEFORE tool calls execute).
    }
  }
}
