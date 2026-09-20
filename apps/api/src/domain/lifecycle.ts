import { rows, type Db } from '../common/index.js';
export { getBlockers } from './growth.js';
export { ensureChildAccount } from './points.js';

const exportTables = [
  'activity_plans',
  'activity_plan_versions',
  'plan_version_children',
  'activity_occurrences',
  'completion_drafts',
  'completion_submissions',
  'submission_media',
  'completion_decisions',
  'point_accounts',
  'point_ledger',
  'rewards',
  'reward_children',
  'stock_ledger',
  'redemption_orders',
  'weekly_quotas',
  'wishes',
] as const;
export async function exportFamilyDomain(db: Db, familyId: string) {
  const result: Record<string, unknown> = {};
  for (const table of exportTables) {
    result[table] = await rows(db, `SELECT * FROM ${table} WHERE family_id=$1`, [familyId]);
  }
  return result;
}
export async function exportSubjectDomain(db: Db, userId: string) {
  const children = await rows<any>(
    db,
    'SELECT id,family_id FROM child_profiles WHERE bound_user_id=$1',
    [userId],
  );
  const childIds = children.map((c) => c.id);
  const result: Record<string, unknown> = {};
  for (const table of [
    'activity_occurrences',
    'completion_drafts',
    'completion_submissions',
    'submission_media',
    'point_accounts',
    'point_ledger',
    'redemption_orders',
    'wishes',
  ] as const) {
    const data = await rows<any>(db, `SELECT * FROM ${table} WHERE child_id=ANY($1::uuid[])`, [
      childIds,
    ]);
    result[table] = data.map(
      ({
        actorUserId,
        actorMembershipId,
        submittedByUserId,
        applicantUserId,
        approvedByMembershipId,
        fulfilledByMembershipId,
        canceledByUserId,
        ...rest
      }) => rest,
    );
  }
  result.ownOperations = await rows(
    db,
    'SELECT id,family_id,child_id,action,source_id,created_at FROM audit_logs WHERE actor_user_id=$1 ORDER BY created_at,id',
    [userId],
  );
  return result;
}
export async function deleteFamilyDomain(db: Db, familyId: string) {
  await db.query("SELECT set_config('pointjoy.privacy_maintenance','on',true)");
  await db.query(
    'UPDATE activity_occurrences SET latest_submission_id=NULL,award_ledger_id=NULL WHERE family_id=$1',
    [familyId],
  );
  for (const table of [
    'wishes',
    'weekly_quotas',
    'stock_ledger',
    'reward_children',
    'submission_media',
    'completion_decisions',
    'completion_drafts',
  ] as const) {
    await db.query(`DELETE FROM ${table} WHERE family_id=$1`, [familyId]);
  }
  await db.query('DELETE FROM completion_submissions WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM point_ledger WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM point_accounts WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM redemption_orders WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM rewards WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM activity_occurrences WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM plan_version_children WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM activity_plan_versions WHERE family_id=$1', [familyId]);
  await db.query('DELETE FROM activity_plans WHERE family_id=$1', [familyId]);
}
export async function anonymizeSubjectDomain(db: Db, userId: string) {
  await db.query("SELECT set_config('pointjoy.privacy_maintenance','on',true)");
  await db.query(
    'UPDATE point_ledger SET actor_user_id=NULL,actor_membership_id=NULL WHERE actor_user_id=$1',
    [userId],
  );
  await db.query(
    'UPDATE completion_submissions SET submitted_by_user_id=NULL WHERE submitted_by_user_id=$1',
    [userId],
  );
  await db.query('UPDATE stock_ledger SET actor_user_id=NULL WHERE actor_user_id=$1', [userId]);
  await db.query('UPDATE redemption_orders SET applicant_user_id=NULL WHERE applicant_user_id=$1', [
    userId,
  ]);
  await db.query(
    'UPDATE redemption_orders SET canceled_by_user_id=NULL WHERE canceled_by_user_id=$1',
    [userId],
  );
  // Membership rows remain as pseudonymous audit subjects until family deletion.
  // Text/photos belonging to a child data subject are removed by the approved privacy scope,
  // not by silently deleting another household's entire ledger.
}
