import { toSlackMention } from '../utils/assignee';

export function buildTaskBlocks(task: {
  id: string;
  title: string;
  time: Date;
  assignee: string;
}) {
  const mention = toSlackMention(task.assignee);
  const timeText = task.time.toLocaleString(); // Use local format for now, can switch to timezone formatting later

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔔 *Task Reminder*\n• Title: *${task.title}*\n• Assignee: ${mention}\n• Time: ${timeText}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Complete ✅" },
          style: "primary",
          action_id: "task_complete",
          value: task.id
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Delay 15m" },
          action_id: "task_delay_15m",
          value: task.id
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Delay 1h" },
          action_id: "task_delay_60m",
          value: task.id
        }
      ]
    }
  ];
}
