import { createHash, createHmac } from 'node:crypto';
import { AppError } from './errors.js';
import type { Actor } from './types.js';

export function canonical(value: any): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') +
    '}'
  );
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function actorScope(actor: Actor, scope?: string): string {
  return scope === 'PROFILE_SELF'
    ? `${actor.userId}:PROFILE_SELF`
    : [
        actor.userId,
        actor.mode,
        actor.familyId || '',
        actor.childId || '',
        actor.childSessionSource || '',
      ].join(':');
}

export function opaqueScope(actor: Actor, key: string, scope?: string) {
  return createHmac('sha256', key).update(actorScope(actor, scope)).digest('base64url');
}

export function assertVersion(actual: number, expected: unknown) {
  if (!Number.isSafeInteger(expected) || actual !== expected) {
    throw new AppError(409, 'VERSION_CONFLICT', '内容已更新，请刷新后再操作', {
      currentVersion: actual,
    });
  }
}

export function dayInShanghai(now: Date | string = new Date()): string {
  return new Date(new Date(now).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

export function dayStart(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError(400, 'VALIDATION_ERROR', '日期格式应为YYYY-MM-DD');
  }
  return new Date(date + 'T00:00:00+08:00');
}

export function addDays(date: string, days: number): string {
  return dayInShanghai(new Date(dayStart(date).getTime() + days * 86400000));
}
