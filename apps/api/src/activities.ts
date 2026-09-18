import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { Tx,context,requireAdmin,other,fail,points,audit } from './domain';
const id=z.string().uuid();
export const activityDay=(now:Date)=>new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
export const definitionDTO=(row:any,daily:boolean)=>({...row,kind:daily?'DAILY':'LIMITED'});
export const entryDTO=(row:any,daily:boolean)=>({...row,kind:daily?'DAILY':'LIMITED',activityId:daily?row.routineId:row.eventId,period:daily?row.occurrenceDate.toISOString().slice(0,10):'ONCE'});
export async function definitions(client:any,gid:string,kind?:string,extra:any={}){
 const read=async(daily:boolean)=>(await (daily?client.dailyRoutine:client.event).findMany({...extra,where:{...extra.where,groupId:gid},orderBy:{createdAt:'desc'}})).map((r:any)=>definitionDTO(r,daily));
 return kind?read(kind==='DAILY'):[...await read(true),...await read(false)];
}
export async function entries(client:any,gid:string,kind?:string,extra:any={}){
 const read=async(daily:boolean)=>(await (daily?client.dailyEntry:client.eventEntry).findMany({...extra,where:{...extra.where,groupId:gid},orderBy:[{createdAt:'desc'},{id:'desc'}]})).map((r:any)=>entryDTO(r,daily));
 return kind?read(kind==='DAILY'):[...await read(true),...await read(false)].sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime());
}
export async function activityAction(tx:Tx,uid:string,gid:string,p:string[],body:any){
 const c=await context(tx,uid,gid,'share');
 const daily=['routines','daily-entries'].includes(p[2]),definitionRoute=['routines','events'].includes(p[2]);
 const parent:any=daily?tx.dailyRoutine:tx.event,child:any=daily?tx.dailyEntry:tx.eventEntry;
 const parentTable=daily?'daily_routines':'events',childTable=daily?'daily_entries':'event_entries',foreignKey=daily?'routineId':'eventId';
 if(p.length===3&&definitionRoute){
  requireAdmin(c);
  const base=z.object({title:z.string().trim().min(1).max(60),description:z.string().trim().min(1).max(2000),points:z.number().int().min(1).max(2000000000)});
  const data:any=(daily?base.strict():base.extend({startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true})}).strict()).parse(body);
  if(!daily&&(new Date(data.endsAt)<=new Date(data.startsAt)||new Date(data.endsAt)<=new Date()))fail('VALIDATION_ERROR','请设置有效的活动起止时间',400);
  const result=await parent.create({data:{...data,groupId:gid,creatorMemberId:c.member.id}});
  await audit(tx,gid,c.member.id,daily?'DAILY_PUBLISH':'EVENT_PUBLISH',result.id,result.title);return definitionDTO(result,daily);
 }
 const target=id.parse(p[3]);
 if(definitionRoute){
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(parentTable)} WHERE id=${target}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`);
  const rule=await parent.findFirst({where:{id:target,groupId:gid}});if(!rule)fail('RESOURCE_NOT_FOUND','日常或活动不存在',404);
  z.object({}).strict().parse(body);
  if(p[4]==='close'){requireAdmin(c);const result=await parent.update({where:{id:target},data:{status:'CLOSED',closedAt:rule.closedAt||new Date()}});await audit(tx,gid,c.member.id,daily?'DAILY_CLOSE':'EVENT_CLOSE',target);return definitionDTO(result,daily);}
  if(rule.status!=='ACTIVE')fail('INVALID_STATE','已停止参与');
  const now=new Date();if(!daily&&(now<rule.startsAt||now>=rule.endsAt))fail('ACTIVITY_UNAVAILABLE','活动未开始或已结束');
  const day=activityDay(now),occurrenceDate=new Date(day+'T00:00:00Z');
  const key=daily?{routineId_memberId_occurrenceDate:{routineId:target,memberId:c.member.id,occurrenceDate}}:{eventId_memberId:{eventId:target,memberId:c.member.id}};
  if(await child.findUnique({where:key}))fail('ALREADY_CLAIMED',daily?'今天已经参与过此日常':'已经参与过此活动');
  const expiresAt=daily?new Date(new Date(day+'T00:00:00+08:00').getTime()+86400000):rule.endsAt;
  const result=await child.create({data:{groupId:gid,[foreignKey]:target,memberId:c.member.id,awardPoints:rule.points,expiresAt,...(daily?{occurrenceDate}:{})}});
  await audit(tx,gid,c.member.id,daily?'DAILY_CLAIM':'EVENT_CLAIM',result.id,rule.title);return entryDTO(result,daily);
 }
 await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(childTable)} WHERE id=${target}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`);
 const claim=await child.findFirst({where:{id:target,groupId:gid}});if(!claim)fail('RESOURCE_NOT_FOUND','参与记录不存在',404);
 const rule=await parent.findUniqueOrThrow({where:{id:claim[foreignKey]}});
 if(p[4]==='submit'){
  if(claim.memberId!==c.member.id)fail('FORBIDDEN','只能提交自己的记录',403);
  const data=z.object({submission:z.string().trim().min(1).max(1000),expectedVersion:z.number().int().positive()}).strict().parse(body);
  if(claim.version!==data.expectedVersion)fail('VERSION_CONFLICT','进度已变化，请刷新');
  if(new Date()>=claim.expiresAt)fail('ACTIVITY_EXPIRED','本次参与已截止');
  if(!['CLAIMED','REJECTED'].includes(claim.status))fail('INVALID_STATE','当前记录不能再次提交');
  const result=await child.update({where:{id:target},data:{status:'SUBMITTED',submission:data.submission,submittedAt:new Date(),reviewReason:'',reviewerMemberId:null,reviewedAt:null,version:{increment:1}}});
  await audit(tx,gid,c.member.id,daily?'DAILY_SUBMIT':'EVENT_SUBMIT',target,data.submission);return entryDTO(result,daily);
 }
 requireAdmin(c);other(c.member.id,claim.memberId);
 const data=z.object({decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().max(200),expectedVersion:z.number().int().positive()}).strict().parse(body);
 if(claim.version!==data.expectedVersion)fail('VERSION_CONFLICT','记录已被处理或重新提交，请刷新');
 if(claim.status!=='SUBMITTED')fail('INVALID_STATE','只有待审核记录可以处理');
 if(data.decision==='REJECT'&&!data.reason)fail('VALIDATION_ERROR','请填写驳回原因',400);
 let ledgerId:string|undefined;
 if(data.decision==='APPROVE'){const grant=await points(tx,gid,claim.memberId,c.member.id,claim.awardPoints,'GRANT',(daily?'完成日常：':'完成活动：')+rule.title);ledgerId=grant.entry.id;}
 const result=await child.update({where:{id:target},data:{status:data.decision==='APPROVE'?'APPROVED':'REJECTED',reviewReason:data.reason,reviewerMemberId:c.member.id,reviewedAt:new Date(),ledgerId,version:{increment:1}}});
 await audit(tx,gid,c.member.id,(daily?'DAILY_':'EVENT_')+data.decision,target,data.reason||rule.title);return entryDTO(result,daily);
}
