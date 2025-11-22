import { openai } from '../ai/openaiClient';
import { buildSystemPrompt } from '../ai/prompt';
import { FunctionExecutionContext, FunctionExecutionResult, FunctionRegistry } from './functionRegistry';
import { ConversationMessage } from './conversationStore';
import { extractFunctionCalls } from './parseAiResponse';

export type OrchestratorInput = {
  registry: FunctionRegistry;
  messages: ConversationMessage[];
  context: FunctionExecutionContext;
};

export type OrchestratorOutput = {
  finalReply: string;
  toolResults: Array<{
    name: string;
    status: FunctionExecutionResult['status'];
    message?: string;
  }>;
};

export async function runAiOrchestrator(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const { registry, messages, context } = input;
  const functions = registry.list();

  const systemPrompt = buildSystemPrompt(functions, {
    userMention: `<@${context.slack.userId}>`,
    channelId: context.slack.channelId,
    currentIsoTime: new Date().toISOString(),
  });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  });

  const response = completion.choices[0]?.message?.content ?? '';
  const { cleanedText, calls } = extractFunctionCalls(response);

  const toolResults: OrchestratorOutput['toolResults'] = [];

  for (const call of calls) {
    const fn = registry.get(call.name);
    if (!fn) {
      toolResults.push({
        name: call.name,
        status: 'error',
        message: `Tool not registered`,
      });
      continue;
    }

    let parsedArgs: any = {};

    if (call.rawArguments) {
      try {
        parsedArgs = JSON.parse(call.rawArguments);
      } catch (error) {
        toolResults.push({
          name: fn.name,
          status: 'error',
          message: 'Failed to parse JSON payload',
        });
        continue;
      }
    }

    const argsPreview = call.rawArguments ?? JSON.stringify(parsedArgs);
    const consoleMessage = `🤖 AI triggered tool [${fn.name}] with payload: ${argsPreview}`;
    console.log(consoleMessage);

    try {
      await context.slack.send(`🤖 AI triggered tool [${fn.name}]`);
    } catch (error) {
      console.warn(`⚠️ Failed to notify Slack about tool trigger ${fn.name}:`, error);
    }

    try {
      const result = await fn.handler(parsedArgs, context);
      toolResults.push({
        name: fn.name,
        status: result.status,
        message: result.message,
      });
    } catch (error: any) {
      toolResults.push({
        name: fn.name,
        status: 'error',
        message: error?.message ?? 'Unknown error',
      });
    }
  }

  return {
    finalReply: cleanedText || 'Noted.',
    toolResults,
  };
}

