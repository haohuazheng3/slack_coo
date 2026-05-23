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
    const latest = findLatestToolResult(messages);
    if (latest?.data?.taskId) {
      parsedArgs.taskId = latest.data.taskId;
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
    log.error(`Tool ${fn.name} threw`, { error: error?.message ?? String(error) });
    return {
      name: fn.name,
      status: 'error',
      message: error?.message ?? 'Unknown error',
    };
  }
}

export async function runAiOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const { registry, messages, context, organizationName, situationBlock, triggerHint } = input;
  const functions = registry.list();

  const systemBlocks = buildSystemPrompt(functions, {
    userMention: `<@${context.slack.userId}>`,
    channelId: context.slack.channelId,
    threadTs: context.slack.threadTs,
    isDirectMessage: context.slack.channelId.startsWith('D'),
    organizationName,
    currentIsoTime: new Date().toISOString(),
    timezone: process.env.DEFAULT_TIMEZONE,
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
