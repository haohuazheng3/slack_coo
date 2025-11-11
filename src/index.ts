import { App, ExpressReceiver, BlockAction, ButtonAction } from '@slack/bolt';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { registerTaskActions } from './actions/taskActions';
import { startTaskReminderScheduler } from './scheduler/taskReminder';
import { FunctionRegistry } from './orchestrator/functionRegistry';
import { registerCoreFunctions } from './functions';
import { runAiOrchestrator } from './orchestrator/runAiOrchestrator';
import { buildTaskListMessage } from './slack/listTasks';
import { conversationStore } from './orchestrator/conversationStore';

dotenv.config();

const prisma = new PrismaClient();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

const functionRegistry = new FunctionRegistry();
registerCoreFunctions(functionRegistry);

const pendingTaskReasons = new Map<string, string>();

app.action<BlockAction<ButtonAction>>('task_completed', async ({ ack, body, client }) => {
  await ack();
  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;

  await prisma.task.update({
    where: { id: taskId },
    data: { completed: true },
  });

  await client.chat.postMessage({
    channel: body.user.id,
    text: '✅ Task marked as completed!',
  });
});

app.action<BlockAction<ButtonAction>>('task_not_completed', async ({ ack, body, client }) => {
  await ack();
  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;
  if (!taskId) {
    console.error('Task ID missing for task_not_completed action');
    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Unable to record the reason because the task ID was missing. Please try again.',
    });
    return;
  }

  pendingTaskReasons.set(body.user.id, taskId);

  await client.chat.postMessage({
    channel: body.user.id,
    text: '❌ Please provide a short reason (1–2 sentences) why the task was not completed.',
  });
});

app.action<BlockAction<ButtonAction>>('list_tasks', async ({ ack, body, client }) => {
  await ack();
  const userId = (body as BlockAction<ButtonAction>).actions[0].value;

  if (!userId) {
    console.error('No user ID found in list_tasks button value');
    return;
  }

  const message = await buildTaskListMessage(prisma, userId, {
    showCompleted: false,
    showAll: false,
  });

  await client.chat.postMessage({
    channel: userId,
    text: message.text,
    blocks: message.blocks,
  });
});

app.action<BlockAction<ButtonAction>>('task_delete', async ({ ack, body, client }) => {
  await ack();

  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;
  const userId = body.user.id;

  if (!taskId) {
    console.error('No task ID found in task_delete button value');
    return;
  }

  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    await prisma.task.delete({
      where: { id: taskId },
    });

    await client.chat.postEphemeral({
      channel: (body as any).channel?.id || userId,
      user: userId,
      text: `🗑️ Task deleted successfully: ${task?.title || 'Task'}`,
    });

    const messageTs = (body as any).message?.ts;
    const channel = (body as any).channel?.id;

    if (messageTs && channel) {
      const originalBlocks = (body as any).message?.blocks || [];
      const headerText =
        originalBlocks.length > 0 && originalBlocks[0]?.text?.text
          ? originalBlocks[0].text.text.toLowerCase()
          : '';

      const showCompleted = headerText.includes('completed tasks');
      const showAll = headerText.includes('all tasks');

      const refreshMessage = await buildTaskListMessage(prisma, userId, {
        showCompleted,
        showAll,
      });

      await client.chat.update({
        channel,
        ts: messageTs,
        text: refreshMessage.text,
        blocks: refreshMessage.blocks,
      });
    }
  } catch (error) {
    console.error('❌ Error deleting task:', error);

    await client.chat.postEphemeral({
      channel: (body as any).channel?.id || userId,
      user: userId,
      text: '❌ Failed to delete task. Please try again.',
    });
  }
});

receiver.router.post('/slack/events', async (req, res) => {
  const { type, challenge } = req.body;
  if (type === 'url_verification') {
    return res.status(200).send(challenge);
  }
  res.status(200).send();
});

