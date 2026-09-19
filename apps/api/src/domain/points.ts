import type { FastifyInstance } from 'fastify';
import { ok, type Actor, type Db, type Services } from '../common/index.js';
import { audit } from './events.js';
import { z, uuid, version, reason, randomUUID, one, maybe, rows, must, assertVersion, target, activeChild, accountView, idParam, paging, enumFilter, instant } from './support.js';

export async function ensureChildAccount(db: Db, input: { familyId: string; childId: string }) {
  await db.query('INSERT INTO point_accounts(family_id,child_id) VALUES($1,$2) ON CONFLICT(family_id,child_id) DO NOTHING', [input.familyId, input.childId]);
}
export async function getAccount(db: Db, familyId: string, childId: string, lock = false) {
  const account = await maybe<any>(db, `SELECT * FROM point_accounts WHERE family_id=$1 AND child_id=$2${lock ? ' FOR UPDATE' : ''}`, [familyId, childId]);
  must(account, 'RESOURCE_NOT_FOUND', '积分账户不存在', 404);
  const incident=await financialIncident(db,familyId,childId);
  return {...accountView(account),frozen:!!incident,freezeReason:incident?'RECONCILIATION_REQUIRED':null};
}
export async function financialIncident(db:Db,familyId:string,childId?:string){
  return maybe<any>(db,`SELECT id,code FROM reconcile_incidents WHERE status='OPEN'
    AND (family_id IS NULL OR family_id=$1) AND (child_id IS NULL OR child_id=$2) ORDER BY created_at,id LIMIT 1`,[familyId,childId??null]);
}
type Movement = 'ACTIVITY_AWARD'|'PRAISE'|'AWARD_REVERSAL'|'ORDER_HOLD'|'ORDER_CAPTURE'|'ORDER_RELEASE'|'ORDER_REFUND';
export async function movePoints(db: Db, actor: Actor | null, input: { familyId: string; childId: string; type: Movement; points: number; sourceType: string; sourceId: string; reason: string; reversalOfId?: string; expectedAccountVersion?: number }) {
  must(Number.isSafeInteger(input.points) && input.points > 0, 'VALIDATION_ERROR', '积分必须为正整数', 400);
  const account = await getAccount(db, input.familyId, input.childId, true);
  // The account row serializes all movements. Incidents stay open until an
  // operator has repaired the facts and explicitly passed reconciliation.
  must(!account.frozen, 'ACCOUNT_FROZEN', '积分记录正在核对，请稍后联系家庭负责人处理');
  if (input.expectedAccountVersion !== undefined) assertVersion(account.version, input.expectedAccountVersion);
  const deltas: Record<Movement, [number, number]> = {
    ACTIVITY_AWARD: [input.points,0], PRAISE:[input.points,0], AWARD_REVERSAL:[-input.points,0],
    ORDER_HOLD:[-input.points,input.points], ORDER_CAPTURE:[0,-input.points],
    ORDER_RELEASE:[input.points,-input.points], ORDER_REFUND:[input.points,0],
  };
  const [a,h] = deltas[input.type];
  if (['ACTIVITY_AWARD','PRAISE'].includes(input.type)) {
    must(input.points <= 1000, 'VALIDATION_ERROR', '一次发分不得超过1000', 400);
    must(account.availablePoints + account.heldPoints + input.points <= 1000000, 'GRANT_CAP_EXCEEDED', '新增积分达到上限，请先兑换使用');
  }
  must(account.availablePoints + a >= 0, input.type === 'AWARD_REVERSAL' ? 'REVERSAL_INSUFFICIENT_AVAILABLE' : 'INSUFFICIENT_POINTS', '可用积分不足');
  must(account.heldPoints + h >= 0, 'INVALID_STATE', '预留积分异常，请联系管理员核对');
  must(Number.isSafeInteger(account.availablePoints+a) && Number.isSafeInteger(account.heldPoints+h), 'INVALID_STATE', '积分数值超过安全范围');
  const updated = await one<any>(db, 'UPDATE point_accounts SET available_points=available_points+$3,held_points=held_points+$4,version=version+1,updated_at=clock_timestamp() WHERE family_id=$1 AND child_id=$2 RETURNING *', [input.familyId,input.childId,a,h]);
  const entry = await one<any>(db, `INSERT INTO point_ledger(family_id,child_id,type,available_delta,held_delta,available_after,held_after,account_version,source_type,source_id,actor_user_id,actor_membership_id,actor_mode,reason,reversal_of_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [input.familyId,input.childId,input.type,a,h,updated.availablePoints,updated.heldPoints,updated.version,input.sourceType,input.sourceId,actor?.userId??null,actor?.membershipId??null,actor?.mode??'SYSTEM',input.reason,input.reversalOfId??null]);
  return { account: {...accountView(updated),frozen:false,freezeReason:null}, ledgerEntry: entry };
}
export async function registerPoints(app: FastifyInstance, services: Services) {
  app.get('/families/:familyId/children/:childId/account', async request => {
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId');
    await services.auth.require(request,{familyId,childId});
    return ok(request,await getAccount(services.pool as any,familyId,childId));
  });
  app.get('/families/:familyId/children/:childId/ledger', async request => {
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId');
    await services.auth.require(request,{familyId,childId});
    const q=request.query as any;
    const type=enumFilter(q.type,['ACTIVITY_AWARD','PRAISE','AWARD_REVERSAL','ORDER_HOLD','ORDER_CAPTURE','ORDER_RELEASE','ORDER_REFUND']);
    const dateFrom=q.dateFrom?z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(q.dateFrom):null;
    const dateTo=q.dateTo?z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(q.dateTo):null;
    const page=paging(q,{familyId,childId,type,dateFrom,dateTo});
    const result=await rows<any>(services.pool as any,`SELECT l.*, COALESCE(u.display_name,'已删除账号') AS operator_name FROM point_ledger l LEFT JOIN users u ON u.id=l.actor_user_id
      WHERE l.family_id=$1 AND l.child_id=$2 AND ($3::text IS NULL OR l.type=$3)
      AND ($4::date IS NULL OR l.created_at>=($4::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND ($5::date IS NULL OR l.created_at<(($5::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND ($6::timestamptz IS NULL OR (l.created_at,l.id)<($6,$7::uuid)) ORDER BY l.created_at DESC,l.id DESC LIMIT $8`,
      [familyId,childId,type,dateFrom,dateTo,page.after?.createdAt??null,page.after?.id??null,page.limit+1]);
    return ok(request,page.result(result.map(r=>({...r,operatorSummary:{name:r.operatorName,mode:r.actorMode}}))));
  });
  app.post('/families/:familyId/children/:childId/praises',async request=>{
    const familyId=idParam(request,'familyId'),childId=idParam(request,'childId');
    const body=z.object({points:z.number().int().min(1).max(1000),reason}).strict().parse(request.body);
    return services.mutate(request,{familyId,childId,guardian:true},async(db,actor)=>{
      await activeChild(db,familyId,childId);
      const result=await movePoints(db,actor,{familyId,childId,type:'PRAISE',points:body.points,sourceType:'PRAISE',sourceId:randomUUID(),reason:body.reason});
      await audit(db,actor,'PRAISE',{familyId,childId,sourceId:result.ledgerEntry.id,details:{points:body.points,reason:body.reason}});
      return result;
    });
  });
  app.post('/families/:familyId/ledger/:entryId/reversal',async request=>{
    const familyId=idParam(request,'familyId'),entryId=idParam(request,'entryId');
    const body=z.object({reason,expectedAccountVersion:z.number().int().nonnegative().safe()}).strict().parse(request.body);
    return services.mutate(request,{familyId,guardian:true},async(db,actor)=>{
      const original=await maybe<any>(db,'SELECT * FROM point_ledger WHERE family_id=$1 AND id=$2',[familyId,entryId]);
      must(original,'RESOURCE_NOT_FOUND','积分记录不存在',404);
      must(['ACTIVITY_AWARD','PRAISE'].includes(original.type),'INVALID_STATE','只能完整撤销原始发奖或表扬');
      await activeChild(db,familyId,original.childId);
      if(original.type==='ACTIVITY_AWARD'){
        const occurrence=await one<any>(db,'SELECT * FROM activity_occurrences WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,original.sourceId]);
        must(occurrence.status==='APPROVED','INVALID_STATE','该完成记录不能撤销');
      }
      await one(db,'SELECT id FROM point_ledger WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,entryId]);
      must(!await maybe(db,'SELECT id FROM point_ledger WHERE reversal_of_id=$1',[entryId]),'ALREADY_REVERSED','该积分已撤销');
      const result=await movePoints(db,actor,{familyId,childId:original.childId,type:'AWARD_REVERSAL',points:original.availableDelta,sourceType:'REVERSAL',sourceId:entryId,reason:body.reason,reversalOfId:entryId,expectedAccountVersion:body.expectedAccountVersion});
      if(original.type==='ACTIVITY_AWARD'){
        await db.query("UPDATE activity_occurrences SET status='REVOKED',version=version+1,updated_at=clock_timestamp() WHERE family_id=$1 AND id=$2",[familyId,original.sourceId]);
        await db.query("INSERT INTO completion_decisions(family_id,occurrence_id,action,reason,operator_membership_id) VALUES($1,$2,'REVOKE',$3,$4)",[familyId,original.sourceId,body.reason,actor.membershipId]);
      }
      await audit(db,actor,'AWARD_REVERSAL',{familyId,childId:original.childId,sourceId:entryId,details:{reason:body.reason}});
      return result;
    });
  });
}
