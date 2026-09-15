import { PrismaClient, Prisma } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const db = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function fail(code: string, message: string, status = 409): never { throw new HttpException({ code, message }, status); }
export function stable(value: any): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',')}}`; return JSON.stringify(value); }
export async function context(tx: Tx | PrismaClient, uid: string, gid: string, lock: 'share'|'exclusive'|null = null) {
  if (lock === 'share') await tx.$queryRaw`SELECT id FROM groups WHERE id=${gid}::uuid FOR SHARE`;
  if (lock === 'exclusive') await tx.$queryRaw`SELECT id FROM groups WHERE id=${gid}::uuid FOR UPDATE`;
  const group = await tx.group.findUnique({where:{id:gid}});
  const member = await tx.member.findUnique({where:{groupId_userId:{groupId:gid,userId:uid}}});
  if (!group || !member) fail('RESOURCE_NOT_FOUND','群组不存在或你尚未加入',404);
  const role = group.ownerMemberId === member.id ? 'OWNER' : member.role;
  return {group, member, role, admin: role !== 'MEMBER'};
}
export function requireAdmin(c: {admin:boolean}) { if (!c.admin) fail('FORBIDDEN','只有本群管理员可以操作',403); }
export function other(actor: string, target: string) { if(actor === target) fail('SELF_OPERATION_FORBIDDEN','不能给自己发分或核销自己的订单',403); }
export async function audit(tx: Tx,gid:string,actor:string,action:string,target:string,reason?:string) { await tx.audit.create({data:{groupId:gid,actorMemberId:actor,action,targetId:target,reason}}); }
function operationKey(){const k=process.env.OPERATION_KEY||'';if(!/^[a-f0-9]{64}$/i.test(k))throw new Error('OPERATION_KEY must be 32 bytes encoded as hex');return Buffer.from(k,'hex');}
function seal(value:any){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',operationKey(),iv);const ciphertext=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return {iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};}
function unseal(value:any){const c=createDecipheriv('aes-256-gcm',operationKey(),Buffer.from(value.iv,'hex'));c.setAuthTag(Buffer.from(value.tag,'hex'));return JSON.parse(Buffer.concat([c.update(Buffer.from(value.ciphertext,'hex')),c.final()]).toString('utf8'));}
export async function mutation(uid:string,scope:string,key:string,body:unknown,fn:(tx:Tx)=>Promise<any>) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key||'')) fail('VALIDATION_ERROR','缺少有效的幂等请求标识',400);
  const h=hash(stable(body));
  for(let attempt=0;attempt<3;attempt++) {
    try { return await db.$transaction(async tx=>{
      // Transaction advisory lock only deduplicates this request; row locks protect business data.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uid+scope+key},0))`;
      const prev=await tx.operation.findUnique({where:{userId_scope_key:{userId:uid,scope,key}}});
      if(prev) { if(prev.hash!==h) fail('IDEMPOTENCY_KEY_REUSED','相同请求标识不能用于不同操作'); return unseal(prev.response); }
      const result=await fn(tx);
      const serial=JSON.parse(JSON.stringify(result));
      await tx.operation.create({data:{userId:uid,scope,key,hash:h,response:seal(serial)}});
      return serial;
    },{maxWait:5000,timeout:15000,isolationLevel:'ReadCommitted'}); }
    catch(e:any) { if((e.code==='P2034'||e.meta?.code==='40P01')&&attempt<2) continue; throw e; }
  }
}
export async function points(tx:Tx,gid:string,mid:string,actor:string,delta:number,type:string,reason:string,orderId?:string,reversalOfId?:string) {
  await tx.$queryRaw`SELECT id FROM point_accounts WHERE "groupId"=${gid}::uuid AND "memberId"=${mid}::uuid FOR UPDATE`;
  const a=await tx.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:mid}}});
  if(!a) fail('RESOURCE_NOT_FOUND','成员不存在',404);
  const balance=a.balance+delta;
  if(balance<0) fail('INSUFFICIENT_POINTS','当前积分不足');
  if(delta>0) {
    const reserved=await tx.redemption.aggregate({where:{groupId:gid,memberId:mid,status:'PENDING',...(orderId?{id:{not:orderId}}:{})},_sum:{costPoints:true}});
    if(balance+(reserved._sum.costPoints||0)>2_000_000_000) fail('BALANCE_LIMIT_EXCEEDED','积分已达到上限');
  }
  const account=await tx.account.update({where:{id:a.id},data:{balance,version:{increment:1}}});
  const entry=await tx.ledger.create({data:{groupId:gid,memberId:mid,actorMemberId:actor,delta,type,reason,orderId,reversalOfId,balanceAfter:balance,accountVersion:account.version}});
  return {entry,account};
}
export async function stock(tx:Tx,reward:any,actor:string,delta:number,type:string,reason:string,orderId?:string) {
  const next=reward.stockAvailable+delta;
  if(next<0) fail('OUT_OF_STOCK','奖励库存不足');
  const reserved=await tx.redemption.count({where:{groupId:reward.groupId,rewardId:reward.id,status:'PENDING',...(orderId?{id:{not:orderId}}:{})}});
  if(next+reserved>2_000_000_000) fail('STOCK_LIMIT_EXCEEDED','库存已达到上限');
  const updated=await tx.reward.update({where:{id:reward.id},data:{stockAvailable:next,stockVersion:{increment:1}}});
  await tx.stockEntry.create({data:{groupId:reward.groupId,rewardId:reward.id,actorMemberId:actor,delta,type,reason,orderId,stockAfter:next,stockVersion:updated.stockVersion}});
  return updated;
}
export async function lockReward(tx:Tx,gid:string,rid:string) {
  await tx.$queryRaw`SELECT id FROM rewards WHERE id=${rid}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;
  const r=await tx.reward.findFirst({where:{id:rid,groupId:gid}});if(!r) fail('RESOURCE_NOT_FOUND','奖励不存在',404);return r;
}
export async function createGroup(tx:Tx,uid:string,name:string,description:string,color='blue') {
  const gid=randomUUID(),mid=randomUUID();
  const group=await tx.group.create({data:{id:gid,name,description,color,ownerMemberId:mid}});
  const member=await tx.member.create({data:{id:mid,groupId:gid,userId:uid,role:'ADMIN'}});
  const account=await tx.account.create({data:{groupId:gid,memberId:mid}});
  return {group,membership:{...member,effectiveRole:'OWNER'},account};
}
export async function redeem(tx:Tx,uid:string,gid:string,b:any) {
  const c=await context(tx,uid,gid,'share');const r=await lockReward(tx,gid,b.rewardId);
  if(r.status!=='ACTIVE') fail('INVALID_STATE','奖励已下架');
  if(r.version!==b.expectedRewardVersion||r.costPoints!==b.expectedCostPoints) fail('REWARD_CHANGED','奖励信息已更新，请重新确认');
  if(r.stockAvailable<1) fail('OUT_OF_STOCK','这份奖励已兑完');
  const order=await tx.redemption.create({data:{groupId:gid,memberId:c.member.id,rewardId:r.id,costPoints:r.costPoints,rewardSnapshot:{name:r.name,type:r.type,art:r.art,fulfillmentInstructions:r.fulfillmentInstructions}}});
  const {account}=await points(tx,gid,c.member.id,c.member.id,-r.costPoints,'REDEEM',`兑换 ${r.name}`,order.id);
  await stock(tx,r,c.member.id,-1,'REDEEM','兑换奖励',order.id);
  return {order,account};
}
export async function orderAction(tx:Tx,uid:string,gid:string,id:string,action:string,reason:string) {
  const c=await context(tx,uid,gid,'share');
  await tx.$queryRaw`SELECT id FROM redemptions WHERE id=${id}::uuid AND "groupId"=${gid}::uuid FOR UPDATE`;
  const o=await tx.redemption.findFirst({where:{id,groupId:gid}});
  if(!o||(!c.admin&&o.memberId!==c.member.id)) fail('RESOURCE_NOT_FOUND','订单不存在',404);
  if(action==='fulfill') {requireAdmin(c);other(c.member.id,o.memberId);}
  const next=action==='cancel'?'CANCELED':'FULFILLED';
  if(o.status===next) return {order:o,account:await tx.account.findUnique({where:{groupId_memberId:{groupId:gid,memberId:o.memberId}}})};
  if(o.status!=='PENDING') fail('INVALID_STATE','订单状态已变化，请刷新');
  let account;
  if(action==='cancel') {
    const r=await lockReward(tx,gid,o.rewardId);
    ({account}=await points(tx,gid,o.memberId,c.member.id,o.costPoints,'REFUND','取消兑换：'+reason,o.id));
    await stock(tx,r,c.member.id,1,'RESTORE','取消兑换',o.id);
  }
  const order=await tx.redemption.update({where:{id},data:action==='cancel'?{status:next,canceledAt:new Date(),canceledByMemberId:c.member.id,cancelReason:reason,version:{increment:1}}:{status:next,fulfilledAt:new Date(),fulfilledByMemberId:c.member.id,fulfillmentNote:reason,version:{increment:1}}});
  await audit(tx,gid,c.member.id,action,id,reason);return {order,...(account?{account}:{})};
}
