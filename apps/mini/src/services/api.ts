import { loadAuth, saveAuth, clearAuth, uuid } from './vault'
import type { Tokens } from './types'
export const API_BASE = (import.meta.env?.VITE_API_BASE_URL || 'https://pointjoy.jinjiazh.com/api/v1').replace(/\/$/,'')
export type HttpMethod = 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'
export class ApiError extends Error { constructor(public code:string,message:string,public details:Record<string,unknown>={},public status=0,public requestId=''){super(message);this.name='ApiError'} }
interface Envelope<T>{data:T;error?:{code:string;message:string;details?:Record<string,unknown>};requestId:string;serverTime:string}
export interface PendingOperation {key:string;scope:string;method:HttpMethod;path:string;body:unknown;label:string;createdAt:string;state:'SENDING'|'UNKNOWN';requestId?:string}
const PENDING='pointjoy.operations.v1';const inflight=new Map<string,Promise<unknown>>();let refreshPromise:Promise<void>|null=null
export let serverOffset=0
export function pendingOperations():PendingOperation[]{try{return uni.getStorageSync(PENDING)||[]}catch{return[]}}
function persist(items:PendingOperation[]){uni.setStorageSync(PENDING,items);uni.$emit('operations:changed')}
function scopeFor(path:string){const s=loadAuth()?.session;return path==='/me/profile'?s?.accountScopeKey:s?.actorScopeKey}
export function currentPending(){const s=loadAuth()?.session;return pendingOperations().filter(o=>o.scope===s?.actorScopeKey||o.path==='/me/profile'&&o.scope===s?.accountScopeKey)}
export function query(params:Record<string,unknown>={}){const parts=Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);return parts.length?'?'+parts.join('&'):''}
async function transport<T>(method:HttpMethod,path:string,body?:unknown,headers:Record<string,string>={}):Promise<T>{
 const token=loadAuth()?.accessToken
 const wireMethod=method==='PATCH'?'POST':method;const methodHeaders=method==='PATCH'?{'X-HTTP-Method-Override':'PATCH'}:{}
 return new Promise((resolve,reject)=>uni.request({url:API_BASE+path,method:wireMethod,data:body as UniApp.RequestOptions['data'],timeout:20000,header:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...methodHeaders,...headers},success(res){
  const envelope=res.data as Envelope<T>;if(envelope?.serverTime)serverOffset=Date.parse(envelope.serverTime)-Date.now()
  if(res.statusCode>=200&&res.statusCode<300&&!envelope.error){resolve(envelope.data);return}
  const e=envelope?.error;reject(new ApiError(e?.code||'HTTP_ERROR',e?.message||'暂时无法完成，请稍后重试',e?.details||{},res.statusCode,envelope?.requestId))
 },fail(){reject(new ApiError('NETWORK_UNKNOWN','网络结果尚未确认，请查询这次操作'))}}))
}
async function refresh(){if(refreshPromise)return refreshPromise;const auth=loadAuth();if(!auth?.refreshToken)throw new ApiError('SESSION_EXPIRED','请重新微信登录',{},401);refreshPromise=(async()=>{try{const result=await transport<Tokens>('POST','/auth/refresh',{refreshToken:auth.refreshToken,refreshAttemptId:uuid()});saveAuth(result)}catch(e){clearAuth();throw e}finally{refreshPromise=null}})();return refreshPromise}
export async function request<T>(method:HttpMethod,path:string,body?:unknown,headers:Record<string,string>={},retry=true):Promise<T>{try{return await transport<T>(method,path,body,headers)}catch(e){if(e instanceof ApiError&&e.status===401&&retry&&!path.startsWith('/auth/')){await refresh();return request<T>(method,path,body,headers,false)}throw e}}
export async function get<T>(path:string,params?:Record<string,unknown>):Promise<T>{const scope=loadAuth()?.session.actorScopeKey;const result=await request<T>('GET',path+query(params));if(path.startsWith('/families/')&&scope!==loadAuth()?.session.actorScopeKey)throw new ApiError('SCOPE_MISMATCH','身份已切换，请重新加载当前页面');return result}
export async function getAll<T>(path:string,params:Record<string,unknown>={}):Promise<T[]>{const items:T[]=[];let cursor:string|undefined;do{const page=await get<{items:T[];nextCursor?:string|null;hasMore:boolean}>(path,{...params,limit:100,cursor});items.push(...page.items);cursor=page.hasMore?(page.nextCursor||undefined):undefined}while(cursor);return items}
export const authPost=<T>(path:string,body:unknown)=>request<T>('POST',path,body,{},false)
export async function mutate<T>(method:HttpMethod,path:string,body:unknown={},label='保存修改'):Promise<T>{
 const scope=scopeFor(path);if(!scope)throw new ApiError('SESSION_EXPIRED','请重新登录后继续')
 const existing=pendingOperations().find(o=>o.scope===scope&&o.method===method&&o.path===path)
 if(existing){if(inflight.has(existing.key)&&JSON.stringify(existing.body)===JSON.stringify(body))return inflight.get(existing.key) as Promise<T>;throw new ApiError('OPERATION_IN_PROGRESS','这次操作尚未确认，请先查询原操作',{operationKey:existing.key})}
 const op:PendingOperation={key:uuid(),scope,method,path,body,label,createdAt:new Date().toISOString(),state:'SENDING'};persist([...pendingOperations(),op]);return sendOperation<T>(op)
}
async function sendOperation<T>(op:PendingOperation):Promise<T>{
 const promise=(async()=>{try{const result=await request<T>(op.method,op.path,op.body,{'Idempotency-Key':op.key});persist(pendingOperations().filter(o=>o.key!==op.key));return result}catch(e){const error=e as ApiError;const unknown=error.status>=500||error.code==='NETWORK_UNKNOWN'||error.code==='OPERATION_IN_PROGRESS';if(unknown){persist(pendingOperations().map(o=>o.key===op.key?{...o,state:'UNKNOWN',requestId:error.requestId}:o));throw new ApiError('OPERATION_IN_PROGRESS','结果尚未确认，请查询原操作',{operationKey:op.key},error.status,error.requestId)}persist(pendingOperations().filter(o=>o.key!==op.key));throw e}finally{inflight.delete(op.key)}})();inflight.set(op.key,promise);return promise
}
export async function recoverOperation(op:PendingOperation){if(scopeFor(op.path)!==op.scope)throw new ApiError('SCOPE_MISMATCH','请回到发起操作的原身份继续确认');const result=await get<{state:string;result?:unknown;retryWithSameKey?:boolean}>(`/operations/${op.key}`,{method:op.method,path:op.path});if(result.state==='SUCCEEDED'){persist(pendingOperations().filter(o=>o.key!==op.key));return result.result}if(result.state==='NOT_OBSERVED'&&result.retryWithSameKey)return sendOperation(op);throw new ApiError('OPERATION_IN_PROGRESS','服务器仍在确认，请稍后查询原操作')}
export function errorText(e:unknown){return e instanceof Error?e.message:'暂时无法完成，请重试'}
export function familyPath(tail=''){const id=loadAuth()?.session.familyId;if(!id)throw new ApiError('SCOPE_MISMATCH','请先选择家庭');return `/families/${id}${tail}`}
export function childPath(childId?:string,tail=''){const c=childId||loadAuth()?.session.childId;if(!c)throw new ApiError('VALIDATION_ERROR','请先选择孩子');return familyPath(`/children/${c}${tail}`)}
