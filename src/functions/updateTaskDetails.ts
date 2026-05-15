import { TaskPriority } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { parseRelativeTimeToDate } from '../services/normalizeTask';
import { toSlackMention } from '../utils/assignee';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from '../slack/taskCardUpdater';

type UpdateTaskDetailsArgs = {
  taskId: string;
  title?: string;
  description?: string;
  assignee?: string;
  assignees?: string[];
  dueTime?: string;
  initiator?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
};

function extractSlackUserId(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/U[A-Z0-9]+/i);
  if (match) return match[0].toUpperCase();
  return value.trim();
}

function extractSlackUserIds(values?: string[] | null): string[] {
  if (!values || !Array.isArray(values)) return [];
  const ids = values.map(extractSlackUserId).filter((v): v is string => !!v);
  return Array.from(new Set(ids));
}

function normalizePriority(value: unknown): TaskPriority | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'LOW' || upper === 'NORMAL' || upper === 'HIGH' || upper === 'URGENT') {
    return upper as TaskPriority;
  }
  return null;
}

export function updateTaskDetailsFunction(): RegisteredFunction {
  return {
    name: 'UpdateTaskDetails',
    description:
      "Modify an existing task's title, description, assignee(s), priority or dueTime. Always include taskId and only the fields that change.",
    inputExample:
      '{"taskId":"clxyz123","assignee":"<@U456>","dueTime":"in 30 minutes","priority":"HIGH"}',

    handler: async (args: UpdateTaskDetailsArgs, context) => {
      const { prisma, slack } = context;
      if (!args || typeof args !== 'object') {
        return { status: 'error', message: 'Invalid arguments received.' };
      }

      const taskId = (args.taskId || '').trim();
      if (!taskId) return { status: 'error', message: 'taskId is required.' };

      const existing = await prisma.task.findUnique({ where: { id: taskId } });
      if (!existing) {
        return { status: 'error', message: `Task ${taskId} was not found.` };
      }

      const updates: Record<string, any> = {};
      const changeSummary: string[] = [];

      if (args.title !== undefined) {
        const t = args.title.trim();
        if (!t) return { status: 'error', message: 'Title cannot be empty.' };
        updates.title = t;
        changeSummary.push(`title → ${t}`);
      }

      if (args.description !== undefined) {
        updates.description = args.description.trim() || null;
        changeSummary.push(`description updated`);
      }

      if (args.priority !== undefined) {
        const p = normalizePriority(args.priority);
        if (!p) {
          return { status: 'error', message: 'priority must be LOW, NORMAL, HIGH, or URGENT.' };
        }
        updates.priority = p;
        changeSummary.push(`priority → ${p}`);
      }

      let assignee = existing.assignee;
      let assignees = Array.isArray(existing.assignees) ? [...existing.assignees] : [];
      let assigneeUpdated = false;
      let assigneesUpdated = false;

      if (args.assignee !== undefined) {
        const parsed = extractSlackUserId(args.assignee);
        if (!parsed) return { status: 'error', message: 'Assignee must reference a Slack user.' };
        assignee = parsed;
        assigneeUpdated = true;
      }

      if (args.assignees !== undefined) {
        const parsed = extractSlackUserIds(args.assignees);
        if (parsed.length === 0) {
          return { status: 'error', message: 'Assignees list cannot be empty when provided.' };
        }
        assignees = parsed;
        assigneesUpdated = true;
      }

      if (assigneeUpdated || assigneesUpdated) {
        if (assigneesUpdated && !assigneeUpdated && assignees.length > 0) {
          assignee = assignees[0];
        } else if (assigneeUpdated && !assigneesUpdated) {
          assignees = assignee ? [assignee] : [];
        }
        if (assignee && !assignees.includes(assignee)) {
          assignees.unshift(assignee);
        }
        updates.assignee = assignee;
        updates.assignees = assignees;
        changeSummary.push(
          `assignee → ${toSlackMention(assignee)} (${assignees.map((a) => toSlackMention(a)).join(', ')})`
        );
      }

      if (args.initiator !== undefined) {
        const parsed = extractSlackUserId(args.initiator);
        if (!parsed) return { status: 'error', message: 'Initiator must reference a Slack user.' };
        updates.initiator = parsed;
        changeSummary.push(`initiator → ${toSlackMention(parsed)}`);
      }

      if (args.dueTime !== undefined) {
        const input = args.dueTime.trim();
        if (!input) return { status: 'error', message: 'dueTime cannot be empty when provided.' };
        let newDate = new Date(input);
        if (Number.isNaN(newDate.getTime())) {
          const relative = parseRelativeTimeToDate(input);
          if (relative) newDate = relative;
        }
        if (Number.isNaN(newDate.getTime())) {
          return {
            status: 'error',
            message: 'Unable to parse dueTime. Use ISO timestamp or "in 10 minutes".',
          };
        }
        updates.time = newDate;
        updates.deadlineReminderSentAt = null;
        changeSummary.push(`due → ${newDate.toLocaleString()}`);
      }

      if (Object.keys(updates).length === 0) {
        return { status: 'error', message: 'No changes were provided.' };
      }

      const updated = await prisma.task.update({ where: { id: taskId }, data: updates });

      const ts = await syncChannelTaskCard(slack.client, updated);
      if (ts && ts !== updated.channelMessageTs) {
        await persistChannelMessageTs(updated.id, ts);
      }
      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) refreshOwnerHome(slack.client, ownerId).catch(() => undefined);

      await slack.send({
        text: `✏️ Task updated: ${updated.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                '✏️ *Task updated*',
                `*${updated.title}*`,
                `*Assignee:* ${toSlackMention(updated.assignee)}`,
                `*Due:* ${updated.time.toLocaleString()}`,
                `*Priority:* ${updated.priority}`,
              ].join('\n'),
            },
          },
        ],
      });

      return {
        status: 'success',
        message: `Updated task ${updated.id}: ${changeSummary.join(', ')}`,
        data: {
          taskId: updated.id,
          title: updated.title,
          assignee: updated.assignee,
          initiator: ownerId,
          time: updated.time.toISOString(),
          priority: updated.priority,
          changes: changeSummary,
          action: 'updated',
        },
      };
    },
  };
}
