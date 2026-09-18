import { z } from 'zod';
import { Tx,context,requireAdmin,other,fail,points,audit } from './domain';
const id=z.string().uuid();
export const activityDay=(now:Date)=>new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
export async function activityAction(tx:Tx,uid:string,gid:string,p:string[],body:any){
 const c=await context(tx,uid,gid,'share');
 if(p.length===3&&p[2]==='activities'){
  requireAdmin(c);
  const data=z.object({title:z.string().trim().min(1).max(60),description:z.string().trim().min(1).max(2000),points:z.number().int().min(1).max(2000000000),kind:z.enum(['DAILY','LIMITED']),startsAt:z.string().datetime({offset:true}).optional(),endsAt:z.string().datetime({offset:true}).optional()}).strict().parse(body);
  if(data.kind==='LIMITED'&&(!data.startsAt||!data.endsAt||new Date(data.endsAt)<=new Date(data.startsAt)||new Date(data.endsAt)<=new Date()))fail('VALIDATION_ERROR','请设置有效的活动起止时间，结束时间须晚于当前时间',400);
  if(data.kind==='DAILY'&&(data.startsAt||data.endsAt))fail('VALIDATION_ERROR','日常活动无需设置时间范围',400);
  const t=await tx.activity.create({data:{...data,groupId:gid,creatorMemberId:c.member.id}});
  await audit(tx,gid,c.member.id,'ACTIVITY_PUBLISH',t.id,t.title);return t;
 }
 const target=id.parse(p[3]);
 if(p[2]==='activities'){
  await tx.$queryRaw`SELECT id FROM activities WHERE id=${target}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;
  const t=await tx.activity.findFirst({where:{id:target,groupId:gid}});if(!t)fail('RESOURCE_NOT_FOUND','活动不存在',404);
  z.object({}).strict().parse(body);
  if(p[4]==='close'){requireAdmin(c);const result=await tx.activity.update({where:{id:target},data:{status:'CLOSED'}});await audit(tx,gid,c.member.id,'ACTIVITY_CLOSE',target);return result;}
  if(t.status!=='ACTIVE')fail('INVALID_STATE','活动已停止参与');
  const now=new Date();
  if(t.kind==='LIMITED'&&(now<t.startsAt!||now>=t.endsAt!))fail('ACTIVITY_UNAVAILABLE','活动未开始或已结束');
  const period=t.kind==='DAILY'?activityDay(now):'ONCE';
  const expiresAt=t.kind==='DAILY'?new Date(new Date(period+'T00:00:00+08:00').getTime()+86400000):t.endsAt!;
  if(await tx.activityClaim.findUnique({where:{activityId_memberId_period:{activityId:target,memberId:c.member.id,period}}}))fail('ALREADY_CLAIMED','你已经参与过本次活动');
  const claim=await tx.activityClaim.create({data:{groupId:gid,activityId:target,memberId:c.member.id,period,expiresAt}});
  await audit(tx,gid,c.member.id,'ACTIVITY_CLAIM',claim.id,t.title);return claim;
 }
 await tx.$queryRaw`SELECT id FROM activity_claims WHERE id=${target}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;
 const claim=await tx.activityClaim.findFirst({where:{id:target,groupId:gid}});if(!claim)fail('RESOURCE_NOT_FOUND','参与记录不存在',404);
 const t=await tx.activity.findUniqueOrThrow({where:{id:claim.activityId}});
 if(p[4]==='submit'){
  if(claim.memberId!==c.member.id)fail('FORBIDDEN','只能提交自己的活动',403);
  const data=z.object({submission:z.string().trim().min(1).max(1000),expectedVersion:z.number().int().positive()}).strict().parse(body);
  if(claim.version!==data.expectedVersion)fail('VERSION_CONFLICT','活动进度已变化，请刷新');
  if(new Date()>=claim.expiresAt)fail('ACTIVITY_EXPIRED','本次活动已截止，无法提交');
  if(!['CLAIMED','REJECTED'].includes(claim.status))fail('INVALID_STATE','当前活动不能再次提交');
  const result=await tx.activityClaim.update({where:{id:target},data:{status:'SUBMITTED',submission:data.submission,reviewReason:'',reviewerMemberId:null,version:{increment:1}}});
  await audit(tx,gid,c.member.id,'ACTIVITY_SUBMIT',target,data.submission);return result;
 }
 requireAdmin(c);other(c.member.id,claim.memberId);
 const data=z.object({decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().max(200),expectedVersion:z.number().int().positive()}).strict().parse(body);
 if(claim.version!==data.expectedVersion)fail('VERSION_CONFLICT','活动已被处理或重新提交，请刷新');
 if(claim.status!=='SUBMITTED')fail('INVALID_STATE','只有待审核活动可以处理');
 if(data.decision==='REJECT'&&!data.reason)fail('VALIDATION_ERROR','请填写驳回原因',400);
 let ledgerId:string|undefined;
 if(data.decision==='APPROVE'){const grant=await points(tx,gid,claim.memberId,c.member.id,t.points,'GRANT','完成活动：'+t.title);ledgerId=grant.entry.id;}
 const result=await tx.activityClaim.update({where:{id:target},data:{status:data.decision==='APPROVE'?'APPROVED':'REJECTED',reviewReason:data.reason,reviewerMemberId:c.member.id,ledgerId,version:{increment:1}}});
 await audit(tx,gid,c.member.id,data.decision==='APPROVE'?'ACTIVITY_APPROVE':'ACTIVITY_REJECT',target,data.reason||t.title);return result;
}
