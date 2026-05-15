import { openai } from '../ai/openaiClient';
import { buildSystemPrompt } from '../ai/prompt';
import {
  FunctionExecutionContext,
  FunctionExecutionResult,
  FunctionRegistry,
} from './functionRegistry';
import { ConversationMessage } from './conversationStore';
import { extractFunctionCalls, ParsedFunctionCall } from './parseAiResponse';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createLogger } from '../lib/logger';

const log = createLogger('Orchestrator');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const DEFAULT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? '0.2');

export type OrchestratorInput = {
  registry: FunctionRegistry;
  messages: ConversationMessage[];
  context: FunctionExecutionContext;
  organizationName?: string;
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
  const { registry, messages, context, organizationName } = input;
  const functions = registry.list();

  const systemPrompt = buildSystemPrompt(functions, {
    userMention: `<@${context.slack.userId}>`,
    channelId: context.slack.channelId,
    threadTs: context.slack.threadTs,
    isDirectMessage: context.slack.channelId.startsWith('D'),
    organizationName,
    currentIsoTime: new Date().toISOString(),
    timezone: process.env.DEFAULT_TIMEZONE,
    ownerLanguageHint: process.env.OWNER_LANGUAGE || undefined,
  });

  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(
      (message): ChatCompletionMessageParam => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      })
    ),
  ];

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      messages: chatMessages,
    });
  } catch (error: any) {
    log.error('OpenAI request failed', { error: error?.message ?? String(error) });
    return {
      finalReply:
        '⚠️ I had trouble reaching my reasoning engine. Could you try again in a moment?',
      toolResults: [],
    };
  }

  const response = completion.choices[0]?.message?.content ?? '';
  const { cleanedText, calls } = extractFunctionCalls(response);

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
