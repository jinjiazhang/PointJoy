import type { FastifyInstance } from 'fastify';
import { ok, type Actor, type Db, type Services } from '../common/index.js';
import { z, uuid, one, rows, idParam, paging, range, enumFilter, occurrenceStatuses, today, dateString, dayStart, dayEnd, addDays, must } from './support.js';
import { materialize, occurrenceView } from './activities.js';
import { getAccount } from './points.js';
import { expireDueOrders, orderView } from './rewards.js';

export function progress(records:any[]){
  const approvedCount=records.filter(o=>o.status==='APPROVED').length,exemptedCount=records.filter(o=>o.status==='EXEMPTED').length;
  const expectedCount=records.length-exemptedCount;
  return{approvedCount,expectedCount,exemptedCount,rate:expectedCount?approvedCount/expectedCount:null};
}
export async function getBlockers(db:Db,familyId:string,childId?:string){
  const occurrences=await rows<any>(db,"SELECT id,child_id,title_snapshot,status FROM activity_occurrences WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND status IN ('SUBMITTED','NEEDS_CHANGES') ORDER BY created_at,id",[familyId,childId??null]);
  const orders=await rows<any>(db,"SELECT id,child_id,reward_snapshot,status FROM redemption_orders WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND status IN ('PENDING_APPROVAL','READY') ORDER BY created_at,id",[familyId,childId??null]);
  const accounts=await rows<any>(db,'SELECT * FROM point_accounts WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) ORDER BY child_id',[familyId,childId??null]);
  return{canArchive:!occurrences.length&&!orders.length,blockingOccurrences:occurrences,blockingOrders:orders,occurrences,orders,accounts,account:childId?accounts[0]??null:undefined,hasNonzeroBalance:accounts.some(a=>a.availablePoints+a.heldPoints>0)};
}
export async function registerGrowth(app:FastifyInstance,services:Services){
  const base='/families/:familyId';
  app.get(`${base}/children/:childId/today`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),actor=await services.auth.require(request,{familyId,childId});const q=request.query as any,date=dateString.parse(q.businessDate??today());
    must(date<=today()&&date>=addDays(today(),-366),'VALIDATION_ERROR','只能查看今天或过去一年安排',400);
    await materialize(services.pool as any,{familyId,childId,from:date,to:date});
    const result=await rows<any>(services.pool,`SELECT o.*,p.stopped_at FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id WHERE o.family_id=$1 AND o.child_id=$2 AND
      ((o.type='ROUTINE' AND o.business_date=$3) OR (o.type='CHALLENGE' AND ((o.starts_at<$5 AND o.ends_at>$4) OR o.status IN ('SUBMITTED','NEEDS_CHANGES')))) ORDER BY o.created_at,o.id`,[familyId,childId,date,dayStart(date),dayEnd(date)]);
    const routines=result.filter(o=>o.type==='ROUTINE').map(o=>occurrenceView(o,actor)),challenges=result.filter(o=>o.type==='CHALLENGE').map(o=>occurrenceView(o,actor));
    return ok(request,{businessDate:date,account:await getAccount(services.pool as any,familyId,childId),routines,challenges,routineProgress:progress(routines),asOf:new Date().toISOString()});
  });
  app.get(`${base}/children/:childId/history`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId'),actor=await services.auth.require(request,{familyId,childId}),q=request.query as any,{from,to}=range(q),type=enumFilter(q.type,['ROUTINE','CHALLENGE']),status=enumFilter(q.status,occurrenceStatuses),page=paging(q,{familyId,childId,type,status,from,to});
    await materialize(services.pool as any,{familyId,childId,from,to});
    const result=await rows<any>(services.pool,`SELECT o.*,p.stopped_at FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id WHERE o.family_id=$1 AND o.child_id=$2
      AND ($3::text IS NULL OR o.type=$3) AND ($4::text IS NULL OR o.status=$4) AND o.starts_at<$6 AND o.ends_at>$5
      AND ($7::timestamptz IS NULL OR (o.created_at,o.id)<($7,$8::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $9`,[familyId,childId,type,status,dayStart(from),dayEnd(to),page.after?.createdAt??null,page.after?.id??null,page.limit+1]);return ok(request,page.result(result.map(o=>occurrenceView(o,actor))));
  });
  app.get(`${base}/children/:childId/growth`,async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId');await services.auth.require(request,{familyId,childId});const {from,to}=range(request.query);await materialize(services.pool as any,{familyId,childId,from,to});
    const daily=await rows<any>(services.pool,`SELECT business_date,COUNT(*)::int total,COUNT(*) FILTER(WHERE status='APPROVED')::int approved_count,COUNT(*) FILTER(WHERE status='EXEMPTED')::int exempted_count
      FROM activity_occurrences WHERE family_id=$1 AND child_id=$2 AND type='ROUTINE' AND business_date BETWEEN $3::date AND $4::date GROUP BY business_date ORDER BY business_date`,[familyId,childId,from,to]);
    const challengeCounts=await rows(services.pool,"SELECT status,COUNT(*)::int count FROM activity_occurrences WHERE family_id=$1 AND child_id=$2 AND type='CHALLENGE' AND starts_at<$4 AND ends_at>$3 GROUP BY status",[familyId,childId,dayStart(from),dayEnd(to)]);
    const pointTotals=await one<any>(services.pool,`SELECT COALESCE(SUM(available_delta) FILTER(WHERE type IN ('ACTIVITY_AWARD','PRAISE')),0) earned,
      COALESCE(-SUM(available_delta) FILTER(WHERE type='AWARD_REVERSAL'),0) reversed,
      COALESCE(-SUM(held_delta) FILTER(WHERE type='ORDER_CAPTURE'),0) spent,
      COALESCE(SUM(available_delta) FILTER(WHERE type='ORDER_REFUND'),0) refunded
      FROM point_ledger WHERE family_id=$1 AND child_id=$2 AND created_at>=$3 AND created_at<$4`,[familyId,childId,dayStart(from),dayEnd(to)]);
    const days=[];for(let day=from;day<=to;day=addDays(day,1)){const row=daily.find(r=>r.businessDate===day)??{businessDate:day,total:0,approvedCount:0,exemptedCount:0};const expectedCount=row.total-row.exemptedCount;days.push({...row,expectedCount,rate:expectedCount?row.approvedCount/expectedCount:null});}
    const totals=days.reduce((s,d)=>({approvedCount:s.approvedCount+d.approvedCount,expectedCount:s.expectedCount+d.expectedCount,exemptedCount:s.exemptedCount+d.exemptedCount}),{approvedCount:0,expectedCount:0,exemptedCount:0});
    return ok(request,{dateFrom:from,dateTo:to,timeZone:'Asia/Shanghai',routineProgress:{...totals,rate:totals.expectedCount?totals.approvedCount/totals.expectedCount:null},dailyRoutines:days,challengeCounts,points:{...pointTotals,netEarned:pointTotals.earned-pointTotals.reversed,netSpent:pointTotals.spent-pointTotals.refunded},account:await getAccount(services.pool as any,familyId,childId)});
  });
  app.get(`${base}/dashboard`,async request=>{
    const familyId=idParam(request,'familyId'),actor=await services.auth.require(request,{familyId,guardian:true}),q=request.query as any,childId=q.childId?uuid.parse(q.childId):null,date=dateString.parse(q.businessDate??today());must(date<=today(),'VALIDATION_ERROR','未来安排请查看排程预览',400);
    await materialize(services.pool as any,{familyId,childId:childId??undefined,from:date,to:date});await expireDueOrders(services,{familyId,childId:childId??undefined});
    const routines=await rows<any>(services.pool,"SELECT * FROM activity_occurrences WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND type='ROUTINE' AND business_date=$3",[familyId,childId,date]);
    const pending=await one<any>(services.pool,"SELECT COUNT(*)::int count FROM activity_occurrences WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND status='SUBMITTED'",[familyId,childId]);
    const orderCounts=await one<any>(services.pool,"SELECT COUNT(*) FILTER(WHERE status='PENDING_APPROVAL')::int pending_approval_count,COUNT(*) FILTER(WHERE status='READY')::int ready_count FROM redemption_orders WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2)",[familyId,childId]);
    const challengeCounts=await rows(services.pool,"SELECT status,COUNT(*)::int count FROM activity_occurrences WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND type='CHALLENGE' AND starts_at<$4 AND ends_at>$3 GROUP BY status",[familyId,childId,dayStart(date),dayEnd(date)]);
    const children=await rows<any>(services.pool,"SELECT c.id,c.nickname,c.avatar_media_id,c.status,a.available_points,a.held_points,a.version AS account_version FROM child_profiles c JOIN point_accounts a ON a.child_id=c.id WHERE c.family_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND (c.status='ACTIVE' OR $2 IS NOT NULL) ORDER BY c.created_at,c.id",[familyId,childId]);
    return ok(request,{businessDate:date,routineProgress:progress(routines),challengeCounts,pendingReviewCount:pending.count,...orderCounts,childrenSummary:children.map(c=>({...c,routineProgress:progress(routines.filter(o=>o.childId===c.id))})),asOf:new Date().toISOString()});
  });
  app.get(`${base}/todos`,async request=>{
    const familyId=idParam(request,'familyId'),actor=await services.auth.require(request,{familyId,guardian:true}),q=request.query as any,type=z.enum(['REVIEW','APPROVAL','FULFILLMENT']).parse(q.type),childId=q.childId?uuid.parse(q.childId):null,page=paging(q,{familyId,childId,type});await expireDueOrders(services,{familyId,childId:childId??undefined});
    if(type==='REVIEW'){
      const result=await rows<any>(services.pool,`SELECT o.*,p.stopped_at,c.nickname child_nickname FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id JOIN child_profiles c ON c.id=o.child_id WHERE o.family_id=$1 AND ($2::uuid IS NULL OR o.child_id=$2) AND o.status='SUBMITTED'
        AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3,$4::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $5`,[familyId,childId,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);
      const count=await one<any>(services.pool,"SELECT COUNT(*)::int count FROM activity_occurrences WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND status='SUBMITTED'",[familyId,childId]);return ok(request,{...page.result(result.map(o=>occurrenceView(o,actor))),totalCount:count.count});
    }
    const status=type==='APPROVAL'?'PENDING_APPROVAL':'READY';const result=await rows<any>(services.pool,`SELECT o.*,c.nickname child_nickname FROM redemption_orders o JOIN child_profiles c ON c.id=o.child_id WHERE o.family_id=$1 AND ($2::uuid IS NULL OR o.child_id=$2) AND o.status=$3 AND ($4::timestamptz IS NULL OR (o.created_at,o.id)<($4,$5::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $6`,[familyId,childId,status,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);const count=await one<any>(services.pool,'SELECT COUNT(*)::int count FROM redemption_orders WHERE family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) AND status=$3',[familyId,childId,status]);return ok(request,{...page.result(result.map(o=>orderView(o,actor))),totalCount:count.count});
  });
  app.get(`${base}/audit-logs`,async request=>{
    const familyId=idParam(request,'familyId');await services.auth.require(request,{familyId,guardian:true});const q=request.query as any,childId=q.childId?uuid.parse(q.childId):null,action=q.action?z.string().regex(/^[A-Z_]{1,80}$/).parse(q.action):null,{from,to}=range(q),page=paging(q,{familyId,childId,action,from,to});
    const result=await rows<any>(services.pool,`SELECT a.*,COALESCE(u.display_name,'已删除账号') operator_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.family_id=$1 AND ($2::uuid IS NULL OR a.child_id=$2) AND ($3::text IS NULL OR a.action=$3) AND a.created_at>=$4 AND a.created_at<$5 AND ($6::timestamptz IS NULL OR (a.created_at,a.id)<($6,$7::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $8`,[familyId,childId,action,dayStart(from),dayEnd(to),page.after?.createdAt??null,page.after?.id??null,page.limit+1]);return ok(request,page.result(result));
  });
}
