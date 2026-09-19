import { createHash, createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
export { z, randomUUID };
export type Db = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<Db, 'query'>;
pg.types.setTypeParser(20, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('INTEGER_OVERFLOW'); return n; });
pg.types.setTypeParser(1700, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('INTEGER_OVERFLOW'); return n; });
pg.types.setTypeParser(1082, value => value);
export function camel<T = any>(value: any): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (Buffer.isBuffer(value)) return value as T;
  if (Array.isArray(value)) return value.map(v => camel(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),camel(v)])) as T;
  return value;
}
export async function rows<T = any>(db: Queryable, sql: string, values: any[] = []): Promise<T[]> { return camel((await db.query(sql,values)).rows); }
export async function maybe<T = any>(db: Queryable, sql: string, values: any[] = []): Promise<T | null> { return (await rows<T>(db,sql,values))[0] ?? null; }
export async function one<T = any>(db: Queryable, sql: string, values: any[] = []): Promise<T> { const r = await maybe<T>(db,sql,values); if (!r) throw new AppError(404,'RESOURCE_NOT_FOUND','内容不存在或无权访问'); return r; }
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); this.name = 'AppError'; }
  get statusCode() { return this.status; }
}
export type Mode = 'PROFILE_ONLY'|'LOCKED'|'ACCOUNT'|'GUARDIAN'|'CHILD';
export interface Actor { userId: string; sessionId: string; mode: Mode; childSessionSource?: 'DIRECT'|'DELEGATED' | null; familyId?: string | null; childId?: string | null; securityVersion: number; membershipId?: string | null; role?: string | null; bindingVersion?: number | null; sourceSessionId?: string | null; pinVerifiedAt?: string | null; actorScopeKey?: string; accountScopeKey?: string; [key: string]: any; }
export interface Requirements { familyId?: string; childId?: string; guardian?: boolean; owner?: boolean; profile?: boolean; write?: boolean; allowArchived?: boolean; [key: string]: any; }
export interface MutationOptions extends Requirements { exclusiveFamily?: boolean; exclusiveUser?: boolean; extraUserIds?: string[]; scope?: string; status?: number; protectionBarrier?: string; }
export interface Config {
 appEnv: string; nodeEnv: string; port: number; host: string; databaseUrl: string; apiBaseUrl: string; wechatAppId: string; wechatAppSecret: string; sessionSigningKey: string; responseEncryptionKey: string; mediaDir: string; exportDir: string; securityJournalDir: string; securityJournalKey: string; businessTimezone: string; supportContact: string; privacyVersion: string; accessTokenTtlSeconds: number; refreshTokenTtlDays: number; [key: string]: any;
}
export interface Services { pool: pg.Pool; config: Config; auth: any; media: any; domain?: any; privacy?: any; mutate: (request: FastifyRequest, options: MutationOptions, fn: (db: Db, actor: Actor) => Promise<any>) => Promise<any>; flushProtection?: (barrier: string) => Promise<boolean>; [key: string]: any; }
export const responseStatus = Symbol('status');
export const replayHeader = Symbol('replay');
export function ok(request: FastifyRequest | {id?: string}, data: any, status?: number): any { const result: any = {data,requestId:request.id || randomUUID(),serverTime:new Date().toISOString()}; if(status) result[responseStatus]=status; return result; }
export function committed(data: any, status = 200) { return { __committedReply: true, data, status }; }
export function canonical(value: any): string { if (value === undefined) return 'null'; if (value === null || typeof value !== 'object') return JSON.stringify(value); if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']'; return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'; }
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export function actorScope(actor: Actor, scope?: string): string { return scope === 'PROFILE_SELF' ? `${actor.userId}:PROFILE_SELF` : [actor.userId,actor.mode,actor.familyId||'',actor.childId||'',actor.childSessionSource||''].join(':'); }
export function opaqueScope(actor: Actor, key: string, scope?: string) { return createHmac('sha256',key).update(actorScope(actor,scope)).digest('base64url'); }
export async function audit(db: Db, actor: Actor | null, action: string, input: { familyId?: string | null; childId?: string | null; sourceId?: string | null; details?: any } = {}) {
 await db.query('INSERT INTO audit_logs (family_id,child_id,actor_user_id,actor_mode,action,source_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7)',[input.familyId||actor?.familyId||null,input.childId||null,actor?.userId||null,actor?.mode||'SYSTEM',action,input.sourceId||null,JSON.stringify(input.details||{})]);
}
export async function outbox(db: Db, eventKey: string, eventType: string, payload: any) { await db.query('INSERT INTO outbox (event_key,event_type,payload) VALUES ($1,$2,$3) ON CONFLICT (event_key) DO NOTHING',[eventKey,eventType,JSON.stringify(payload)]); }
export async function transaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> { const db=await pool.connect(); try { await db.query(`BEGIN ISOLATION LEVEL ${isolation==='REPEATABLE READ'?'REPEATABLE READ':'READ COMMITTED'}`); await db.query("SET LOCAL lock_timeout = '5s'"); await db.query("SET LOCAL statement_timeout = '15s'"); const result=await fn(db); await db.query('COMMIT'); return result; } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); } }
export function createMutationRunner(services: Services) {
 return async (request: FastifyRequest, options: MutationOptions, fn: (db: Db, actor: Actor) => Promise<any>) => {
  const actor: Actor = await services.auth.require(request, options);
  const key = request.headers['idempotency-key'];
  if(typeof key!=='string'||!z.string().uuid().safeParse(key).success) throw new AppError(400,'IDEMPOTENCY_KEY_REQUIRED','请携带本次操作的唯一编号');
  const path=request.url.split('?')[0]; const method=request.method; const scope=actorScope(actor,options.scope); const hash=sha256(canonical(request.body??{}));
  for(let attempt=0;attempt<3;attempt++) {
   try {
    const result=await transaction(services.pool,async db=>{
     for(const userId of [...new Set([actor.userId,...(options.extraUserIds||[])])].sort()) { z.string().uuid().parse(userId);await one(db,`SELECT id FROM users WHERE id=$1 FOR ${userId===actor.userId&&(options.exclusiveUser||options.scope==='PROFILE_SELF')?'UPDATE':'SHARE'}`,[userId]); }
     if(options.familyId) await one(db,`SELECT id FROM families WHERE id=$1 FOR ${options.exclusiveFamily?'UPDATE':'SHARE'}`,[options.familyId]);
     const current: Actor = (await services.auth.recheck(db,actor,{...options,write:true})) || actor;
     await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[[scope,method,path,key].join('|')]);
     const prior=await maybe(db,'SELECT * FROM operation_records WHERE actor_scope=$1 AND method=$2 AND path=$3 AND key=$4',[scope,method,path,key]);
     if(prior) { if(prior.requestHash!==hash) throw new AppError(409,'IDEMPOTENCY_MISMATCH','这个操作编号已用于不同内容'); return {data:prior.response,status:prior.statusCode,replayed:true,barrier:prior.protectionBarrier}; }
     const response=await fn(db,current); const special=response?.__committedReply; const data=special?response.data:response; const status=special?response.status:options.status||200;
     await db.query('INSERT INTO operation_records(actor_scope,method,path,key,request_hash,status_code,response,protection_barrier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[scope,method,path,key,hash,status,JSON.stringify(data??null),options.protectionBarrier||null]);
     return {data,status,replayed:false,barrier:options.protectionBarrier};
    });
    if(result.barrier && (!services.flushProtection || !await services.flushProtection(result.barrier))) throw new AppError(202,'OPERATION_IN_PROGRESS','安全变更正在持久保存，请用原操作编号查询');
    const response=ok(request,result.data,result.status); if(result.replayed) response[replayHeader]=true; return response;
   } catch(error:any) { if(['40001','40P01'].includes(error?.code) && attempt<2) continue; throw error; }
  }
 };
}
export function list<T>(items: T[], nextCursor: string | null = null, extra: any = {}) { return {items,nextCursor,hasMore:!!nextCursor,...extra}; }
export function assertVersion(actual: number, expected: unknown) { if(!Number.isSafeInteger(expected)||actual!==expected) throw new AppError(409,'VERSION_CONFLICT','内容已更新，请刷新后再操作',{currentVersion:actual}); }
export function dayInShanghai(now: Date | string = new Date()): string { return new Date(new Date(now).getTime()+8*3600000).toISOString().slice(0,10); }
export function dayStart(date: string): Date { if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400,'VALIDATION_ERROR','日期格式应为YYYY-MM-DD'); return new Date(date+'T00:00:00+08:00'); }
export function addDays(date: string, days: number): string { return dayInShanghai(new Date(dayStart(date).getTime()+days*86400000)); }
export async function queueProtection(db: Db, kind: string, payload: any): Promise<string> { const id=randomUUID(); await db.query("INSERT INTO outbox(id,event_key,event_type,payload) VALUES($1,$2,'SECURITY_PROTECTION',$3)",[id,`security:${id}`,JSON.stringify({kind,...payload})]); return id; }
