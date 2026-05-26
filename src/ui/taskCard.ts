import { Task } from '@prisma/client';
import { toSlackMention } from '../utils/assignee';
import { buildProgressBar } from './progressBar';
import { detectLanguageFromTexts, getTranslator, Translator } from '../lib/i18n';
import { formatDateTime } from '../lib/timezone';

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
  // If the caller didn't pre-pick a language, detect from this task's own text.
  // Single-task surfaces (channel card, action edit) work this way; surfaces that
  // render many tasks (Home Tab, list view) pre-supply a translator built from
  // the whole set so individual cards don't flicker between languages.
  const {
    variant = 'channel',
    showActions = true,
    translator = getTranslator(detectLanguageFromTexts([task.title, task.description, task.lastProgressSummary])),
  } = options;
  const statusIcon = translator.statusIcon(task.status);
  const statusLabel = translator.statusLabel(task.status);
  const priorityBadge = translator.priorityBadge(task.priority);
  const progressBar = buildProgressBar(task.progressPercent);
  // No viewer TZ available at this layer — Home tab + list view render synchronously
  // from in-memory Task objects, no Slack client in scope. Fall back to the workspace
  // default. For the dashboard and individual DMs we DO use the per-user TZ.
  const dueText = formatDateTime(task.time, {
    tz: process.env.DEFAULT_TIMEZONE,
    locale: translator.language,
  });
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
  translator?: Translator
): string {
  const t =
    translator ??
    getTranslator(detectLanguageFromTexts([task.title, task.description, task.lastProgressSummary]));
  const due = formatDateTime(task.time, { tz: process.env.DEFAULT_TIMEZONE, locale: t.language });
  return `[${t.statusLabel(task.status)}] ${task.title} • ${t.t('card.due')} ${due}`;
}