app.event('app_mention', async ({ event, client }) => {
  const userId = requireString((event as any).user, 'event.user');
  const channelId = requireString((event as any).channel, 'event.channel');
  const threadTs = ((event as any).thread_ts || event.ts) as string;
  const originalText = event.text || '';
  const conversationKey = getConversationKey(channelId, (event as any).thread_ts, event.ts);

  const botId = process.env.SLACK_BOT_USER_ID;
  const sanitizedText = botId
    ? originalText.replace(new RegExp(`<@${botId}>`, 'g'), '').trim()
    : originalText;

  const send = async (message: string | { text?: string; blocks?: any[] }) => {
    if (typeof message === 'string') {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: message,
      });
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: message.text ?? 'Notification',
      blocks: message.blocks,
    });
  };

  const userMessagePayload = buildUserMessagePayload({
    userId,
    channelId,
    text: sanitizedText || originalText,
  });
  conversationStore.append(conversationKey, { role: 'user', content: userMessagePayload });

  const orchestratorResult = await runAiOrchestrator({
    registry: functionRegistry,
    messages: conversationStore.get(conversationKey),
    context: {
      slack: {
        client,
        channelId,
        userId,
        rawText: sanitizedText || originalText,
        threadTs,
        send,
      },
      prisma,
    },
  });

  if (orchestratorResult.finalReply) {
    await send(orchestratorResult.finalReply);
  }

  if (orchestratorResult.rawResponse) {
    conversationStore.append(conversationKey, {
      role: 'assistant',
      content: orchestratorResult.rawResponse,
    });
  }

  for (const tool of orchestratorResult.toolResults) {
    console.log(`🔧 Tool ${tool.name} -> ${tool.status}${tool.message ? ` (${tool.message})` : ''}`);
  }
});

app.message(async ({ message, client }) => {
  if ((message as any).subtype) {
    return;
  }

  const userId = (message as any).user as string | undefined;
  const channelId = (message as any).channel as string | undefined;
  const text = (message as any).text as string | undefined;
  const ts = (message as any).ts as string | undefined;

  if (!userId || !text || !channelId) {
    return;
  }

  if (pendingTaskReasons.has(userId)) {
    const taskId = pendingTaskReasons.get(userId)!;
    pendingTaskReasons.delete(userId);

    try {
      await prisma.task.update({
        where: { id: taskId },
        data: { notCompletedReason: text },
      });

      await client.chat.postMessage({
        channel: channelId,
        text: '📝 Thank you! Your reason has been recorded.',
      });
    } catch (error) {
      console.error('Failed to save not-completed reason', error);
      await client.chat.postMessage({
        channel: channelId,
        text: '❌ Failed to record your reason. Please try again.',
      });
    }

    return;
  }

  const messageThreadTs = (message as any).thread_ts as string | undefined;
  const conversationKey = getConversationKey(channelId, messageThreadTs, ts);

  const isDirectMessage = channelId.startsWith('D');
  if (!isDirectMessage) {
    if (!messageThreadTs) {
      return;
    }
    if (!conversationStore.has(conversationKey)) {
      return;
    }
  }

  const send = async (message: string | { text?: string; blocks?: any[] }) => {
    if (typeof message === 'string') {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: message,
      });
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      text: message.text ?? 'Notification',
      blocks: message.blocks,
    });
  };

  const userMessagePayload = buildUserMessagePayload({
    userId,
    channelId,
    text,
  });
  conversationStore.append(conversationKey, { role: 'user', content: userMessagePayload });

  const orchestratorResult = await runAiOrchestrator({
    registry: functionRegistry,
    messages: conversationStore.get(conversationKey),
    context: {
      slack: {
        client,
        channelId,
        userId,
        rawText: text,
        threadTs: ts,
        send,
      },
      prisma,
    },
  });

  if (orchestratorResult.finalReply) {
    await send(orchestratorResult.finalReply);
  }

  if (orchestratorResult.rawResponse) {
    conversationStore.append(conversationKey, {
      role: 'assistant',
      content: orchestratorResult.rawResponse,
    });
  }

  for (const tool of orchestratorResult.toolResults) {
    console.log(`🔧 Tool ${tool.name} -> ${tool.status}${tool.message ? ` (${tool.message})` : ''}`);
  }
});

registerTaskActions(app);

(async () => {
  await app.start(Number(process.env.PORT) || 3000);
  console.log('⚡ Slack app is running!');

  try {
    const auth = await app.client.auth.test();
    if (auth && (auth as any).user_id) {
      process.env.SLACK_BOT_USER_ID = (auth as any).user_id;
      console.log('🤖 Resolved SLACK_BOT_USER_ID:', process.env.SLACK_BOT_USER_ID);
    }
  } catch (e) {
    console.warn('⚠️ Failed to resolve bot user id via auth.test()', e);
  }

  startTaskReminderScheduler();
})();

function requireString(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string') {
    throw new Error(`${name} is required but was missing/undefined.`);
  }
  return v;
}

function buildUserMessagePayload(payload: {
  userId: string;
  channelId: string;
  text: string;
}): string {
  return [
    'Incoming Slack message:',
    JSON.stringify(
      {
        userId: payload.userId,
        channelId: payload.channelId,
        text: payload.text,
      },
      null,
      2
    ),
  ].join('\n');
}

function getConversationKey(channelId: string, threadTs?: string, ts?: string): string {
  if (threadTs) {
    return `${channelId}:${threadTs}`;
  }
  if (channelId.startsWith('D')) {
    return `DM:${channelId}`;
  }
  return `${channelId}:${ts ?? 'root'}`;
}
