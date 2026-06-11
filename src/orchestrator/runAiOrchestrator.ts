import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, extractText, PRIMARY_MODEL } from '../ai/anthropic';
import { buildSystemPrompt } from '../ai/prompt';
import {
  FunctionExecutionContext,
  FunctionExecutionResult,
  FunctionRegistry,
} from './functionRegistry';
import { ConversationMessage } from './conversationStore';
import { extractFunctionCalls, ParsedFunctionCall } from './parseAiResponse';
import { createLogger } from '../lib/logger';
import { getUserProfile } from '../lib/userProfile';
import { isWorkspacePaid } from '../billing/featureGate';

const log = createLogger('Orchestrator');

const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS ?? '16000');

export type OrchestratorInput = {
  registry: FunctionRegistry;
  messages: ConversationMessage[];
  context: FunctionExecutionContext;
  organizationName?: string;
  /** Compact "what's going on" block dropped into the system prompt verbatim. */
  situationBlock?: string;
  /** Short string describing what triggered this turn (mention / dm / ambient_*). */
  triggerHint?: string;
};

export type ToolResultEntry = {
  name: string;
  status: FunctionExecutionResult['status'];
  message?: string;
  data?: any;
};

export type OrchestratorOutput = {
  finalReply: string;
  toolResults: ToolResultEntry[];
};

/**
 * Walk the conversation history backwards to find the most recent ToolResult JSON
 * for a specific tool (or any tool if name is undefined). Used to recover taskIds, etc.
 */
export function findLatestToolResult(
  messages: ConversationMessage[],
  toolName?: string
): { name: string; data: any } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const idx = msg.content.indexOf('ToolResult:');
    if (idx === -1) continue;
    const jsonPart = msg.content.slice(idx + 'ToolResult:'.length).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      if (toolName && parsed.name !== toolName) continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

