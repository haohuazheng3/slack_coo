import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { writeTaskToDB } from '../db/writeTask';
import { ParsedTaskInput } from '../services/normalizeTask';
import { toSlackMention } from '../utils/assignee';

type CreateTaskArgs = {
  title: string;
  description?: string;
  dueTime?: string;
  reminder?: string;
  assignee?: string;
  assignees?: string[];
};

export function createTaskFunction(): RegisteredFunction {
  return {
    name: 'CreateTask',
    description:
      'Create a new task for the team. Include title, dueTime (ISO or relative), and assign responsible Slack users.',
    inputExample:
      '{"title": "Prepare Q4 forecast", "dueTime": "2025-01-05T14:00:00-05:00", "assignee": "<@U123>"}',
    handler: async (args: CreateTaskArgs, context) => {
      if (!args || typeof args !== 'object') {
        return {
          status: 'error',
          message: 'Invalid arguments received.',
        };
      }

      const title = (args.title || '').trim();
      if (!title) {
        return {
          status: 'error',
          message: 'Task title is required.',
        };
      }

      const payload: ParsedTaskInput = {
        title,
        task: args.description ?? args.title,
        time: args.dueTime,
        reminder_time: args.reminder,
        assignee: args.assignee,
        assignees: args.assignees,
        channelId: context.slack.channelId,
        createdBy: context.slack.userId,
        rawText: context.slack.rawText,
      };

      let created;
      try {
        created = await writeTaskToDB(payload);
      } catch (error: any) {
        return {
          status: 'error',
          message: error?.message ?? 'Failed to create task.',
        };
      }

      if (!created) {
        return {
          status: 'error',
          message: 'Task creation failed.',
        };
      }

      const mention = toSlackMention(created.assignee);
      const timeText = created.time.toLocaleString();

      await context.slack.send({
        text: `Task created: ${title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Task created successfully!*\n• *Title:* ${created.title}\n• *Assignee:* ${mention}\n• *Time:* ${timeText}`,
            },
          },
        ],
      });

      return {
        status: 'success',
        message: `Created task "${created.title}" for ${mention}.`,
        data: { taskId: created.id },
      };
    },
  };
}

