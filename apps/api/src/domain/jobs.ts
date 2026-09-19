import { rows, one, transaction, type Services, type Db, AppError, audit } from '../common/index.js';
import { today } from './support.js';
import { materialize } from './activities.js';
import { expireDueOrders } from './rewards.js';

async function collectIssues(db:Db){
    const issues:any[]=[];
    const checks:Record<string,string>={
      ACCOUNT_LEDGER:`SELECT a.family_id,a.child_id,a.available_points,a.held_points,a.version,COALESCE(SUM(l.available_delta),0) expected_available,COALESCE(SUM(l.held_delta),0) expected_held,COALESCE(MAX(l.account_version),0) expected_version,COUNT(l.id)::int entries
        FROM point_accounts a LEFT JOIN point_ledger l ON l.family_id=a.family_id AND l.child_id=a.child_id GROUP BY a.id
        HAVING a.available_points<>COALESCE(SUM(l.available_delta),0) OR a.held_points<>COALESCE(SUM(l.held_delta),0) OR a.version<>COALESCE(MAX(l.account_version),0) OR a.version<>COUNT(l.id)`,
      ACCOUNT_HELD:`SELECT a.family_id,a.child_id,a.held_points,COALESCE(SUM(o.cost_points_snapshot),0) expected FROM point_accounts a LEFT JOIN redemption_orders o ON o.family_id=a.family_id AND o.child_id=a.child_id AND o.status='PENDING_APPROVAL' GROUP BY a.id HAVING a.held_points<>COALESCE(SUM(o.cost_points_snapshot),0)`,
      LEDGER_SEQUENCE:`SELECT * FROM (SELECT family_id,child_id,id,account_version,available_after,held_after,SUM(available_delta) OVER(PARTITION BY family_id,child_id ORDER BY account_version) expected_available,SUM(held_delta) OVER(PARTITION BY family_id,child_id ORDER BY account_version) expected_held FROM point_ledger) x WHERE available_after<>expected_available OR held_after<>expected_held`,
      OCCURRENCE_AWARD:`SELECT o.family_id,o.child_id,o.id,o.status,COUNT(l.id)::int awards,COALESCE(SUM(l.available_delta),0) awarded,o.award_points_snapshot FROM activity_occurrences o LEFT JOIN point_ledger l ON l.source_type='OCCURRENCE' AND l.source_id=o.id AND l.type='ACTIVITY_AWARD' GROUP BY o.id HAVING (o.status IN ('APPROVED','REVOKED') AND (COUNT(l.id)<>1 OR COALESCE(SUM(l.available_delta),0)<>o.award_points_snapshot)) OR (o.status NOT IN ('APPROVED','REVOKED') AND COUNT(l.id)<>0)`,
      OCCURRENCE_REVERSAL:`SELECT o.family_id,o.child_id,o.id,o.status,COUNT(r.id)::int reversals FROM activity_occurrences o LEFT JOIN point_ledger r ON r.reversal_of_id=o.award_ledger_id GROUP BY o.id HAVING (o.status='REVOKED' AND COUNT(r.id)<>1) OR (o.status<>'REVOKED' AND COUNT(r.id)<>0)`,
      ORDER_LEDGER:`SELECT * FROM (SELECT o.family_id,o.child_id,o.id,o.status,o.approved_at,o.cost_points_snapshot,
        COUNT(l.id) FILTER(WHERE l.type='ORDER_HOLD')::int holds,COUNT(l.id) FILTER(WHERE l.type='ORDER_CAPTURE')::int captures,
        COUNT(l.id) FILTER(WHERE l.type='ORDER_RELEASE')::int releases,COUNT(l.id) FILTER(WHERE l.type='ORDER_REFUND')::int refunds,
        COUNT(l.id) FILTER(WHERE l.type='ORDER_HOLD' AND (l.available_delta<>-o.cost_points_snapshot OR l.held_delta<>o.cost_points_snapshot))::int bad_hold,
        COUNT(l.id) FILTER(WHERE l.type='ORDER_CAPTURE' AND l.held_delta<>-o.cost_points_snapshot)::int bad_capture,
        COUNT(l.id) FILTER(WHERE l.type IN ('ORDER_RELEASE','ORDER_REFUND') AND l.available_delta<>o.cost_points_snapshot)::int bad_return
        FROM redemption_orders o LEFT JOIN point_ledger l ON l.source_type='ORDER' AND l.source_id=o.id GROUP BY o.id) x
        WHERE holds<>1 OR bad_hold<>0 OR bad_capture<>0 OR bad_return<>0
        OR captures<>CASE WHEN approved_at IS NOT NULL THEN 1 ELSE 0 END
        OR releases<>CASE WHEN status IN ('REJECTED','EXPIRED','CANCELED') AND approved_at IS NULL THEN 1 ELSE 0 END
        OR refunds<>CASE WHEN status='CANCELED' AND approved_at IS NOT NULL THEN 1 ELSE 0 END`,
      STOCK_LEDGER:`SELECT r.family_id,r.id,r.stock_available,r.stock_version,COALESCE(SUM(s.delta),0) expected_stock,COALESCE(MAX(s.stock_version),0) expected_version FROM rewards r LEFT JOIN stock_ledger s ON s.reward_id=r.id WHERE r.stock_mode='FINITE' GROUP BY r.id HAVING r.stock_available<>COALESCE(SUM(s.delta),0) OR r.stock_version<>COALESCE(MAX(s.stock_version),0)`,
      ORDER_STOCK:`SELECT o.family_id,o.child_id,o.id,o.status,COUNT(s.id) FILTER(WHERE s.type='RESERVE')::int reserves,COUNT(s.id) FILTER(WHERE s.type='RESTORE')::int restores FROM redemption_orders o LEFT JOIN stock_ledger s ON s.order_id=o.id WHERE o.reward_snapshot->>'stockMode'='FINITE' GROUP BY o.id HAVING COUNT(s.id) FILTER(WHERE s.type='RESERVE')<>1 OR COUNT(s.id) FILTER(WHERE s.type='RESTORE')<>CASE WHEN o.status IN ('REJECTED','CANCELED','EXPIRED') THEN 1 ELSE 0 END`,
      WEEKLY_QUOTA:`SELECT COALESCE(q.family_id,x.family_id) family_id,COALESCE(q.child_id,x.child_id) child_id,COALESCE(q.reward_id,x.reward_id) reward_id,COALESCE(q.week_start,x.request_week_start) week_start,COALESCE(q.occupied_count,0) actual,COALESCE(x.expected,0) expected FROM weekly_quotas q FULL JOIN(SELECT family_id,reward_id,child_id,request_week_start,COUNT(*)::int expected FROM redemption_orders WHERE status IN ('PENDING_APPROVAL','READY','FULFILLED') GROUP BY family_id,reward_id,child_id,request_week_start) x ON q.family_id=x.family_id AND q.reward_id=x.reward_id AND q.child_id=x.child_id AND q.week_start=x.request_week_start WHERE COALESCE(q.occupied_count,0)<>COALESCE(x.expected,0)`,
      MISSING_ACCOUNT:`SELECT c.family_id,c.id child_id FROM child_profiles c LEFT JOIN point_accounts a ON a.child_id=c.id AND a.family_id=c.family_id WHERE a.id IS NULL`,
      ARCHIVE_BLOCKERS:`SELECT c.family_id,c.id child_id FROM child_profiles c JOIN families f ON f.id=c.family_id WHERE (c.status='ARCHIVED' OR f.status='ARCHIVED') AND (EXISTS(SELECT 1 FROM activity_occurrences o WHERE o.child_id=c.id AND o.status IN ('SUBMITTED','NEEDS_CHANGES')) OR EXISTS(SELECT 1 FROM redemption_orders r WHERE r.child_id=c.id AND r.status IN ('PENDING_APPROVAL','READY')))`,
      PLAN_VERSION_OVERLAP:`SELECT a.family_id,a.plan_id,a.id first_version,b.id second_version FROM activity_plan_versions a JOIN activity_plan_versions b ON a.plan_id=b.plan_id AND a.id<b.id WHERE a.published_at IS NOT NULL AND b.published_at IS NOT NULL AND a.superseded_at IS NULL AND b.superseded_at IS NULL AND a.effective_from<COALESCE(b.effective_to,'infinity'::timestamptz) AND b.effective_from<COALESCE(a.effective_to,'infinity'::timestamptz)`,
    };
    for(const[code,sql]of Object.entries(checks))for(const detail of await rows<any>(db,sql))issues.push({code,...detail});
    return issues;
}
export async function reconcile(services:Services){
  return transaction(services.pool,async db=>{
    const issues=await collectIssues(db);
    const counts=await one<any>(db,'SELECT (SELECT COUNT(*)::int FROM point_accounts) accounts,(SELECT COUNT(*)::int FROM point_ledger) ledger_entries,(SELECT COUNT(*)::int FROM redemption_orders) orders,(SELECT COUNT(*)::int FROM activity_occurrences) occurrences');
    for(const issue of issues)await db.query("INSERT INTO reconcile_incidents(family_id,child_id,code,details) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM reconcile_incidents WHERE status='OPEN' AND family_id IS NOT DISTINCT FROM $1 AND child_id IS NOT DISTINCT FROM $2 AND code=$3)",[issue.familyId??null,issue.childId??null,issue.code,JSON.stringify(issue)]);
    const report=await one<any>(db,'INSERT INTO domain_reconciliation_reports(status,issues,counts) VALUES($1,$2,$3) RETURNING *',[issues.length?'FAIL':'PASS',JSON.stringify(issues),JSON.stringify(counts)]);
    return report;
  },'REPEATABLE READ');
}
// Operations-only function: there is deliberately no HTTP endpoint and no
// automatic unfreeze on a later PASS. All normal writes take a family SHARE
// lock; this exclusive lock protects verification and incident closure.
export async function resolveIncidents(services:Services,input:{familyId:string;childId?:string;operator:string;reason:string}){
  if(!input.operator.trim()||!input.reason.trim())throw new AppError(400,'VALIDATION_ERROR','运维操作必须记录操作人和修复原因');
  return transaction(services.pool,async db=>{
    await one(db,'SELECT id FROM families WHERE id=$1 FOR UPDATE',[input.familyId]);
    const remaining=(await collectIssues(db)).filter(x=>(!x.familyId||x.familyId===input.familyId)&&(!input.childId||!x.childId||x.childId===input.childId));
    if(remaining.length)throw new AppError(409,'RECONCILIATION_FAILED','仍存在账务不一致，不能解除冻结',{issues:remaining});
    const resolved=await rows<any>(db,`UPDATE reconcile_incidents SET status='RESOLVED',resolved_at=clock_timestamp(),
      details=details||jsonb_build_object('resolution',jsonb_build_object('operator',$3::text,'reason',$4::text))
      WHERE status='OPEN' AND family_id=$1 AND ($2::uuid IS NULL OR child_id=$2) RETURNING id,code,child_id`,[input.familyId,input.childId??null,input.operator.trim(),input.reason.trim()]);
    await audit(db,null,'RECONCILIATION_RESOLVE',{familyId:input.familyId,childId:input.childId??null,details:{operator:input.operator.trim(),reason:input.reason.trim(),incidentIds:resolved.map(x=>x.id)}});
    return {familyId:input.familyId,childId:input.childId??null,resolved};
  });
}
async function oncePerDay(services:Services,type:string,work:()=>Promise<void>){
  const key=`${type}:${today()}`;
  const claimed=await rows(services.pool,`INSERT INTO domain_job_runs(job_key,status,lease_until) VALUES($1,'RUNNING',clock_timestamp()+interval '15 minutes') ON CONFLICT(job_key) DO UPDATE SET status='RUNNING',lease_until=clock_timestamp()+interval '15 minutes',attempts=domain_job_runs.attempts+1 WHERE domain_job_runs.status<>'DONE' AND domain_job_runs.lease_until<clock_timestamp() RETURNING job_key`,[key]);
  if(!claimed.length)return;
  try{await work();await services.pool.query("UPDATE domain_job_runs SET status='DONE',completed_at=clock_timestamp() WHERE job_key=$1",[key]);}
  catch(error){await services.pool.query("UPDATE domain_job_runs SET status='FAILED',lease_until=clock_timestamp() WHERE job_key=$1",[key]);throw error;}
}
export async function runDomainJobs(services:Services){
  const expiry=await expireDueOrders(services,{limit:250});
  await oncePerDay(services,'materialize',async()=>{
    const families=await rows<any>(services.pool,"SELECT id FROM families WHERE status='ACTIVE' ORDER BY id");
    for(const family of families)await materialize(services.pool as any,{familyId:family.id,from:today(),to:today()});
  });
  await oncePerDay(services,'reconcile',async()=>{await reconcile(services);});
  return expiry;
}
