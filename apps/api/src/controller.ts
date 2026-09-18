import { activityAction,activityDay } from './activities';
import { All, Controller, Req, Res } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { exchangeCode } from './wechat';
import { saveAvatar } from './avatar';
import { db, hash, context, mutation, fail, requireAdmin, other, audit, points, stock, lockReward, createGroup, redeem, orderAction } from './domain';
const id=z.string().uuid();const text=(n:number)=>z.string().trim().min(1).max(n);const integer=z.number().int().min(1).max(2_000_000_000);
const reason=text(200);const version=z.number().int().min(1);
const groupBody=z.object({name:text(30).min(2),description:z.string().trim().max(200).default(''),color:z.enum(['blue','green','peach','purple']).default('blue')}).strict();
const rewardBody=z.object({name:text(50),description:z.string().max(2000).default(''),art:z.enum(['coffee','book','game','plant','gift','movie']).default('gift'),type:z.enum(['VIRTUAL','PHYSICAL']),costPoints:integer,initialStock:z.number().int().min(0).max(1_000_000),fulfillmentInstructions:text(500)}).strict();
const rates=new Map<string,{count:number,until:number}>();
function rate(key:string,limit=100){const now=Date.now();if(rates.size>10000) for(const [k,v] of rates)if(v.until<now)rates.delete(k);let r=rates.get(key);if(!r||r.until<now){r={count:0,until:now+60000};rates.set(key,r);}if(++r.count>limit)fail('RATE_LIMITED','操作较频繁，请稍后再试',429);}
function page(query:any){const limit=z.coerce.number().int().min(1).max(100).default(30).parse(query.limit);return {take:limit+1,orderBy:[{createdAt:'desc' as const},{id:'desc' as const}],...(query.cursor?{cursor:{id:id.parse(query.cursor)},skip:1}:{})};}
function paged(rows:any[],limit=30){return {items:rows.slice(0,limit),hasMore:rows.length>limit,nextCursor:rows.length>limit?rows[limit-1].id:null};}
@Controller('api/v1')
export class ApiController {
 @All('{*path}')
 async handle(@Req() req:any,@Res() res:any){
  const requestId=randomUUID();
  try {
   const result=await this.dispatch(req);res.status(200).json({data:result,requestId});
  }catch(e:any){
   if(e instanceof z.ZodError)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'请检查填写的内容',details:e.flatten()},requestId});
   const status=e.getStatus?.()||500;const error=e.getResponse?.();
   if(status===500)console.error(requestId,e);
   if(status===429)res.setHeader('Retry-After','60');
   res.status(status).json({error:typeof error==='object'?error:{code:'INTERNAL_ERROR',message:'操作暂时未完成，请保留页面重试'},requestId});
  }
 }
 async dispatch(req:any):Promise<any>{
  const path=req.path.replace(/^\/api\/v1\/?/,'').replace(/\/$/,'');const p=path.split('/');const method=req.method;const b=req.body||{};
  if(path==='health'&&method==='GET'){await db.$queryRaw`SELECT 1`;return {status:'ok',mode:process.env.DEMO_AUTH==='true'?'demo':'production'};}
  if(path==='auth/config'&&method==='GET')return {mode:process.env.DEMO_AUTH==='true'?'demo':'wechat'};
  if(path==='auth/wechat'&&method==='POST'){
   rate('wechat:'+req.ip,20);
   const input=z.object({code:text(256)}).strict().parse(b);
   const wechatOpenId=await exchangeCode(input.code);
   const user=await db.user.upsert({where:{wechatOpenId},update:{},create:{wechatOpenId,displayName:'伙伴'+randomBytes(3).toString('hex')},select:{id:true,displayName:true,avatar:true,createdAt:true}});
   const token=randomBytes(32).toString('hex');
   await db.session.create({data:{userId:user.id,tokenHash:hash(token),expiresAt:new Date(Date.now()+86400000)}});
   return {accessToken:token,user};
  }
  if(path==='auth/demo-users'&&method==='GET'){if(process.env.DEMO_AUTH!=='true')fail('RESOURCE_NOT_FOUND','接口不存在',404);return db.user.findMany({orderBy:{createdAt:'asc'}});}
  if(path==='auth/demo'&&method==='POST'){
   if(process.env.DEMO_AUTH!=='true')fail('RESOURCE_NOT_FOUND','接口不存在',404);rate(req.ip,30);
   const uid=id.parse(b.userId);const user=await db.user.findUnique({where:{id:uid}});if(!user)fail('RESOURCE_NOT_FOUND','用户不存在',404);
   const token=randomBytes(32).toString('hex');await db.session.create({data:{userId:uid,tokenHash:hash(token),expiresAt:new Date(Date.now()+86400000)}});return {accessToken:token,user};
  }
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');const session=await db.session.findUnique({where:{tokenHash:hash(token)}});
  if(!session||session.expiresAt<new Date())fail('UNAUTHENTICATED','登录已过期，请重新登录',401);const uid=session.userId;rate(uid);
  const write=(fn:any)=>mutation(uid,method+':'+path,req.headers['idempotency-key'],b,fn);
  if(path==='me'&&method==='GET')return db.user.findUnique({where:{id:uid}});
  if(path==='me'&&method==='PATCH'){
   const data=z.object({displayName:text(24)}).strict().parse(b);
   return write((tx:any)=>tx.user.update({where:{id:uid},data}));
  }
  if(path==='me/avatar'&&method==='POST'){
   rate('avatar:'+uid,10);
   const data=z.object({imageBase64:z.string().min(1).max(2800000)}).strict().parse(b);
   return write(async(tx:any)=>{const avatar=await saveAvatar(data.imageBase64);return tx.user.update({where:{id:uid},data:{avatar}});});
  }
  if(path==='auth/logout'&&method==='POST')return write(async(tx:any)=>{await tx.session.delete({where:{id:session.id}});return {loggedOut:true};});
  if(path==='groups'&&method==='GET'){
    const memberships=await db.member.findMany({where:{userId:uid},orderBy:{createdAt:'asc'}});
    const gids=memberships.map(m=>m.groupId);
    const [groups,accounts,counts]=await Promise.all([db.group.findMany({where:{id:{in:gids}}}),db.account.findMany({where:{memberId:{in:memberships.map(m=>m.id)}}}),db.member.groupBy({by:['groupId'],where:{groupId:{in:gids}},_count:true})]);
    return {items:memberships.map(m=>{const g=groups.find(g=>g.id===m.groupId)!;return {group:g,membership:{...m,effectiveRole:g.ownerMemberId===m.id?'OWNER':m.role},account:accounts.find(a=>a.memberId===m.id),memberCount:counts.find(c=>c.groupId===m.groupId)?._count||0};}),nextCursor:null,hasMore:false};
  }
  if(path==='groups'&&method==='POST'){const data=groupBody.parse(b);return write((tx:any)=>createGroup(tx,uid,data.name,data.description,data.color));}
  if(path==='me/join-applications'&&method==='GET')return {items:await db.application.findMany({where:{applicantUserId:uid},orderBy:{createdAt:'desc'},take:100})};
  if(path==='join-applications'&&method==='POST'){
    const code=text(32).parse(b.code).toUpperCase();rate(uid+':invite',15);
    return write(async(tx:any)=>{
      const inv=await tx.invitation.findUnique({where:{codeHash:hash(code)}});if(!inv)fail('INVITATION_NOT_FOUND','邀请码无效',404);
      await tx.$queryRaw`SELECT id FROM groups WHERE id=${inv.groupId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM invitations WHERE id=${inv.id}::uuid FOR UPDATE`;
      const current=await tx.invitation.findUnique({where:{id:inv.id}});
      if(await tx.member.findUnique({where:{groupId_userId:{groupId:inv.groupId,userId:uid}}}))fail('INVALID_STATE','你已经加入这个群了');
      const existing=await tx.application.findFirst({where:{groupId:inv.groupId,applicantUserId:uid,status:'PENDING'}});if(existing)return existing;
      if(current.revokedAt)fail('INVITATION_REVOKED','邀请已撤销',410);if(current.expiresAt<new Date())fail('INVITATION_EXPIRED','邀请已过期',410);if(current.uses>=current.maxUses)fail('INVITATION_EXHAUSTED','邀请名额已用完');
      const app=await tx.application.create({data:{groupId:inv.groupId,invitationId:inv.id,applicantUserId:uid}});await tx.invitation.update({where:{id:inv.id},data:{uses:{increment:1}}});return app;
    });
  }
  if(p[0]!=='groups'||!p[1])fail('RESOURCE_NOT_FOUND','接口不存在',404);
  const gid=id.parse(p[1]);const c=await context(db,uid,gid);
  if(method!=='GET'&&(['point-entries','rewards','invitations','join-applications','ownership-transfer'].includes(p[2])||(p[2]==='members'&&p[4]==='role')))requireAdmin(c);
  if(method!=='GET'&&(p[2]==='ownership-transfer'||(p[2]==='members'&&p[4]==='role'))&&c.role!=='OWNER')fail('FORBIDDEN','只有群主可以操作',403);
  if(p.length===2&&method==='GET')return {...c,membership:{...c.member,effectiveRole:c.role},account:await db.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:c.member.id}}})};
  if(p.length===2&&method==='PATCH'){
    const data=z.object({name:text(30).min(2),description:z.string().max(200),expectedVersion:version}).strict().parse(b);
    return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'exclusive');requireAdmin(ctx);if(ctx.group.version!==data.expectedVersion)fail('VERSION_CONFLICT','群资料已更新');return tx.group.update({where:{id:gid},data:{name:data.name,description:data.description,version:{increment:1}}});});
  }
  if(method==='GET'&&p[2]==='me'&&p[3]==='account')return db.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:c.member.id}}});
  if(method==='GET'&&p[2]==='me'&&p[3]==='ledger')return paged(await db.ledger.findMany({where:{groupId:gid,memberId:c.member.id},...page(req.query)}),Number(req.query.limit||30));
  if(method==='GET'&&p[2]==='members'&&p.length===3){requireAdmin(c);const rows=await db.member.findMany({where:{groupId:gid},...page(req.query)});return paged(await Promise.all(rows.map(async m=>({...m,user:await db.user.findUnique({where:{id:m.userId}}),account:await db.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:m.id}}}),effectiveRole:m.id===c.group.ownerMemberId?'OWNER':m.role}))),Number(req.query.limit||30));}
  if(method==='GET'&&p[2]==='members'&&p.length===4){const mid=id.parse(p[3]);if(mid!==c.member.id)requireAdmin(c);const m=await db.member.findFirst({where:{id:mid,groupId:gid}});if(!m)fail('RESOURCE_NOT_FOUND','成员不存在',404);return {...m,user:await db.user.findUnique({where:{id:m.userId}}),account:await db.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:mid}}}),effectiveRole:mid===c.group.ownerMemberId?'OWNER':m.role};}
  if(method==='GET'&&['rewards','managed-rewards'].includes(p[2])){
    if(p[2]==='managed-rewards')requireAdmin(c);
    if(p.length===4){const r=await db.reward.findFirst({where:{id:id.parse(p[3]),groupId:gid,...(!c.admin?{status:'ACTIVE'}:{})}});if(!r)fail('RESOURCE_NOT_FOUND','奖励不存在',404);return r;}
    if(p.length===3)return paged(await db.reward.findMany({where:{groupId:gid,...(p[2]==='rewards'?{status:'ACTIVE'}:{})},...page(req.query)}),Number(req.query.limit||30));
  }
  if(method==='GET'&&(p[2]==='redemptions'||(p[2]==='me'&&p[3]==='redemptions'))){
    const mine=p[2]==='me';if(!mine&&p.length===3)requireAdmin(c);
    if(!mine&&p.length===4){const o=await db.redemption.findFirst({where:{id:id.parse(p[3]),groupId:gid,...(!c.admin?{memberId:c.member.id}:{})}});if(!o)fail('RESOURCE_NOT_FOUND','订单不存在',404);return o;}
    const status=req.query.status?z.enum(['PENDING','FULFILLED','CANCELED']).parse(req.query.status):undefined;
    return paged(await db.redemption.findMany({where:{groupId:gid,...(mine?{memberId:c.member.id}:{}),...(status?{status}:{})},...page(req.query)}),Number(req.query.limit||30));
  }
  if(method==='GET'&&p[2]==='audit-logs'){requireAdmin(c);return paged(await db.audit.findMany({where:{groupId:gid},...page(req.query)}),Number(req.query.limit||30));}
  if(method==='GET'&&p[2]==='activity-progress'&&p.length===3){
   requireAdmin(c);
   const kind=z.enum(['DAILY','LIMITED']).parse(req.query.kind||'DAILY');
   const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date||activityDay(new Date()));
   const start=new Date(day+'T00:00:00+08:00');if(!Number.isFinite(start.getTime())||activityDay(start)!==day)fail('VALIDATION_ERROR','日期无效',400);
   const end=new Date(start.getTime()+86400000);
   const activities=await db.activity.findMany({where:{groupId:gid,kind,...(kind==='DAILY'?{createdAt:{lt:end}}:{})},orderBy:{createdAt:'desc'}});
   const members=await db.member.findMany({where:{groupId:gid,...(kind==='DAILY'?{createdAt:{lt:end}}:{})},orderBy:{createdAt:'asc'}});
   const users=await db.user.findMany({where:{id:{in:members.map(m=>m.userId)}}});
   const claims=await db.activityClaim.findMany({where:{groupId:gid,activityId:{in:activities.map(a=>a.id)},period:kind==='DAILY'?day:'ONCE'},orderBy:{updatedAt:'desc'}});
   return {day,kind,serverTime:new Date().toISOString(),activities,members:members.map(m=>({id:m.id,displayName:users.find(u=>u.id===m.userId)?.displayName||'成员',createdAt:m.createdAt})),claims};
  }
  if(method==='POST'&&((p[2]==='activities'&&(p.length===3||(p.length===5&&['claim','close'].includes(p[4]))))||(p[2]==='activity-claims'&&p.length===5&&['submit','review'].includes(p[4]))))return write((tx:any)=>activityAction(tx,uid,gid,p,b));
  if(p[2]==='dashboard'&&p.length===3&&method==='GET'){
    const members=await db.member.findMany({where:{groupId:gid}});const users=await db.user.findMany({where:{id:{in:members.map(m=>m.userId)}}});
    const name=(mid:string)=>users.find(u=>u.id===members.find(m=>m.id===mid)?.userId)?.displayName||'成员';
    const [account,rewards,entries,orders,accounts,applications,audits]=await Promise.all([
     db.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:c.member.id}}}),
     db.reward.findMany({where:{groupId:gid,...(!c.admin?{status:'ACTIVE'}:{})},orderBy:{createdAt:'asc'}}),
     db.ledger.findMany({where:{groupId:gid,memberId:c.member.id},orderBy:[{createdAt:'desc'},{id:'desc'}],take:100}),
     db.redemption.findMany({where:{groupId:gid,...(!c.admin?{memberId:c.member.id}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:100}),
     c.admin?db.account.findMany({where:{groupId:gid}}):Promise.resolve([]),
     c.admin?db.application.findMany({where:{groupId:gid,status:'PENDING'},orderBy:{createdAt:'asc'}}):Promise.resolve([]),
     c.admin?db.audit.findMany({where:{groupId:gid},orderBy:{createdAt:'desc'},take:50}):Promise.resolve([])
    ]);
    const activities=await db.activity.findMany({where:{groupId:gid},orderBy:{createdAt:'desc'},take:100});
    const activityClaims=await db.activityClaim.findMany({where:{groupId:gid,...(!c.admin?{memberId:c.member.id}:{})},orderBy:{updatedAt:'desc'},take:200});
    const applicants=await db.user.findMany({where:{id:{in:applications.map(a=>a.applicantUserId)}}});
    return {group:c.group,membership:{...c.member,effectiveRole:c.role},admin:c.admin,account,memberCount:members.length,
      members:c.admin?members.map(m=>({...m,displayName:name(m.id),avatar:users.find(u=>u.id===m.userId)?.avatar,effectiveRole:c.group.ownerMemberId===m.id?'OWNER':m.role,account:accounts.find(a=>a.memberId===m.id)})):[],
      activityDate:activityDay(new Date()),serverTime:new Date().toISOString(),activities,activityClaims:activityClaims.map(x=>({...x,memberName:name(x.memberId)})),rewards,entries:entries.map(e=>({...e,operatorName:name(e.actorMemberId)})),orders:orders.map(o=>({...o,memberName:name(o.memberId)})),
      applications:applications.map(a=>({...a,displayName:applicants.find(u=>u.id===a.applicantUserId)?.displayName})),audits:audits.map(a=>({...a,operatorName:name(a.actorMemberId)}))};
  }
  if(p[2]==='members'&&p[4]==='ledger'&&method==='GET'){
    const mid=id.parse(p[3]);if(mid!==c.member.id)requireAdmin(c);return paged(await db.ledger.findMany({where:{groupId:gid,memberId:mid},...page(req.query)}),Number(req.query.limit||30));
  }
  if(p[2]==='members'&&p[4]==='role'&&method==='PATCH'){
    const mid=id.parse(p[3]),data=z.object({role:z.enum(['ADMIN','MEMBER']),expectedVersion:version}).strict().parse(b);
    return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'exclusive');if(ctx.role!=='OWNER')fail('FORBIDDEN','只有群主可以设置管理员',403);const m=await tx.member.findFirst({where:{id:mid,groupId:gid}});if(!m)fail('RESOURCE_NOT_FOUND','成员不存在',404);if(ctx.group.ownerMemberId===mid)fail('INVALID_STATE','请使用群主转让');if(m.version!==data.expectedVersion)fail('VERSION_CONFLICT','成员角色已变化');const result=await tx.member.update({where:{id:mid},data:{role:data.role,version:{increment:1}}});await audit(tx,gid,ctx.member.id,'ROLE_CHANGE',mid,data.role);return result;});
  }
  if(p[2]==='ownership-transfer'&&method==='POST'){
    const data=z.object({newOwnerMemberId:id,expectedVersion:version}).strict().parse(b);
    return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'exclusive');if(ctx.role!=='OWNER')fail('FORBIDDEN','只有群主可以转让',403);if(ctx.group.version!==data.expectedVersion)fail('VERSION_CONFLICT','群资料已变化');const m=await tx.member.findFirst({where:{id:data.newOwnerMemberId,groupId:gid}});if(!m)fail('RESOURCE_NOT_FOUND','成员不存在',404);other(ctx.member.id,m.id);await tx.member.update({where:{id:ctx.member.id},data:{role:'ADMIN',version:{increment:1}}});const group=await tx.group.update({where:{id:gid},data:{ownerMemberId:m.id,version:{increment:1}}});await audit(tx,gid,ctx.member.id,'OWNER_TRANSFER',m.id);return group;});
  }
  if(p[2]==='invitations'&&p.length===3&&method==='POST'){
    requireAdmin(c);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);const code=randomBytes(6).toString('hex').toUpperCase();const inv=await tx.invitation.create({data:{groupId:gid,creatorMemberId:ctx.member.id,codeHash:hash(code),expiresAt:new Date(Date.now()+7*86400000)}});return {id:inv.id,code,expiresAt:inv.expiresAt};});
  }
  if(p[2]==='join-applications'&&p[4]==='decision'&&method==='POST'){
    const aid=id.parse(p[3]),data=z.object({decision:z.enum(['APPROVE','REJECT']),reason:z.string().max(200).optional()}).strict().parse(b);
    return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);await tx.$queryRaw`SELECT id FROM join_applications WHERE id=${aid}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;const a=await tx.application.findFirst({where:{id:aid,groupId:gid}});if(!a)fail('RESOURCE_NOT_FOUND','申请不存在',404);const status=data.decision==='APPROVE'?'APPROVED':'REJECTED';if(a.status===status)return a;if(a.status!=='PENDING')fail('INVALID_STATE','申请已被处理');if(status==='APPROVED'){const m=await tx.member.upsert({where:{groupId_userId:{groupId:gid,userId:a.applicantUserId}},create:{groupId:gid,userId:a.applicantUserId},update:{}});await tx.account.upsert({where:{groupId_memberId:{groupId:gid,memberId:m.id}},create:{groupId:gid,memberId:m.id},update:{}});}const result=await tx.application.update({where:{id:aid},data:{status,decidedAt:new Date(),decidedByMemberId:ctx.member.id,decisionReason:data.reason}});await audit(tx,gid,ctx.member.id,status,aid);return result;});
  }
  if(p[2]==='point-entries'&&p.length===3&&method==='POST'){
    const data=z.object({memberId:id,type:z.enum(['GRANT','ADJUSTMENT']),delta:z.number().int().min(-1_000_000).max(1_000_000).refine(v=>v!==0),reason}).strict().parse(b);
    if(data.type==='GRANT'&&data.delta<0)fail('VALIDATION_ERROR','发放积分必须大于零',400);
    return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);other(ctx.member.id,data.memberId);const result=await points(tx,gid,data.memberId,ctx.member.id,data.delta,data.type,data.reason);await audit(tx,gid,ctx.member.id,data.type,result.entry.id,data.reason);return result;});
  }
  if(p[2]==='point-entries'&&p[4]==='reversal'&&method==='POST'){
    const eid=id.parse(p[3]),why=reason.parse(b.reason);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);await tx.$queryRaw`SELECT id FROM point_ledger WHERE id=${eid}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;const e=await tx.ledger.findFirst({where:{id:eid,groupId:gid}});if(!e)fail('RESOURCE_NOT_FOUND','流水不存在',404);other(ctx.member.id,e.memberId);if(!['GRANT','ADJUSTMENT'].includes(e.type))fail('INVALID_STATE','该流水不支持冲正');if(await tx.ledger.findUnique({where:{reversalOfId:eid}}))fail('ALREADY_REVERSED','该流水已经冲正');const result=await points(tx,gid,e.memberId,ctx.member.id,-e.delta,'REVERSAL',why,undefined,eid);await audit(tx,gid,ctx.member.id,'REVERSAL',result.entry.id,why);return result;});
  }
  if(p[2]==='rewards'&&p.length===3&&method==='POST'){
    const data=rewardBody.parse(b);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);const {initialStock,...fields}=data;let r=await tx.reward.create({data:{groupId:gid,...fields}});if(initialStock)r=await stock(tx,r,ctx.member.id,initialStock,'INITIAL','初始库存');await audit(tx,gid,ctx.member.id,'REWARD_CREATE',r.id);return r;});
  }
  if(p[2]==='rewards'&&p.length===4&&method==='PATCH'){
    const rid=id.parse(p[3]);const data=z.object({name:text(50),description:z.string().max(2000),costPoints:integer,fulfillmentInstructions:text(500),expectedVersion:version}).strict().parse(b);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);const r=await lockReward(tx,gid,rid);if(r.version!==data.expectedVersion)fail('VERSION_CONFLICT','奖励信息已变化');const {expectedVersion,...fields}=data;const result=await tx.reward.update({where:{id:rid},data:{...fields,version:{increment:1}}});await audit(tx,gid,ctx.member.id,'REWARD_EDIT',rid);return result;});
  }
  if(p[2]==='rewards'&&p[4]==='status'&&method==='POST'){
    const rid=id.parse(p[3]),data=z.object({status:z.enum(['ACTIVE','INACTIVE']),expectedVersion:version}).strict().parse(b);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);const r=await lockReward(tx,gid,rid);if(r.version!==data.expectedVersion)fail('VERSION_CONFLICT','奖励信息已变化');const result=await tx.reward.update({where:{id:rid},data:{status:data.status,version:{increment:1}}});await audit(tx,gid,ctx.member.id,'REWARD_STATUS',rid,data.status);return result;});
  }
  if(p[2]==='rewards'&&p[4]==='stock-adjustments'&&method==='POST'){
    const rid=id.parse(p[3]),data=z.object({delta:z.number().int().min(-1_000_000).max(1_000_000).refine(v=>v!==0),reason,expectedStockVersion:z.number().int().min(0)}).strict().parse(b);return write(async(tx:any)=>{const ctx=await context(tx,uid,gid,'share');requireAdmin(ctx);const r=await lockReward(tx,gid,rid);if(r.stockVersion!==data.expectedStockVersion)fail('VERSION_CONFLICT','库存已变化');const result=await stock(tx,r,ctx.member.id,data.delta,'ADJUSTMENT',data.reason);await audit(tx,gid,ctx.member.id,'STOCK_ADJUST',rid,data.reason);return result;});
  }
  if(p[2]==='redemptions'&&p.length===3&&method==='POST'){
    const data=z.object({rewardId:id,expectedRewardVersion:version,expectedCostPoints:integer}).strict().parse(b);return write((tx:any)=>redeem(tx,uid,gid,data));
  }
  if(p[2]==='redemptions'&&['cancel','fulfill'].includes(p[4])&&method==='POST'){
    const oid=id.parse(p[3]),data=z.object({reason}).strict().parse(b);return write((tx:any)=>orderAction(tx,uid,gid,oid,p[4],data.reason));
  }
  fail('RESOURCE_NOT_FOUND','接口不存在',404);
 }
}
