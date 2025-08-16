import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';
import { buildTaskBlocks } from '../ui/taskCard';

dotenv.config();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function postTaskReminder(task: {
  id: string;
  title: string;
  time: Date;
  assignee: string;
  channelId: string;
}) {
  try {
    const blocks = buildTaskBlocks(task);
    const res = await slack.chat.postMessage({
      channel: task.channelId,
      text: `Task reminder: ${task.title}`, // fallback text
      blocks
    });
    // If you need to update/delete this message later, you can store the ts in DB (not needed for this MVP)
    return res;
  } catch (e) {
    console.error("❌ Failed to send reminder card:", e);
  }
}

