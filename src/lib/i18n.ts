import { TaskStatus, TaskPriority } from '@prisma/client';

export type SupportedLanguage = 'en' | 'zh';

function pickLanguage(value?: string | null): SupportedLanguage {
  if (!value) return 'en';
  const lc = value.toLowerCase();
  if (lc.startsWith('zh') || lc === 'chinese' || lc === '中文') return 'zh';
  return 'en';
}

const ENV_LANGUAGE: SupportedLanguage = pickLanguage(process.env.OWNER_LANGUAGE);

const STATUS_LABEL: Record<SupportedLanguage, Record<TaskStatus, string>> = {
  en: {
    PENDING_CLARIFICATION: 'Awaiting clarification',
    NOT_STARTED: 'Not started',
    IN_PROGRESS: 'In progress',
    BLOCKED: 'Blocked',
    COMPLETED: 'Completed',
    FAILED: 'Not completed',
    CANCELLED: 'Cancelled',
  },
  zh: {
    PENDING_CLARIFICATION: '等待澄清',
    NOT_STARTED: '未开始',
    IN_PROGRESS: '进行中',
    BLOCKED: '受阻',
    COMPLETED: '已完成',
    FAILED: '未完成',
    CANCELLED: '已取消',
  },
};

const STATUS_ICON: Record<TaskStatus, string> = {
  PENDING_CLARIFICATION: '❓',
  NOT_STARTED: '🕒',
  IN_PROGRESS: '🚧',
  BLOCKED: '⛔',
  COMPLETED: '✅',
  FAILED: '❌',
  CANCELLED: '🚫',
};

const PRIORITY_BADGE: Record<SupportedLanguage, Record<TaskPriority, string>> = {
  en: {
    LOW: '🟢 LOW',
    NORMAL: '🟡 NORMAL',
    HIGH: '🟠 HIGH',
    URGENT: '🔴 URGENT',
  },
  zh: {
    LOW: '🟢 低',
    NORMAL: '🟡 普通',
    HIGH: '🟠 高',
    URGENT: '🔴 紧急',
  },
};

type CommonKey =
  | 'home.title'
  | 'home.hint'
  | 'home.summary.needInput'
  | 'home.summary.inFlight'
  | 'home.summary.blocked'
  | 'home.summary.overdue'
  | 'home.summary.done'
  | 'home.summary.clean'
  | 'home.group.needsInput'
  | 'home.group.inFlight'
  | 'home.group.blocked'
  | 'home.group.overdue'
  | 'home.group.completed'
  | 'home.group.other'
  | 'home.empty'
  | 'card.due'
  | 'card.assignee'
  | 'card.from'
  | 'card.progress'
  | 'card.noUpdates'
  | 'card.overdueTag'
  | 'card.reason'
  | 'card.btn.complete'
  | 'card.btn.modify'
  | 'card.btn.delete'
  | 'list.headerPending'
  | 'list.headerCompleted'
  | 'list.empty'
  | 'list.emptyAll'
  | 'list.emptyCompleted'
  | 'list.summary'
  | 'time.justNow'
  | 'time.minutesAgo'
  | 'time.hoursAgo'
  | 'time.daysAgo';

