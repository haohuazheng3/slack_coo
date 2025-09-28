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
  assignees: string[];
  channelId: string;
}) {
  try {
    const blocks = buildTaskBlocks(task);
    
    // Send the main reminder to the channel
    const res = await slack.chat.postMessage({
      channel: task.channelId,
      text: `Task reminder: ${task.title}`, // fallback text
      blocks
    });

    // Send individual notifications to each mentioned user
    for (const userId of task.assignees) {
      try {
        await slack.chat.postMessage({
          channel: userId, // Direct message to user
          text: `🔔 Reminder: ${task.title}`,
          blocks: buildTaskBlocks({ ...task, assignee: userId })
        });
        console.log(`📨 Personal reminder sent to ${userId}`);
      } catch (e) {
        console.error(`❌ Failed to send personal reminder to ${userId}:`, e);
      }
    }

    return res;
  } catch (e) {
    console.error("❌ Failed to send reminder card:", e);
  }
}

