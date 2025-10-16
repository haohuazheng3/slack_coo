import { toSlackMention } from '../utils/assignee';

export function buildTaskBlocks(task: {
  id: string;
  title: string;
  time: Date;
  assignee: string;
  assignees?: string[];
}) {
  const mention = toSlackMention(task.assignee);
  const timeText = task.time.toLocaleString(); // Use local format for now, can switch to timezone formatting later
  
  // Build assignees text - show all mentioned users
  let assigneesText = mention;
  if (task.assignees && task.assignees.length > 1) {
    const allMentions = task.assignees.map(assignee => toSlackMention(assignee)).join(', ');
    assigneesText = allMentions;
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔔 *Task Reminder*\n• Title: *${task.title}*\n• Assignees: ${assigneesText}\n• Time: ${timeText}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Completed ✅" },
          style: "primary",
          action_id: "task_completed",
          value: task.id
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Not Completed ❌" },
          style: "danger",
          action_id: "task_not_completed",
          value: task.id
        }
      ]
    }
  ];
}
