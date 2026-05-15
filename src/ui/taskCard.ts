import { Task } from '@prisma/client';
import { toSlackMention } from '../utils/assignee';
import { buildProgressBar } from './progressBar';
import { defaultTranslator, Translator } from '../lib/i18n';

export type RenderableTask = Pick<
  Task,
  | 'id'
  | 'title'
  | 'description'
  | 'time'
  | 'assignee'
  | 'assignees'
  | 'status'
  | 'priority'
  | 'progressPercent'
  | 'lastProgressSummary'
  | 'lastProgressAt'
  | 'initiator'
  | 'createdBy'
  | 'completed'
  | 'notCompletedReason'
>;

export type CardOptions = {
  variant?: 'channel' | 'home' | 'list';
  showActions?: boolean;
  translator?: Translator;
};

function assigneesText(task: RenderableTask): string {
  if (Array.isArray(task.assignees) && task.assignees.length > 0) {
    return task.assignees.map((a) => toSlackMention(a)).join(', ');
  }
  return toSlackMention(task.assignee);
}

function ownerMention(task: RenderableTask): string {
  return toSlackMention(task.initiator ?? task.createdBy);
}

export function buildTaskCardBlocks(
  task: RenderableTask,
  options: CardOptions = {}
): any[] {
  const { variant = 'channel', showActions = true, translator = defaultTranslator } = options;
  const statusIcon = translator.statusIcon(task.status);
  const statusLabel = translator.statusLabel(task.status);
  const priorityBadge = translator.priorityBadge(task.priority);
  const progressBar = buildProgressBar(task.progressPercent);
  const dueText = task.time.toLocaleString();
  const isOverdue =
    task.time.getTime() < Date.now() &&
    task.status !== 'COMPLETED' &&
    task.status !== 'CANCELLED';
  const overdueTag = isOverdue ? ` • ${translator.t('card.overdueTag')}` : '';

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${task.title}*  ${priorityBadge}\n${statusIcon} *${statusLabel}*${overdueTag}`,
      },
    },
  ];

  const description = task.description?.trim();
  if (description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📝 ${description}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `*${translator.t('card.due')}:* ${dueText}` },
      { type: 'mrkdwn', text: `*${translator.t('card.assignee')}:* ${assigneesText(task)}` },
      { type: 'mrkdwn', text: `*${translator.t('card.from')}:* ${ownerMention(task)}` },
    ],
  });

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `*${translator.t('card.progress')}:* \`${progressBar}\`` },
    ],
  });

  if (task.lastProgressSummary) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🗒️ ${task.lastProgressSummary} _(${translator.relativeTime(task.lastProgressAt)})_`,
        },
      ],
    });
  } else if (task.status === 'NOT_STARTED') {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🗒️ ${translator.t('card.noUpdates')}` }],
    });
  }

  if (task.notCompletedReason && (task.status === 'FAILED' || task.status === 'BLOCKED')) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⚠️ ${translator.t('card.reason')}: ${task.notCompletedReason}`,
        },
      ],
    });
  }

  if (!showActions) return blocks;

  const actionElements: any[] = [];
  if (variant === 'channel') {
    if (task.status !== 'COMPLETED' && task.status !== 'CANCELLED') {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: translator.t('card.btn.complete') },
        style: 'primary',
        action_id: 'task_mark_complete',
        value: task.id,
      });
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: translator.t('card.btn.modify') },
        action_id: 'task_edit_start',
        value: task.id,
      });
    }
  } else if (variant === 'list') {
    if (task.status !== 'COMPLETED' && task.status !== 'CANCELLED') {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: translator.t('card.btn.complete') },
        style: 'primary',
        action_id: 'task_mark_complete',
        value: task.id,
      });
    }
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: translator.t('card.btn.modify') },
      action_id: 'task_edit_start',
      value: task.id,
    });
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: translator.t('card.btn.delete') },
      style: 'danger',
      action_id: 'task_delete',
      value: task.id,
    });
  }

  if (actionElements.length > 0) {
    blocks.push({ type: 'actions', elements: actionElements });
  }

  return blocks;
}

export function buildTaskFallbackText(
  task: RenderableTask,
  translator: Translator = defaultTranslator
): string {
  return `[${translator.statusLabel(task.status)}] ${task.title} • ${translator.t(
    'card.due'
  )} ${task.time.toLocaleString()}`;
}
