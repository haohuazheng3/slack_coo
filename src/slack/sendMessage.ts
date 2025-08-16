import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

dotenv.config();

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function sendSlackMessage(channelId: string, text: string) {
  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      text,
    });
    console.log(`📨 Reminder sent to ${channelId}: ${text}`);
  } catch (e) {
    console.error("❌ Failed to send Slack message:", e);
  }
}
