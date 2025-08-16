import express from 'express';
import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { parseTaskFromText } from './gpt/parseTask';
import { writeTaskToDB } from './db/writeTask';
import { startTaskReminderScheduler } from './scheduler/taskReminder';
import { PrismaClient } from "@prisma/client";
import { BlockAction, ButtonAction } from '@slack/bolt';
import { registerTaskActions } from './actions/taskActions';

const prisma = new PrismaClient();

dotenv.config();

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

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

app.event('app_mention', async ({ event, say }) => {
  const text = event.text;
  const userId = event.user;
  const channelId = event.channel;

  const parsed = await parseTaskFromText(text);

  if (!parsed) {
    await say("I couldn’t understand this sentence, please try rephrasing～");
    return;
  }

  const created = await writeTaskToDB({
    ...parsed,
    assignee: parsed.assignee || userId,
    channelId,
    createdBy: userId,
  });

  if (!created) {
    await say("❌ Task creation failed, please try again later");
    return;
  }

  // ✅ Send a Block Kit message with a button
  await say({
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ Task created successfully!\n*Title:* ${parsed.title}\n*Time:* ${parsed.time}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Mark as complete"
            },
            style: "primary",
            action_id: "complete_task",
            value: created.id // Pass task ID
          }
        ]
      }
    ]
  });
});

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

  // Start scheduled task reminders
  startTaskReminderScheduler();
})();
