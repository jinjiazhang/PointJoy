import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const responseStatus = Symbol('status');

export const replayHeader = Symbol('replay');

export function ok(request: FastifyRequest | { id?: string }, data: any, status?: number): any {
  const result: any = {
    data,
    requestId: request.id || randomUUID(),
    serverTime: new Date().toISOString(),
  };
  if (status) {
    result[responseStatus] = status;
  }
  return result;
}

export function committed(data: any, status = 200) {
  return { __committedReply: true, data, status };
}

export function list<T>(items: T[], nextCursor: string | null = null, extra: any = {}) {
  return { items, nextCursor, hasMore: !!nextCursor, ...extra };
}
