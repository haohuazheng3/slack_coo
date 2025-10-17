import express from 'express';
import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { parseTaskFromText } from './gpt/parseTask';
import { writeTaskToDB } from './db/writeTask';
import { startTaskReminderScheduler } from './scheduler/taskReminder';
import { PrismaClient } from "@prisma/client";
import { BlockAction, ButtonAction } from '@slack/bolt';
import { registerTaskActions } from './actions/taskActions';
import { toSlackMention } from './utils/assignee';    
import type { ParsedTaskInput } from './services/normalizeTask';
import { computeMissing, setPending, getPending, mergePayload, clearPending, buildFollowupQuestion } from './services/conversation';
import { sanitizeParsedTask } from './services/sanitizeTask';

const prisma = new PrismaClient();

dotenv.config();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

let botUserId: string | null = null;
(async () => {
  try {
    const auth = await (new PrismaClient());
    // We don't use prisma here; fetch bot identity via client once app starts below
  } catch {}
})();

// Listen for button clicks
app.action<BlockAction<ButtonAction>>("complete_task", async ({ ack, body, client }) => {
  await ack();

  // Assert body always has actions
  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;

  await prisma.task.update({
    where: { id: taskId },
    data: { completed: true },
  });

  await client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Task completed!`
  });
});

// 👇 Challenge verification handler
receiver.router.post('/slack/events', async (req, res) => {
  const { type, challenge } = req.body;
  if (type === 'url_verification') {
    return res.status(200).send(challenge);
  } else {
    res.status(200).send(); // Prevent Slack retry due to timeout
  }
});

app.event('app_mention', async ({ event, say, client }) => {
  const text = event.text;
  const userId = requireString((event as any).user, 'event.user');
  const channelId = requireString((event as any).channel, 'event.channel');

  if (!botUserId) {
    try {
      const auth = await client.auth.test();
      botUserId = auth.user_id || null;
    } catch {}
  }

  // 1) Call GPT to parse the natural language into fields
  const gpt = await parseTaskFromText(text);
  if (!gpt) {
    await say("I couldn't understand this request. Please rephrase.");
    return;
  }

  // 2) Build the normalized payload for DB write
  //    - We pass both ISO time (if any) and relative time for fallback parsing
  //    - We also pass rawText for last-resort parsing (e.g., "in 2 minutes")
  let payload: ParsedTaskInput = {
    title: gpt.title,
    task: gpt.task,
    time: gpt.time,                     // prefer ISO string if GPT provided
    reminder_time: gpt.reminder_time,   // e.g., "in 2 minutes"
    // 不在此处默认指派给提问者：缺失时进入对话询问，避免机械化默认
    assignee: gpt.assignee,
    assignees: gpt.assignees || [],     // all mentioned users
    channelId,
    createdBy: userId,
    rawText: text,
  };

  // Sanitize: fix title/assignee/assignees with requester & remove bot mention
  payload = sanitizeParsedTask(text, userId, botUserId, payload);

  // 3) 如果存在缺失字段，进入对话模式并逐条追问
  const missing = computeMissing(payload);
  if (missing.length > 0) {
    const ctx = { channelId, userId, payload, missing } as const;
    setPending(ctx);
    await say(buildFollowupQuestion(ctx));
    return;
  }

  // 4) 无缺失，直接写入
  const created = await writeTaskToDB(payload);
  if (!created) {
    await say("❌ Task creation failed. Please try again later.");
    return;
  }

  // 5) 发送任务卡片
  const displayAssignee = toSlackMention(created.assignee);
  const displayTime = created.time.toLocaleString();

  await say({
    text: `Task created: ${created.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Task created successfully!*\n• *Title:* ${created.title}\n• *Assignee:* ${displayAssignee}\n• *Time:* ${displayTime}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Mark as complete" },
            style: "primary",
            action_id: "complete_task",
            value: created.id
          }
        ]
      }
    ]
  });
});

function requireString(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string') {
    throw new Error(`${name} is required but was missing/undefined.`);
  }
  return v;
}

// 👇 Message handler
app.message(async ({ message, say }) => {
  if (message.subtype !== undefined) return;
  const channelId = (message as any).channel as string;
  const userId = (message as any).user as string;
  const text = (message as any).text as string;

  const pending = getPending(channelId, userId);
  if (!pending) return; // 非对话态不干预

  // 将用户本次回复再次解析并合并
  const gpt = await parseTaskFromText(text);
  let merged = mergePayload(pending.payload, {
    title: gpt?.title,
    task: gpt?.task,
    time: gpt?.time,
    reminder_time: gpt?.reminder_time,
    assignee: gpt?.assignee,
    assignees: gpt?.assignees,
    rawText: text,
  });

  // Re-sanitize with context
  merged = sanitizeParsedTask(text, userId, botUserId, merged);

  const missing = computeMissing(merged);
  if (missing.length > 0) {
    const ctx = { channelId, userId, payload: merged, missing } as const;
    setPending(ctx);
    await say(buildFollowupQuestion(ctx));
    return;
  }

  // 信息齐全，创建任务
  const created = await writeTaskToDB(merged);
  if (!created) {
    await say('❌ Task creation failed. Please try again later.');
    return;
  }

  clearPending(channelId, userId);

  const displayAssignee = toSlackMention(created.assignee);
  const displayTime = created.time.toLocaleString();

  await say({
    text: `Task created: ${created.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *Task created successfully!*\n• *Title:* ${created.title}\n• *Assignee:* ${displayAssignee}\n• *Time:* ${displayTime}` }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Mark as complete' },
            style: 'primary',
            action_id: 'complete_task',
            value: created.id
          }
        ]
      }
    ]
  });
});

registerTaskActions(app); // ✅ Register button action handlers

(async () => {
  await app.start(Number(process.env.PORT) || 3000);
  console.log('⚡ Slack app is running!');

  // Start scheduled task reminders
  startTaskReminderScheduler();
})();
