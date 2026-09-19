import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ZodError } from 'zod';
import { AppError, createMutationRunner, responseStatus, replayHeader, ok, actorScope, maybe, type Config, type Services } from './common/index.js';
import { loadConfig } from './common/config.js';
import { securityJournal } from './common/security-journal.js';
import { createAuth, registerIdentity } from './identity/index.js';
import { createMedia, registerMedia } from './media/index.js';
import { registerFamily } from './family/index.js';
import { registerPrivacy } from './privacy/index.js';
import { registerDomain, createDomain } from './domain/index.js';

export async function buildApp(config:Config=loadConfig()) {
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:12,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
 const app=Fastify({logger:config.appEnv==='test'?false:{level:'info',redact:['req.headers.authorization','req.headers.cookie','body','res.headers']},disableRequestLogging:true,genReqId:()=>randomUUID(),rewriteUrl(raw){const override=raw.headers['x-http-method-override'];if(override){if(raw.method==='POST'&&override==='PATCH')raw.method='PATCH';else(raw as any).invalidMethodOverride=true;}return raw.url||'/';},bodyLimit:11*1024*1024,trustProxy:'127.0.0.1'});
 const services={pool,config,publicRoutes:[]} as unknown as Services;app.addHook('onRoute',route=>{for(const method of Array.isArray(route.method)?route.method:[route.method])if(method!=='HEAD')services.publicRoutes.push({method,path:route.url});});services.auth=createAuth(services);services.media=createMedia(services);services.mutate=createMutationRunner(services);services.domain=createDomain(services);
 const flush=securityJournal(services);services.flushSecurityJournal=flush;services.flushProtection=async()=>{await flush();return true;};
 await app.register(cors,{origin:config.appEnv==='local'?['http://localhost:5173','http://127.0.0.1:5173','http://localhost:4173','http://127.0.0.1:4173']:false,allowedHeaders:['authorization','content-type','idempotency-key','x-http-method-override'],methods:['GET','POST','PUT','PATCH','DELETE']});
 await app.register(multipart,{limits:{fileSize:10*1024*1024,files:1,fields:12,parts:14},throwFileSizeLimit:true});
 await app.register(rateLimit,{max:config.appEnv==='test'?100000:240,timeWindow:'1 minute',keyGenerator:request=>request.ip});
 app.addHook('onRequest',async request=>{if((request.raw as any).invalidMethodOverride)throw new AppError(400,'INVALID_METHOD_OVERRIDE','只允许POST请求以PATCH方式提交');});
 app.setErrorHandler((error:any,request,reply)=>{
  let status=error.status||error.statusCode||500,code=error.code||'INTERNAL_ERROR',message=error.message||'服务暂不可用',details=error.details;
  if(error instanceof ZodError){status=400;code='VALIDATION_ERROR';message='请检查填写内容';details={fields:error.issues.map(x=>({path:x.path.join('.'),message:x.message}))};}
  else if(error.code==='23505'){status=409;code='CONFLICT';message='此操作与现有记录冲突，请刷新后重试';}
  else if(error.code==='23503'||error.code==='23514'){status=409;code='INVALID_STATE';message='当前数据状态不允许此操作';}
  if(status>=500){message='服务暂不可用，请稍后用原操作编号重试';code='INTERNAL_ERROR';app.log.error({requestId:request.id,errorCode:error.code||error.name},'Request failed');}
  reply.code(status).send({error:{code,message,...(details?{details}:{})},requestId:request.id,serverTime:new Date().toISOString()});
 });
 app.addHook('preSerialization',async(request,reply,payload:any)=>{
  if(payload&&typeof payload==='object'){
   if(payload[responseStatus])reply.code(payload[responseStatus]);if(payload[replayHeader])reply.header('Idempotency-Replayed','true');
   if('data'in payload){try{await flush();}catch{reply.code(202);return{error:{code:'OPERATION_IN_PROGRESS',message:'安全变更正在持久保存，请稍后查询原操作'},requestId:request.id,serverTime:new Date().toISOString()};}}
  }return payload;
 });
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');return payload;});
 await app.register(async api=>{
  api.get('/health',async request=>{await pool.query('SELECT 1');return ok(request,{status:'ok',version:'1.0.0'});});
  await registerIdentity(api,services);await registerMedia(api,services);await registerFamily(api,services);await registerDomain(api,services);await registerPrivacy(api,services);
  api.get('/operations/:key',async request=>{
   const q=request.query as any,p=request.params as any;if(!['POST','PUT','PATCH','DELETE'].includes(q.method)||typeof q.path!=='string'||typeof p.key!=='string')throw new AppError(400,'VALIDATION_ERROR','请提供原请求方法与路径');
   const concretePath=q.path.startsWith('/api/v1/')?q.path:'/api/v1'+q.path;const profile=concretePath==='/api/v1/me/profile'&&q.method==='PUT';const actor=await services.auth.require(request,{profile:!profile,account:profile});const scope=actorScope(actor,profile?'PROFILE_SELF':undefined);
   const prior=await maybe(pool,'SELECT * FROM operation_records WHERE actor_scope=$1 AND method=$2 AND path=$3 AND key=$4',[scope,q.method,concretePath,p.key]);
   return ok(request,prior?{state:'SUCCEEDED',result:prior.response,statusCode:prior.statusCode}:{state:'NOT_OBSERVED',retryWithSameKey:true});
  });
 },{prefix:'/api/v1'});
 app.addHook('onClose',async()=>{await pool.end();});
 return {app,services};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {app,services}=await buildApp(); await app.listen({port:services.config.port,host:services.config.host});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}
