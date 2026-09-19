import type { FastifyInstance } from 'fastify';
import { outbox, ok, committed, transaction, type Actor, type Db, type Services } from '../common/index.js';
import { audit } from './events.js';
import { z, uuid, version, reason, ids, one, maybe, rows, must, assertVersion, target, activeChild, validateChildren, serverNow, idParam, paging, enumFilter, orderStatuses, weekStart, HOUR } from './support.js';
import { movePoints, getAccount, financialIncident } from './points.js';

const rewardFields={name:z.string().trim().min(2).max(40),description:z.string().trim().max(500).default(''),category:z.enum(['TIME','FOOD','ITEM','EXPERIENCE']),benefitDescription:z.string().trim().min(1).max(200),timeMinutes:z.number().int().min(1).max(1440).nullable().optional(),artKey:z.enum(['gift','game','icecream','fries','book','outing','toy','family']).default('gift'),costPoints:z.number().int().min(1).max(100000),stockMode:z.enum(['FINITE','UNLIMITED']),initialStock:z.number().int().min(0).max(1000000).optional(),weeklyLimit:z.number().int().min(1).max(100).nullable().optional(),childIds:ids};
const rewardInput=z.object(rewardFields).strict();
function validateReward(v:any){
  must(v.category==='TIME'?!!v.timeMinutes:v.timeMinutes==null,'VALIDATION_ERROR','时间奖励须填写分钟数，其他奖励不要填写分钟数',400);
  if(v.stockMode==='FINITE')must(v.initialStock!==undefined,'VALIDATION_ERROR','请填写有限库存',400);
  else must(v.initialStock===undefined,'VALIDATION_ERROR','不限库存不填写数量',400);
  return v;
}
async function rewardChildren(db:Db,familyId:string,rewardId:string,childIds:string[]){
  await validateChildren(db,familyId,childIds);await db.query('DELETE FROM reward_children WHERE reward_id=$1',[rewardId]);
  await db.query('INSERT INTO reward_children(family_id,reward_id,child_id) SELECT $1,$2,x FROM unnest($3::uuid[]) x',[familyId,rewardId,childIds]);
}
export async function rewardView(db:Db,reward:any,guardian=false){
  if(!guardian)return reward;
  const children=await rows<any>(db,'SELECT child_id FROM reward_children WHERE reward_id=$1 ORDER BY child_id',[reward.id]);return{...reward,childIds:children.map(c=>c.childId)};
}
export async function adjustStock(db:Db,actor:Actor|null,reward:any,delta:number,type:'INITIAL'|'ADJUST'|'RESERVE'|'RESTORE',reasonText:string,orderId?:string){
  must(!await financialIncident(db,reward.familyId),'ACCOUNT_FROZEN','家庭奖励记录正在核对，请联系运维处理');
  must(reward.stockMode==='FINITE','INVALID_STATE','不限库存无需修改数量');
  if(delta===0)return reward;
  must(Number.isSafeInteger(delta)&&reward.stockAvailable+delta>=0&&reward.stockAvailable+delta<=1000000,'OUT_OF_STOCK','库存不足或超过技术上限');
  if(type==='ADJUST'||type==='INITIAL'){
    const reserved=await one<any>(db,"SELECT COUNT(*)::int AS count FROM redemption_orders WHERE reward_id=$1 AND status IN ('PENDING_APPROVAL','READY')",[reward.id]);
    must(reward.stockAvailable+delta+reserved.count<=1000000,'VALIDATION_ERROR','补货须保留未兑现订单的可归还空间',400);
  }
  const updated=await one<any>(db,'UPDATE rewards SET stock_available=stock_available+$2,stock_version=stock_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[reward.id,delta]);
  await db.query('INSERT INTO stock_ledger(family_id,reward_id,type,delta,stock_after,stock_version,order_id,actor_user_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[reward.familyId,reward.id,type,delta,updated.stockAvailable,updated.stockVersion,orderId??null,actor?.userId??null,reasonText]);
  return updated;
}
export function orderView(order:any,actor?:Actor,now=new Date()){
  const expiryProcessing=order.status==='PENDING_APPROVAL'&&now>=new Date(order.approvalExpiresAt);
  const allowedActions:string[]=[];
  if(!expiryProcessing){
    if(['PENDING_APPROVAL','READY'].includes(order.status))allowedActions.push('CANCEL');
    if(actor?.mode==='GUARDIAN'){
      if(order.status==='PENDING_APPROVAL')allowedActions.push('APPROVE','REJECT');
      if(order.status==='READY')allowedActions.push('FULFILL');
    }
  }
  return{...order,expiryProcessing,allowedActions};
}
export async function availability(db:Db,familyId:string,childId:string,rewardId:string){
  const reward=await maybe<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2',[familyId,rewardId]);must(reward,'RESOURCE_NOT_FOUND','奖励不存在',404);
  const applicable=!!await maybe(db,'SELECT child_id FROM reward_children WHERE reward_id=$1 AND child_id=$2',[rewardId,childId]);
  const account=await getAccount(db,familyId,childId),week=weekStart();
  const quota=await maybe<any>(db,'SELECT occupied_count FROM weekly_quotas WHERE family_id=$1 AND reward_id=$2 AND child_id=$3 AND week_start=$4',[familyId,rewardId,childId,week]);
  const weeklyRemaining=reward.weeklyLimit==null?null:Math.max(0,reward.weeklyLimit-(quota?.occupiedCount??0));
  const blockingReasons:string[]=[];
  if(account.frozen)blockingReasons.push('ACCOUNT_FROZEN');
  if(reward.status!=='ACTIVE')blockingReasons.push('REWARD_UNAVAILABLE');if(!applicable)blockingReasons.push('NOT_APPLICABLE');
  if(reward.stockMode==='FINITE'&&reward.stockAvailable<1)blockingReasons.push('OUT_OF_STOCK');if(weeklyRemaining===0)blockingReasons.push('WEEKLY_LIMIT_REACHED');
  if(account.availablePoints<reward.costPoints)blockingReasons.push('INSUFFICIENT_POINTS');
  return{rewardId,rewardVersion:reward.version,costPoints:reward.costPoints,applicable,stockAvailable:reward.stockAvailable,weeklyRemaining,availablePoints:account.availablePoints,canRequest:!blockingReasons.length,blockingReasons};
}
async function lockQuota(db:Db,order:any){
  await db.query('INSERT INTO weekly_quotas(family_id,reward_id,child_id,week_start) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[order.familyId,order.rewardId,order.childId,order.requestWeekStart]);
  return one<any>(db,'SELECT * FROM weekly_quotas WHERE family_id=$1 AND reward_id=$2 AND child_id=$3 AND week_start=$4 FOR UPDATE',[order.familyId,order.rewardId,order.childId,order.requestWeekStart]);
}
export async function terminateOrder(db:Db,actor:Actor|null,order:any,status:'REJECTED'|'CANCELED'|'EXPIRED',reasonText:string){
  must(['PENDING_APPROVAL','READY'].includes(order.status),'INVALID_STATE','此订单已不能取消或退回');
  must(status==='CANCELED'||order.status==='PENDING_APPROVAL','INVALID_STATE','只有申请中的订单可拒绝或过期');
  const reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR UPDATE',[order.familyId,order.rewardId]);
  const quota=await lockQuota(db,order);must(quota.occupiedCount>0,'INVALID_STATE','兑换次数数据异常，请先对账');
  const released=await movePoints(db,actor,{familyId:order.familyId,childId:order.childId,type:order.status==='READY'?'ORDER_REFUND':'ORDER_RELEASE',points:order.costPointsSnapshot,sourceType:'ORDER',sourceId:order.id,reason:reasonText});
  if(reward.stockMode==='FINITE')await adjustStock(db,actor,reward,1,'RESTORE',reasonText,order.id);
  await db.query('UPDATE weekly_quotas SET occupied_count=occupied_count-1,version=version+1 WHERE family_id=$1 AND reward_id=$2 AND child_id=$3 AND week_start=$4',[order.familyId,order.rewardId,order.childId,order.requestWeekStart]);
  const result=await one<any>(db,`UPDATE redemption_orders SET status=$2,decision_reason=$3,decided_at=clock_timestamp(),canceled_at=CASE WHEN $2='CANCELED' THEN clock_timestamp() ELSE canceled_at END,
    canceled_by_user_id=CASE WHEN $2='CANCELED' THEN $4::uuid ELSE canceled_by_user_id END,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[order.id,status,reasonText,actor?.userId??null]);
  await audit(db,actor,`ORDER_${status}`,{familyId:order.familyId,childId:order.childId,sourceId:order.id,details:{reason:reasonText,points:order.costPointsSnapshot}});
  await outbox(db,`order:${order.id}:${result.version}`,`ORDER_${status}`,{familyId:order.familyId,childId:order.childId,orderId:order.id});
  return{order:orderView(result,actor??undefined),...released};
}
export async function expireDueOrders(services:Services,input:{familyId?:string;childId?:string;limit?:number}={}){
  const candidates=await rows<any>(services.pool,`SELECT o.id,o.family_id FROM redemption_orders o
    WHERE o.status='PENDING_APPROVAL' AND o.approval_expires_at<=clock_timestamp()
      AND ($1::uuid IS NULL OR o.family_id=$1) AND ($2::uuid IS NULL OR o.child_id=$2)
      AND NOT EXISTS(SELECT 1 FROM reconcile_incidents i WHERE i.status='OPEN' AND (i.family_id IS NULL OR i.family_id=o.family_id) AND (i.child_id IS NULL OR i.child_id=o.child_id))
    ORDER BY o.approval_expires_at,o.id LIMIT $3`,[input.familyId??null,input.childId??null,input.limit??100]);
  let expired=0,frozen=0;
  for(const c of candidates){
    try{await transaction(services.pool,async db=>{
      const family=await maybe(db,"SELECT id FROM families WHERE id=$1 AND status<>'DELETING' FOR SHARE",[c.familyId]);if(!family)return;
      const order=await maybe<any>(db,'SELECT * FROM redemption_orders WHERE id=$1 FOR UPDATE SKIP LOCKED',[c.id]);if(!order||order.status!=='PENDING_APPROVAL')return;
      const now=await serverNow(db);if(now<new Date(order.approvalExpiresAt))return;
      await terminateOrder(db,null,order,'EXPIRED','申请超过72小时未获批准，已自动释放');expired++;
    });}catch(error:any){if(error?.code==='ACCOUNT_FROZEN'){frozen++;continue;}throw error;}
  }
  return{expired,frozen};
}

export async function registerRewards(app:FastifyInstance,services:Services){
  const base='/families/:familyId';
  app.get(`${base}/rewards`,async request=>{
    const familyId=idParam(request,'familyId'),actor=await services.auth.require(request,{familyId}),q=request.query as any;
    const childId=actor.mode==='CHILD'?actor.childId:q.childId?uuid.parse(q.childId):null;
    const status=actor.mode==='CHILD'?'ACTIVE':enumFilter(q.status,['DRAFT','ACTIVE','INACTIVE','ARCHIVED']),category=enumFilter(q.category,['TIME','FOOD','ITEM','EXPERIENCE']);const page=paging(q,{familyId,childId,status,category});
    const result=await rows<any>(services.pool,`SELECT r.* FROM rewards r WHERE family_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR category=$3)
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM reward_children c WHERE c.reward_id=r.id AND c.child_id=$4))
      AND ($5::timestamptz IS NULL OR (r.created_at,r.id)<($5,$6::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT $7`,[familyId,status,category,childId,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);
    const mapped=await Promise.all(result.map(r=>rewardView(services.pool as any,r,actor.mode==='GUARDIAN')));return ok(request,page.result(mapped));
  });
  app.post(`${base}/rewards`,async request=>{
    const familyId=idParam(request,'familyId'),body=validateReward(rewardInput.parse(request.body));
    return services.mutate(request,{familyId,guardian:true},async(db,actor)=>{
      await validateChildren(db,familyId,body.childIds);
      let reward=await one<any>(db,`INSERT INTO rewards(family_id,name,description,category,benefit_description,time_minutes,art_key,cost_points,stock_mode,stock_available,weekly_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[familyId,body.name,body.description,body.category,body.benefitDescription,body.timeMinutes??null,body.artKey,body.costPoints,body.stockMode,body.stockMode==='FINITE'?0:null,body.weeklyLimit??null]);
      await rewardChildren(db,familyId,reward.id,body.childIds);if(body.stockMode==='FINITE'&&body.initialStock)reward=await adjustStock(db,actor,reward,body.initialStock,'INITIAL','初始库存');await audit(db,actor,'REWARD_CREATE',{familyId,sourceId:reward.id,details:{costPoints:body.costPoints}});return rewardView(db,reward,true);
    });
  });
  app.get(`${base}/rewards/:rewardId`,async request=>{
    const familyId=idParam(request,'familyId'),rewardId=idParam(request,'rewardId'),actor=await services.auth.require(request,{familyId});
    const reward=await maybe<any>(services.pool,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2',[familyId,rewardId]);must(reward,'RESOURCE_NOT_FOUND','奖励不存在',404);
    if(actor.mode==='CHILD'){
      const access=await maybe(services.pool,`SELECT 1 FROM reward_children WHERE reward_id=$1 AND child_id=$2 AND $3='ACTIVE' UNION ALL SELECT 1 FROM redemption_orders WHERE reward_id=$1 AND child_id=$2 UNION ALL SELECT 1 FROM wishes WHERE reward_id=$1 AND child_id=$2 LIMIT 1`,[rewardId,actor.childId,reward.status]);must(access,'RESOURCE_NOT_FOUND','奖励不存在',404);
    }
    return ok(request,await rewardView(services.pool as any,reward,actor.mode==='GUARDIAN'));
  });
  app.patch(`${base}/rewards/:rewardId`,async request=>{
    const familyId=idParam(request,'familyId'),rewardId=idParam(request,'rewardId');const patchFields=Object.fromEntries(Object.entries(rewardFields).filter(([k])=>k!=='initialStock').map(([k,v])=>[k,v.optional()]));const body=z.object({...patchFields,expectedVersion:version}).strict().parse(request.body) as any;
    return services.mutate(request,{familyId,guardian:true},async(db,actor)=>{
      let reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,rewardId]);assertVersion(reward.version,body.expectedVersion);must(reward.status!=='ARCHIVED','INVALID_STATE','归档奖励只读');
      const existing=await rewardView(db,reward,true);const input={...existing,...body};must(input.category==='TIME'?!!input.timeMinutes:input.timeMinutes==null,'VALIDATION_ERROR','奖励分钟数与分类不匹配',400);
      if(input.stockMode!==reward.stockMode){must(!reward.publishedAt,'INVALID_STATE','奖励发布后库存模式不能改变');if(reward.stockMode==='FINITE'&&reward.stockAvailable)reward=await adjustStock(db,actor,reward,-reward.stockAvailable,'ADJUST','草稿改为不限库存');}
      if(body.childIds)await rewardChildren(db,familyId,rewardId,body.childIds);
      const updated=await one<any>(db,`UPDATE rewards SET name=$2,description=$3,category=$4,benefit_description=$5,time_minutes=$6,art_key=$7,cost_points=$8,weekly_limit=$9,stock_mode=$10,
        stock_available=CASE WHEN $10='UNLIMITED' THEN NULL ELSE COALESCE(stock_available,0) END,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[rewardId,input.name,input.description,input.category,input.benefitDescription,input.timeMinutes??null,input.artKey,input.costPoints,input.weeklyLimit??null,input.stockMode]);
      await audit(db,actor,'REWARD_EDIT',{familyId,sourceId:rewardId,details:{costPoints:input.costPoints}});return rewardView(db,updated,true);
    });
  });
  app.post(`${base}/rewards/:rewardId/status`,async request=>{
    const familyId=idParam(request,'familyId'),rewardId=idParam(request,'rewardId'),body=z.object({status:z.enum(['ACTIVE','INACTIVE','ARCHIVED']),expectedVersion:version}).strict().parse(request.body);
    return services.mutate(request,{familyId,guardian:true},async(db,actor)=>{
      const reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,rewardId]);assertVersion(reward.version,body.expectedVersion);must(reward.status!=='ARCHIVED','INVALID_STATE','归档奖励首发不恢复');
      if(body.status==='ACTIVE'){const children=await rows<any>(db,"SELECT c.id FROM reward_children rc JOIN child_profiles c ON c.id=rc.child_id WHERE rc.reward_id=$1 AND c.status='ACTIVE'",[rewardId]);must(children.length,'NOT_APPLICABLE','请至少选择一个有效孩子');}
      const updated=await one<any>(db,"UPDATE rewards SET status=$2,published_at=CASE WHEN $2='ACTIVE' THEN COALESCE(published_at,clock_timestamp()) ELSE published_at END,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[rewardId,body.status]);await audit(db,actor,'REWARD_STATUS',{familyId,sourceId:rewardId,details:{status:body.status}});return rewardView(db,updated,true);
    });
  });
  app.post(`${base}/rewards/:rewardId/stock-adjustments`,async request=>{
    const familyId=idParam(request,'familyId'),rewardId=idParam(request,'rewardId'),body=z.object({delta:z.number().int().min(-1000000).max(1000000).refine(n=>n!==0),reason,expectedStockVersion:z.number().int().nonnegative().safe()}).strict().parse(request.body);
    return services.mutate(request,{familyId,guardian:true},async(db,actor)=>{const reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,rewardId]);assertVersion(reward.stockVersion,body.expectedStockVersion);must(reward.status!=='ARCHIVED','INVALID_STATE','归档奖励只读');const updated=await adjustStock(db,actor,reward,body.delta,'ADJUST',body.reason);const entry=await one(db,'SELECT * FROM stock_ledger WHERE reward_id=$1 AND stock_version=$2',[rewardId,updated.stockVersion]);await audit(db,actor,'STOCK_ADJUST',{familyId,sourceId:rewardId,details:{delta:body.delta,reason:body.reason}});return{reward:await rewardView(db,updated,true),stockEntry:entry};});
  });
  app.get(`${base}/rewards/:rewardId/stock-ledger`,async request=>{
    const familyId=idParam(request,'familyId'),rewardId=idParam(request,'rewardId');await services.auth.require(request,{familyId,guardian:true});const page=paging(request.query,{familyId,rewardId});const result=await rows<any>(services.pool,`SELECT * FROM stock_ledger WHERE family_id=$1 AND reward_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,[familyId,rewardId,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);return ok(request,page.result(result));
  });
  app.get(`${base}/children/:childId/reward-availability/:rewardId`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),rewardId=idParam(request,'rewardId');await services.auth.require(request,{familyId,childId});await expireDueOrders(services,{familyId,childId});return ok(request,await availability(services.pool as any,familyId,childId,rewardId));
  });
  app.get(`${base}/children/:childId/wish`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId');await services.auth.require(request,{familyId,childId});const wish=await maybe<any>(services.pool,'SELECT * FROM wishes WHERE family_id=$1 AND child_id=$2',[familyId,childId]);if(!wish)return ok(request,{wish:null,rewardSummary:null,progress:0,pointsGap:0});const reward=await one<any>(services.pool,'SELECT * FROM rewards WHERE id=$1',[wish.rewardId]);const account=await getAccount(services.pool as any,familyId,childId);return ok(request,{wish,rewardSummary:reward,progress:Math.min(account.availablePoints/reward.costPoints,1),pointsGap:Math.max(reward.costPoints-account.availablePoints,0)});
  });
  app.put(`${base}/children/:childId/wish`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),body=z.object({rewardId:uuid,expectedVersion:z.number().int().nonnegative().safe().optional()}).strict().parse(request.body);
    return services.mutate(request,{familyId,childId},async(db,actor)=>{await activeChild(db,familyId,childId);const reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR SHARE',[familyId,body.rewardId]);must(reward.status==='ACTIVE'&&await maybe(db,'SELECT 1 FROM reward_children WHERE reward_id=$1 AND child_id=$2',[reward.id,childId]),'REWARD_UNAVAILABLE','当前奖励不可设为心愿');await getAccount(db,familyId,childId,true);const current=await maybe<any>(db,'SELECT * FROM wishes WHERE family_id=$1 AND child_id=$2 FOR UPDATE',[familyId,childId]);assertVersion(current?.version??0,body.expectedVersion??0);const wish=await one(db,'INSERT INTO wishes(family_id,child_id,reward_id) VALUES($1,$2,$3) ON CONFLICT(family_id,child_id) DO UPDATE SET reward_id=EXCLUDED.reward_id,version=wishes.version+1,selected_at=clock_timestamp() RETURNING *',[familyId,childId,body.rewardId]);await audit(db,actor,'WISH_SET',{familyId,childId,sourceId:body.rewardId,details:{}});return wish;});
  });
  app.delete(`${base}/children/:childId/wish`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),body=z.object({expectedVersion:version}).strict().parse(request.body);
    return services.mutate(request,{familyId,childId},async(db,actor)=>{await activeChild(db,familyId,childId);await getAccount(db,familyId,childId,true);const current=await one<any>(db,'SELECT * FROM wishes WHERE family_id=$1 AND child_id=$2 FOR UPDATE',[familyId,childId]);assertVersion(current.version,body.expectedVersion);await db.query('DELETE FROM wishes WHERE id=$1',[current.id]);await audit(db,actor,'WISH_CLEAR',{familyId,childId,sourceId:current.id,details:{}});return{cleared:true};});
  });
  app.post(`${base}/children/:childId/orders`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),body=z.object({rewardId:uuid,expectedRewardVersion:version,expectedCostPoints:z.number().int().min(1).max(100000)}).strict().parse(request.body);
    await services.auth.require(request,{familyId,childId});await expireDueOrders(services,{familyId,childId});
    return services.mutate(request,{familyId,childId},async(db,actor)=>{
      await activeChild(db,familyId,childId);const reward=await one<any>(db,'SELECT * FROM rewards WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,body.rewardId]);must(reward.status==='ACTIVE','REWARD_UNAVAILABLE','奖励已下架');
      if(reward.version!==body.expectedRewardVersion||reward.costPoints!==body.expectedCostPoints)throw new (await import('../common/index.js')).AppError(409,'REWARD_CHANGED','奖励已变更，请重新确认',{rewardVersion:reward.version,costPoints:reward.costPoints});
      must(await maybe(db,'SELECT 1 FROM reward_children WHERE reward_id=$1 AND child_id=$2',[reward.id,childId]),'NOT_APPLICABLE','奖励不适用于当前孩子');if(reward.stockMode==='FINITE')must(reward.stockAvailable>=1,'OUT_OF_STOCK','奖励已兑完');const now=await serverNow(db),week=weekStart(now);
      const quota=await lockQuota(db,{familyId,rewardId:reward.id,childId,requestWeekStart:week});must(reward.weeklyLimit==null||quota.occupiedCount<reward.weeklyLimit,'WEEKLY_LIMIT_REACHED','本周兑换次数已用完');
      const account=await getAccount(db,familyId,childId,true);must(account.availablePoints>=reward.costPoints,'INSUFFICIENT_POINTS','可用积分不足');
      const snapshot={name:reward.name,category:reward.category,benefitDescription:reward.benefitDescription,timeMinutes:reward.timeMinutes,artKey:reward.artKey,costPoints:reward.costPoints,rewardVersion:reward.version,stockMode:reward.stockMode};
      const order=await one<any>(db,`INSERT INTO redemption_orders(family_id,child_id,reward_id,cost_points_snapshot,reward_snapshot,applicant_mode,applicant_user_id,request_week_start,weekly_limit_snapshot,approval_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[familyId,childId,reward.id,reward.costPoints,JSON.stringify(snapshot),actor.mode,actor.userId,week,reward.weeklyLimit,new Date(now.getTime()+72*HOUR)]);
      const held=await movePoints(db,actor,{familyId,childId,type:'ORDER_HOLD',points:reward.costPoints,sourceType:'ORDER',sourceId:order.id,reason:`申请奖励：${reward.name}`});if(reward.stockMode==='FINITE')await adjustStock(db,actor,reward,-1,'RESERVE','兑换申请预留库存',order.id);
      await db.query('UPDATE weekly_quotas SET occupied_count=occupied_count+1,version=version+1 WHERE family_id=$1 AND reward_id=$2 AND child_id=$3 AND week_start=$4',[familyId,reward.id,childId,week]);await audit(db,actor,'ORDER_REQUEST',{familyId,childId,sourceId:order.id,details:{costPoints:reward.costPoints}});await outbox(db,`order:${order.id}:1`,'ORDER_REQUEST',{familyId,childId,orderId:order.id});return{order:orderView(order,actor),...held};
    });
  });
  for(const route of [`${base}/orders`,`${base}/children/:childId/orders`])app.get(route,async request=>{
    const familyId=idParam(request,'familyId'),hasChild=!!(request.params as any).childId,childId=hasChild?idParam(request,'childId'):null;const actor=await services.auth.require(request,{familyId,...(childId?{childId}:{guardian:true})});const q=request.query as any,filterChild=childId??(q.childId?uuid.parse(q.childId):null),status=enumFilter(q.status,orderStatuses),page=paging(q,{familyId,childId:filterChild,status});await expireDueOrders(services,{familyId,childId:filterChild??undefined});const result=await rows<any>(services.pool,`SELECT o.*,c.nickname child_nickname FROM redemption_orders o JOIN child_profiles c ON c.id=o.child_id WHERE o.family_id=$1 AND ($2::uuid IS NULL OR o.child_id=$2) AND ($3::text IS NULL OR o.status=$3) AND ($4::timestamptz IS NULL OR (o.created_at,o.id)<($4,$5::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $6`,[familyId,filterChild,status,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);return ok(request,page.result(result.map(o=>orderView(o,actor))));
  });
  app.get(`${base}/orders/:orderId`,async request=>{
    const familyId=idParam(request,'familyId'),orderId=idParam(request,'orderId'),actor=await services.auth.require(request,{familyId});let order=await one<any>(services.pool,'SELECT * FROM redemption_orders WHERE family_id=$1 AND id=$2',[familyId,orderId]);target(actor,familyId,order.childId);await expireDueOrders(services,{familyId,childId:order.childId});order=await one<any>(services.pool,'SELECT * FROM redemption_orders WHERE family_id=$1 AND id=$2',[familyId,orderId]);return ok(request,orderView(order,actor));
  });
  for(const action of ['approve','reject','cancel','fulfill'] as const)app.post(`${base}/orders/:orderId/${action}`,async request=>{
    const familyId=idParam(request,'familyId'),orderId=idParam(request,'orderId');
    const schema=action==='approve'?z.object({arrangementNote:z.string().trim().max(200).optional(),expectedVersion:version}):action==='fulfill'?z.object({note:z.string().trim().max(200).optional(),expectedVersion:version}):action==='reject'?z.object({reason,expectedVersion:version}):z.object({reason:reason.optional(),reasonCode:z.enum(['CHANGED_MIND','WAIT_FOR_LATER','OTHER']).optional(),expectedVersion:version});const body=schema.strict().parse(request.body) as any;
    return services.mutate(request,{familyId,...(action!=='cancel'?{guardian:true}:{})},async(db,actor)=>{
      const order=await one<any>(db,'SELECT * FROM redemption_orders WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,orderId]);target(actor,familyId,order.childId);await activeChild(db,familyId,order.childId);assertVersion(order.version,body.expectedVersion);const now=await serverNow(db);
      if(order.status==='PENDING_APPROVAL'&&now>=new Date(order.approvalExpiresAt))return committed({...await terminateOrder(db,actor,order,'EXPIRED','申请超过72小时未获批准，已自动释放'),expired:true},409);
      if(action==='approve'){
        must(order.status==='PENDING_APPROVAL','INVALID_STATE','订单已被处理');const captured=await movePoints(db,actor,{familyId,childId:order.childId,type:'ORDER_CAPTURE',points:order.costPointsSnapshot,sourceType:'ORDER',sourceId:order.id,reason:`批准奖励：${order.rewardSnapshot.name}`});const updated=await one<any>(db,"UPDATE redemption_orders SET status='READY',approved_at=$2,approved_by_membership_id=$3,arrangement_note=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[order.id,now,actor.membershipId,body.arrangementNote??null]);await audit(db,actor,'ORDER_APPROVE',{familyId,childId:order.childId,sourceId:order.id,details:{}});await outbox(db,`order:${order.id}:${updated.version}`,'ORDER_READY',{familyId,childId:order.childId,orderId:order.id});return{order:orderView(updated,actor),...captured};
      }
      if(action==='reject'){must(order.status==='PENDING_APPROVAL','INVALID_STATE','只能拒绝待批准申请');return terminateOrder(db,actor,order,'REJECTED',body.reason);}
      if(action==='cancel'){
        if(actor.mode==='GUARDIAN')must(body.reason,'VALIDATION_ERROR','家长取消请填写原因',400);else must(body.reason||body.reasonCode,'VALIDATION_ERROR','请选择取消理由',400);
        const labels:Record<string,string>={CHANGED_MIND:'我改变主意了',WAIT_FOR_LATER:'以后再兑换',OTHER:'我想取消'};return terminateOrder(db,actor,order,'CANCELED',body.reason??labels[body.reasonCode]);
      }
      must(order.status==='READY','INVALID_STATE','只有已批准的奖励可以确认兑现');const updated=await one<any>(db,"UPDATE redemption_orders SET status='FULFILLED',fulfilled_at=$2,fulfilled_by_membership_id=$3,fulfillment_note=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[order.id,now,actor.membershipId,body.note??null]);await audit(db,actor,'ORDER_FULFILL',{familyId,childId:order.childId,sourceId:order.id,details:{note:body.note??''}});await outbox(db,`order:${order.id}:${updated.version}`,'ORDER_FULFILLED',{familyId,childId:order.childId,orderId:order.id});return orderView(updated,actor);
    });
  });
}