async function executeOneCall(
  call: ParsedFunctionCall,
  registry: FunctionRegistry,
  messages: ConversationMessage[],
  context: FunctionExecutionContext
): Promise<ToolResultEntry> {
  const fn = registry.get(call.name);
  if (!fn) {
    return { name: call.name, status: 'error', message: 'Tool not registered.' };
  }

  let parsedArgs: any = {};
  if (call.rawArguments) {
    try {
      parsedArgs = JSON.parse(call.rawArguments);
    } catch {

      try {
        parsedArgs = JSON.parse(call.rawArguments.replace(/'/g, '"'));
      } catch {
        return {
          name: fn.name,
          status: 'error',
          message: 'Failed to parse JSON payload from AI.',
        };
      }
    }
  }

  const taskIdNeeded = ['UpdateTaskDetails', 'UpdateTaskStatus', 'DeleteTask', 'RecordProgress', 'NudgeProgress'];
  if (taskIdNeeded.includes(fn.name) && !parsedArgs.taskId) {
    // Only auto-fill if the AI didn't pass an explicit query — never clobber a
    // FindTask-style intent ("find the banner one") with a stale id from a
    // previous unrelated tool result. The AI is explicitly looking up a task
    // by name; let it.
    const hasExplicitQuery = parsedArgs.titleQuery || parsedArgs.taskQuery || parsedArgs.query;
    if (!hasExplicitQuery) {
      const latest = findLatestToolResult(messages);
      if (latest?.data?.taskId) {
        parsedArgs.taskId = latest.data.taskId;
      }
    }
  }

  // Billing gate — block WRITE tools when the workspace isn't paid. Read tools
  // (ListTasks, FindTask, AskClarification) still work so the owner can review
  // their data and the bot can still answer "how's X going". The sentinel
  // returned here gets phrased by the AI; the orchestrator surface layer must
  // ensure billing CTA only renders to the OWNER (never to channels with
  // employees present) — see handleConversationTurn.
  const writeTools = new Set([
    'CreateTask',
    'UpdateTaskDetails',
    'UpdateTaskStatus',
    'DeleteTask',
    'DeleteTasks',
    'RecordProgress',
    'NudgeProgress',
    'ConfirmAlias',
  ]);
  if (writeTools.has(fn.name)) {
    const gate = await isWorkspacePaid({
      teamId: context.slack.teamId ?? null,
      enterpriseId: context.slack.enterpriseId ?? null,
    });
    if (!gate.paid) {
      log.info(`Billing-gated write tool ${fn.name} blocked`, { reason: gate.reason });
      return {
        name: fn.name,
        status: 'error',
        message: 'BILLING_GATED: workspace subscription is required to make changes. Tell the owner (only) to upgrade — do not mention this to anyone else.',
        data: { billingGated: true, reason: gate.reason },
      };
    }
  }

  log.info(`Triggered tool ${fn.name}`, { payloadPreview: call.rawArguments?.slice(0, 200) });

  try {
    const result = await fn.handler(parsedArgs, context);
    return {
      name: fn.name,
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (error: any) {
    // Log the raw exception text for ops; do NOT put it into the AI buffer.
    // Stack traces / SQL errors / typescript runtime messages leaking into the
    // conversation context risks them being quoted back at the user.
    log.error(`Tool ${fn.name} threw`, { error: error?.message ?? String(error) });
    return {
      name: fn.name,
      status: 'error',
      message: 'The tool threw while running.',
    };
  }
}

export async function runAiOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const { registry, messages, context, organizationName, situationBlock, triggerHint } = input;
  const functions = registry.list();

  // Resolve the speaker's actual Slack timezone so "tomorrow 6pm" gets parsed
  // in their local time — not in UTC, and not in the server's TZ. Falls back
  // to DEFAULT_TIMEZONE if the lookup fails (Slack rate limit, missing scope).
  // Cached for 6 hours per user so this isn't a hot path.
  let speakerTz: string | null = null;
  let speakerTzLabel: string | null = null;
  try {
    const profile = await getUserProfile(context.slack.client, context.slack.userId, {
      teamId: context.slack.teamId ?? null,
      enterpriseId: context.slack.enterpriseId ?? null,
    });
    speakerTz = profile?.tz ?? null;
    speakerTzLabel = profile?.tzLabel ?? null;
  } catch (err) {
    log.warn('Could not resolve speaker timezone', { error: String(err) });
  }

  const systemBlocks = buildSystemPrompt(functions, {
    userMention: `<@${context.slack.userId}>`,
    channelId: context.slack.channelId,
    threadTs: context.slack.threadTs,
    isDirectMessage: context.slack.channelId.startsWith('D'),
    organizationName,
    currentIsoTime: new Date().toISOString(),
    timezone: speakerTz ?? process.env.DEFAULT_TIMEZONE,
    timezoneLabel: speakerTzLabel,
    situationBlock,
    triggerHint,
  });

  // Anthropic does not allow a system role inside `messages` — system goes in
  // its own parameter. The first message MUST be `user`; in our flow every
  // turn starts with a user payload, so this is naturally satisfied.
  const conversationMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Adaptive thinking lets Opus decide when judgment depth is needed —
      // no fixed budget. This is the only `thinking` mode allowed on 4.7.
      thinking: { type: 'adaptive' },
      system: systemBlocks,
      messages: conversationMessages,
    });
  } catch (error: any) {
    log.error('Anthropic request failed', { error: error?.message ?? String(error) });
    return {
      finalReply: '',
      toolResults: [],
    };
  }

  // Cache instrumentation — surfaces whether the frozen system-prompt block
  // is actually getting the 90% cache discount per request. After a deploy,
  // grep Render logs for "cache_read_input_tokens" and watch the second
  // request within ~5 min in a conversation: that's where the cache should
  // hit. If cache_read stays 0 across consecutive requests, the prompt's
  // frozen prefix is below Opus 4.7's 4096-token cacheable minimum (silent
  // failure) — see shared/prompt-caching.md.
  const usage: any = response.usage ?? {};
  log.info('Anthropic usage', {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  });

  const rawText = extractText(response);
  const { cleanedText, calls } = extractFunctionCalls(rawText);

  const toolResults: ToolResultEntry[] = [];
  for (const call of calls) {
    const result = await executeOneCall(call, registry, messages, context);
    toolResults.push(result);
  }

  return {
    finalReply: cleanedText,
    toolResults,
  };
}
