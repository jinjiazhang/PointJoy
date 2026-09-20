import { serverOffset } from './api';
export const now = () => Date.now() + serverOffset;
export function businessDate(value: number | string = now()) {
  const d = new Date(typeof value === 'number' ? value : Date.parse(value));
  if (!Number.isFinite(d.getTime())) {
    return '';
  }
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function dateTime(value?: string | null) {
  if (!value) {
    return '—';
  }
  const d = new Date(Date.parse(value) + 8 * 3600000);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ');
}
export function toUtc(date: string, time = '00:00') {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}
export function daysAgo(days: number) {
  return businessDate(now() - days * 86400000);
}
export const labels: Record<string, string> = {
  OPEN: '等你完成',
  SUBMITTED: '等待家长确认',
  NEEDS_CHANGES: '再补充一下',
  APPROVED: '已完成',
  EXEMPTED: '本次休息',
  REVOKED: '积分已更正',
  PENDING_APPROVAL: '等待家长同意',
  READY: '等待兑现',
  FULFILLED: '已兑现',
  REJECTED: '未批准',
  CANCELED: '已取消',
  EXPIRED: '已过期',
  DRAFT: '草稿',
  ACTIVE: '生效中',
  INACTIVE: '已下架',
  ARCHIVED: '已归档',
  PUBLISHED: '已发布',
  PAUSED: '已暂停',
  STOPPED: '已停止',
  ROUTINE: '日常',
  CHALLENGE: '一次挑战',
  CHECK: '完成即可',
  COUNT: '次数',
  DURATION: '整分钟',
  DISTANCE: '整米',
  TIME: '时间奖励',
  FOOD: '美味奖励',
  ITEM: '物品奖励',
  EXPERIENCE: '共同体验',
  OWNER: '家庭负责人',
  GUARDIAN: '共同家长',
  CHILD: '孩子',
  NOT_STARTED: '尚未开始',
  OVERDUE: '已截止',
  WINDOW_CLOSED: '已截止',
  SUPPLEMENT_EXPIRED: '补充已截止',
  RECEIVED: '申请已收到',
  VERIFYING: '核对中',
  PROCESSING: '处理中',
  COMPLETED: '已完成',
  NEEDS_ACTION: '需要补充处理',
  FAILED_RETRYABLE: '处理失败，可重试',
  WITHDRAWN: '已撤回',
  PENDING: '等待处理',
  ACTIVITY_AWARD: '活动奖励',
  PRAISE: '手动表扬',
  ORDER_HOLD: '申请预留',
  ORDER_CAPTURE: '兑换支出',
  ORDER_RELEASE: '预留释放',
  ORDER_REFUND: '兑换退款',
  AWARD_REVERSAL: '记录更正',
  REVERSAL: '记录更正',
  SUPPLEMENT_OVERDUE: '补充已截止',
  CONSUMED: '已使用',
  REP: '次',
  MINUTE: '分钟',
  METER: '米',
};
export const label = (key?: string) => (key ? labels[key] || key : '—');
export const unit = (metric: string, u?: string) =>
  metric === 'COUNT'
    ? u === 'ITEM'
      ? '个'
      : '次'
    : metric === 'DURATION'
      ? '分钟'
      : metric === 'DISTANCE'
        ? '米'
        : '';
export function integer(value: unknown, min: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value);
  return value !== '' && value !== null && Number.isSafeInteger(n) && n >= min && n <= max;
}
export function displayOperator(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as { displayName?: string; name?: string };
    if (obj.displayName || obj.name) {
      return obj.displayName || obj.name!;
    }
  }
  return '家长';
}
export function actionAllowed(actions: string[] | undefined, ...names: string[]) {
  return (actions || []).some(
    (a) => names.includes(a) || names.map((n) => n.toLowerCase()).includes(a.toLowerCase()),
  );
}
