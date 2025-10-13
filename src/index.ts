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

const prisma = new PrismaClient();

dotenv.config();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

app.action<BlockAction<ButtonAction>>("task_completed", async ({ ack, body, client }) => {
  await ack();
  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;

  await prisma.task.update({
    where: { id: taskId },
    data: { completed: true },
  });

  await client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Task marked as completed!`
  });
});

app.action<BlockAction<ButtonAction>>("task_not_completed", async ({ ack, body, client, say }) => {
  await ack();
  const taskId = (body as BlockAction<ButtonAction>).actions[0].value;

  await client.chat.postMessage({
    channel: body.user.id,
    text: "❌ Please provide a short reason (1–2 sentences) why the task was not completed."
  });

  // Listen for the next message from the same user
  app.message(async ({ message }) => {
    const msg = message as any;
    if (msg.user === body.user.id && msg.text) {
      await prisma.task.update({
        where: { id: taskId },
        data: { notCompletedReason: msg.text }
      });

      await client.chat.postMessage({
        channel: body.user.id,
        text: "📝 Thank you! Your reason has been recorded."
      });
    }
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


  // 1) Call GPT to parse the natural language into fields
  const gpt = await parseTaskFromText(text);
  if (!gpt) {
    await say("I couldn't understand this request. Please rephrase.");
    return;
  }

  // 2) Build the normalized payload for DB write
  //    - We pass both ISO time (if any) and relative time for fallback parsing
  //    - We also pass rawText for last-resort parsing (e.g., "in 2 minutes")
  const payload: ParsedTaskInput = {
    title: gpt.title,
    task: gpt.task,
    time: gpt.time,                     // prefer ISO string if GPT provided
    reminder_time: gpt.reminder_time,   // e.g., "in 2 minutes"
    assignee: gpt.assignee || userId,   // if GPT didn't return, default to requester
    assignees: gpt.assignees || [],     // all mentioned users
    channelId,
    createdBy: userId,
    rawText: text,
  };

  // 3) Persist to DB via our normalization adapter (handles time/assignee cleanup)
  const created = await writeTaskToDB(payload);
  if (!created) {
    await say("❌ Task creation failed. Please try again later.");
    return;
  }

  // 4) Build a Block Kit card with a “Complete” button
  //    - Use toSlackMention for display. In DB we store just "UXXXX"; for UI we render "<@UXXXX>"
  const displayAssignee = toSlackMention(created.assignee);
  const displayTime = created.time.toLocaleString(); // TODO: switch to fixed timezone formatting later

  await say({
    text: `Task created: ${created.title}`, // fallback text
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
            action_id: "task_complete",   // IMPORTANT: must match your action handler
            value: created.id             // pass task ID back to the action handler
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
  if (message.subtype === undefined) {
    await say(`Got your message <@${message.user}>!`);
  }
});

registerTaskActions(app); // ✅ Register button action handlers

(async () => {
  await app.start(Number(process.env.PORT) || 3000);
  console.log('⚡ Slack app is running!');

  // Resolve bot user ID at runtime so we never DM the bot by mistake
  try {
    const auth = await app.client.auth.test();
    if (auth && (auth as any).user_id) {
      process.env.SLACK_BOT_USER_ID = (auth as any).user_id;
      console.log('🤖 Resolved SLACK_BOT_USER_ID:', process.env.SLACK_BOT_USER_ID);
    }
  } catch (e) {
    console.warn('⚠️ Failed to resolve bot user id via auth.test()', e);
  }

  // Start scheduled task reminders
  startTaskReminderScheduler();
})();
