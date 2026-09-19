import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, one, maybe, rows, type Actor, type Db } from '../common/index.js';

export { z, randomUUID, AppError, one, maybe, rows };
export const uuid = z.string().uuid();
export const version = z.number().int().positive().safe();
export const reason = z.string().trim().min(1).max(200);
export const note = z.string().trim().max(200).default('');
export const ids = z.array(uuid).min(1).max(100).refine(a => new Set(a).size === a.length, '不能重复选择孩子');
export const mediaIds = z.array(uuid).max(3).refine(a => new Set(a).size === a.length, '不能重复选择照片').default([]);
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, '日期无效');
export const instant = z.string().datetime({ offset: true });
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const today = (now = new Date()) => new Date(now.getTime() + 8 * HOUR).toISOString().slice(0, 10);
export const dayStart = (date: string) => new Date(`${date}T00:00:00+08:00`);
export const dayEnd = (date: string) => new Date(dayStart(date).getTime() + DAY);
export const addDays = (date: string, amount: number) => today(new Date(dayStart(date).getTime() + amount * DAY));
export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
export const weekStart = (now = new Date()) => addDays(today(now), 1 - weekday(today(now)));
export function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError(409, 'VERSION_CONFLICT', '数据已更新，请查看最新内容', { currentVersion: actual });
}
export function must(value: unknown, code: string, message: string, status = 409): asserts value {
  if (!value) throw new AppError(status, code, message);
}
export function target(actor: Actor, familyId: string, childId: string) {
  if (actor.mode !== 'GUARDIAN' && actor.mode !== 'CHILD') throw new AppError(403, 'FORBIDDEN', '请进入有效家庭');
  if (actor.mode === 'CHILD' && (actor.familyId !== familyId || actor.childId !== childId)) throw new AppError(404, 'RESOURCE_NOT_FOUND', '记录不存在');
}
export async function activeChild(db: Db, familyId: string, childId: string) {
  const child = await maybe<any>(db, 'SELECT * FROM child_profiles WHERE family_id=$1 AND id=$2', [familyId, childId]);
  if (!child) throw new AppError(404, 'RESOURCE_NOT_FOUND', '孩子档案不存在');
  must(child.status === 'ACTIVE', 'INVALID_STATE', '孩子已归档，当前只能查看历史');
  return child;
}
export async function validateChildren(db: Db, familyId: string, childIds: string[]) {
  const children = await rows<any>(db, "SELECT * FROM child_profiles WHERE family_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'", [familyId, childIds]);
  must(children.length === childIds.length, 'NOT_APPLICABLE', '所选孩子已归档或不属于当前家庭');
  return children;
}
export async function serverNow(db: Db): Promise<Date> {
  const row = await one<{ now: string }>(db, 'SELECT clock_timestamp() AS now');
  return new Date(row.now);
}
export function params(request: any) { return request.params as Record<string, string>; }
export function idParam(request: any, key: string) { return uuid.parse(params(request)[key]); }
export const listQuery = z.object({ cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
export function paging(query: any, scope: unknown) {
  const { limit, cursor } = listQuery.parse(query);
  const signature = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  let after: { createdAt: string; id: string } | null = null;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.scope !== signature) throw new Error('scope');
      after = { createdAt: instant.parse(parsed.createdAt), id: uuid.parse(parsed.id) };
    } catch { throw new AppError(400, 'VALIDATION_ERROR', '分页位置无效，请重新加载'); }
  }
  return {
    limit, after,
    result<T extends { createdAt: string; id: string }>(records: T[]) {
      const hasMore = records.length > limit;
      const items = records.slice(0, limit);
      const last = items.at(-1);
      return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ scope: signature, createdAt: last.createdAt, id: last.id })).toString('base64url') : null };
    },
  };
}
export function range(query: any, maxDays = 366) {
  const end = dateString.parse(query.dateTo ?? today());
  const start = dateString.parse(query.dateFrom ?? addDays(end, -29));
  must(start <= end && dayStart(end).getTime() - dayStart(start).getTime() < maxDays * DAY, 'VALIDATION_ERROR', `请选择不超过${maxDays}天的日期范围`, 400);
  return { from: start, to: end };
}
export const occurrenceStatuses = ['OPEN','SUBMITTED','NEEDS_CHANGES','APPROVED','EXEMPTED','REVOKED'] as const;
export const orderStatuses = ['PENDING_APPROVAL','READY','FULFILLED','REJECTED','CANCELED','EXPIRED'] as const;
export function enumFilter(value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new AppError(400, 'VALIDATION_ERROR', '筛选条件无效');
  return value;
}
export function accountView(account: any) {
  return { ...account, totalHeldPoints: account.availablePoints + account.heldPoints, grantBlockedByCap: account.availablePoints + account.heldPoints >= 1000000 };
}
