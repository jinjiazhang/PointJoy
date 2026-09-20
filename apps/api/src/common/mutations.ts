import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { maybe, one, transaction } from './database.js';
import { ok, replayHeader } from './responses.js';
import { actorScope, canonical, sha256 } from './utilities.js';
import type { Actor, Db, MutationOptions, Services } from './types.js';

export function createMutationRunner(services: Services) {
  return async (
    request: FastifyRequest,
    options: MutationOptions,
    fn: (db: Db, actor: Actor) => Promise<any>,
  ) => {
    const actor: Actor = await services.auth.require(request, options);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !z.string().uuid().safeParse(key).success) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请携带本次操作的唯一编号');
    }
    const path = request.url.split('?')[0];
    const method = request.method;
    const scope = actorScope(actor, options.scope);
    const hash = sha256(canonical(request.body ?? {}));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await transaction(services.pool, async (db) => {
          for (const userId of [
            ...new Set([actor.userId, ...(options.extraUserIds || [])]),
          ].sort()) {
            z.string().uuid().parse(userId);
            await one(
              db,
              `SELECT id FROM users WHERE id=$1 FOR ${userId === actor.userId && (options.exclusiveUser || options.scope === 'PROFILE_SELF') ? 'UPDATE' : 'SHARE'}`,
              [userId],
            );
          }
          if (options.familyId) {
            await one(
              db,
              `SELECT id FROM families WHERE id=$1 FOR ${options.exclusiveFamily ? 'UPDATE' : 'SHARE'}`,
              [options.familyId],
            );
          }
          const current: Actor =
            (await services.auth.recheck(db, actor, { ...options, write: true })) || actor;
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            [scope, method, path, key].join('|'),
          ]);
          const prior = await maybe(
            db,
            'SELECT * FROM operation_records WHERE actor_scope=$1 AND method=$2 AND path=$3 AND key=$4',
            [scope, method, path, key],
          );
          if (prior) {
            if (prior.requestHash !== hash) {
              throw new AppError(409, 'IDEMPOTENCY_MISMATCH', '这个操作编号已用于不同内容');
            }
            return {
              data: prior.response,
              status: prior.statusCode,
              replayed: true,
              barrier: prior.protectionBarrier,
            };
          }
          const response = await fn(db, current);
          const special = response?.__committedReply;
          const data = special ? response.data : response;
          const status = special ? response.status : options.status || 200;
          await db.query(
            'INSERT INTO operation_records(actor_scope,method,path,key,request_hash,status_code,response,protection_barrier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              scope,
              method,
              path,
              key,
              hash,
              status,
              JSON.stringify(data ?? null),
              options.protectionBarrier || null,
            ],
          );
          return { data, status, replayed: false, barrier: options.protectionBarrier };
        });
        if (
          result.barrier &&
          (!services.flushProtection || !(await services.flushProtection(result.barrier)))
        ) {
          throw new AppError(
            202,
            'OPERATION_IN_PROGRESS',
            '安全变更正在持久保存，请用原操作编号查询',
          );
        }
        const response = ok(request, result.data, result.status);
        if (result.replayed) {
          response[replayHeader] = true;
        }
        return response;
      } catch (error: any) {
        if (['40001', '40P01'].includes(error?.code) && attempt < 2) {
          continue;
        }
        throw error;
      }
    }
  };
}