const COMMON: Record<SupportedLanguage, Record<CommonKey, string>> = {
  en: {
    'home.title': '📊 AI COO — Operations Dashboard',
    'home.hint':
      '_Mention the bot in any channel to assign work. I will clarify, follow up, and report progress here automatically._',
    'home.summary.needInput': '{n} need input',
    'home.summary.inFlight': '{n} in flight',
    'home.summary.blocked': '{n} blocked',
    'home.summary.overdue': '{n} overdue',
    'home.summary.done': '{n} done',
    'home.summary.clean': '_Everything is clear._',
    'home.group.needsInput': '❓ Needs your input',
    'home.group.inFlight': '🚧 In flight',
    'home.group.blocked': '⛔ Blocked',
    'home.group.overdue': '⚠️ Overdue',
    'home.group.completed': '✅ Completed (recent)',
    'home.group.other': '🗂 Other (cancelled / failed)',
    'home.empty':
      '🎉 _No tasks yet. Mention me in any channel to assign work — e.g._ `@AI COO ask Luna to finalize the Q4 deck by Friday EOD.`',
    'card.due': 'Due',
    'card.assignee': 'Assignee',
    'card.from': 'From',
    'card.progress': 'Progress',
    'card.noUpdates': '_No updates yet._',
    'card.overdueTag': '⚠️ overdue',
    'card.reason': 'Reason',
    'card.btn.complete': '✅ Mark complete',
    'card.btn.modify': '✏️ Modify',
    'card.btn.delete': '🗑️ Delete',
    'list.headerPending': '📋 Your Tasks',
    'list.headerCompleted': '✅ Completed Tasks',
    'list.empty': '📋 You have no pending tasks!',
    'list.emptyAll': '📋 You have no tasks!',
    'list.emptyCompleted': '📋 You have no completed tasks!',
    'list.summary': 'You have {n} tasks',
    'time.justNow': 'just now',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.daysAgo': '{n}d ago',
  },
  zh: {
    'home.title': '📊 AI COO — 任务运营看板',
    'home.hint':
      '_在任意频道 @ 我即可下发任务。我会主动澄清细节、定期跟进员工进度，并把状态实时同步到这里。_',
    'home.summary.needInput': '{n} 项待补充',
    'home.summary.inFlight': '{n} 项进行中',
    'home.summary.blocked': '{n} 项受阻',
    'home.summary.overdue': '{n} 项逾期',
    'home.summary.done': '{n} 项已完成',
    'home.summary.clean': '_当前没有需要关注的任务。_',
    'home.group.needsInput': '❓ 需要您补充信息',
    'home.group.inFlight': '🚧 进行中',
    'home.group.blocked': '⛔ 受阻',
    'home.group.overdue': '⚠️ 已逾期',
    'home.group.completed': '✅ 最近完成',
    'home.group.other': '🗂 其他（已取消 / 未完成）',
    'home.empty':
      '🎉 _暂无任务。在频道里 @ 我即可下发任务，例如：_ `@AI COO 让 Luna 在周五下班前完成 Q4 方案`',
    'card.due': '截止',
    'card.assignee': '负责人',
    'card.from': '发起人',
    'card.progress': '进度',
    'card.noUpdates': '_暂无更新。_',
    'card.overdueTag': '⚠️ 已逾期',
    'card.reason': '原因',
    'card.btn.complete': '✅ 标记完成',
    'card.btn.modify': '✏️ 修改',
    'card.btn.delete': '🗑️ 删除',
    'list.headerPending': '📋 你的任务',
    'list.headerCompleted': '✅ 已完成任务',
    'list.empty': '📋 当前没有待办任务。',
    'list.emptyAll': '📋 当前没有任务。',
    'list.emptyCompleted': '📋 暂无已完成任务。',
    'list.summary': '共 {n} 条任务',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.daysAgo': '{n} 天前',
  },
};

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
}

export type Translator = {
  language: SupportedLanguage;
  t: (key: CommonKey, params?: Record<string, string | number>) => string;
  statusLabel: (status: TaskStatus) => string;
  statusIcon: (status: TaskStatus) => string;
  priorityBadge: (priority: TaskPriority) => string;
  relativeTime: (at: Date | null | undefined) => string;
};

export function getTranslator(language?: SupportedLanguage | string | null): Translator {
  const lang: SupportedLanguage =
    typeof language === 'string' ? pickLanguage(language) : language || ENV_LANGUAGE;
  const common = COMMON[lang];
  const status = STATUS_LABEL[lang];
  const priority = PRIORITY_BADGE[lang];

  return {
    language: lang,
    t: (key, params) => format(common[key], params),
    statusLabel: (s) => status[s] ?? s,
    statusIcon: (s) => STATUS_ICON[s] ?? '•',
    priorityBadge: (p) => priority[p] ?? '',
    relativeTime: (at) => relativeTime(at, lang),
  };
}

function relativeTime(at: Date | null | undefined, lang: SupportedLanguage): string {
  if (!at) return '—';
  const ms = Date.now() - at.getTime();
  const common = COMMON[lang];
  if (ms < 60_000) return common['time.justNow'];
  if (ms < 3_600_000) return format(common['time.minutesAgo'], { n: Math.round(ms / 60_000) });
  if (ms < 86_400_000) return format(common['time.hoursAgo'], { n: Math.round(ms / 3_600_000) });
  return format(common['time.daysAgo'], { n: Math.round(ms / 86_400_000) });
}

export const defaultTranslator = getTranslator();
