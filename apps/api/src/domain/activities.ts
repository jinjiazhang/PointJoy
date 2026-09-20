import type { FastifyInstance } from 'fastify';
import { ok, transaction, type Actor, type Db, type Services } from '../common/index.js';
import { audit } from './events.js';
import {
  z,
  uuid,
  version,
  reason,
  note,
  ids,
  mediaIds,
  instant,
  one,
  maybe,
  rows,
  must,
  assertVersion,
  target,
  activeChild,
  validateChildren,
  serverNow,
  idParam,
  paging,
  range,
  enumFilter,
  occurrenceStatuses,
  today,
  dayEnd,
  addDays,
  HOUR,
  DAY,
} from './support.js';
import { movePoints } from './points.js';

const planFields = {
  type: z.enum(['ROUTINE', 'CHALLENGE']),
  title: z.string().trim().min(2).max(40),
  description: z.string().trim().max(500).default(''),
  metric: z.enum(['CHECK', 'COUNT', 'DURATION', 'DISTANCE']),
  targetValue: z.number().int().positive().optional(),
  unit: z.enum(['REP', 'ITEM', 'MINUTE', 'METER']).optional(),
  awardPoints: z.number().int().min(1).max(1000),
  childIds: ids,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  startsAt: instant.optional(),
  endsAt: instant.optional(),
};
const planInput = z.object(planFields).strict();
type PlanInput = z.infer<typeof planInput>;
function validatePlan(value: PlanInput) {
  if (value.metric === 'CHECK') {
    must(
      value.targetValue === undefined && value.unit === undefined,
      'VALIDATION_ERROR',
      '完成确认不填写计量目标',
      400,
    );
  } else {
    const upper = { COUNT: 100000, DURATION: 1440, DISTANCE: 1000000 }[value.metric];
    must(
      value.targetValue !== undefined && value.targetValue <= upper,
      'VALIDATION_ERROR',
      '请填写有效的整数目标',
      400,
    );
    if (value.metric === 'COUNT') {
      must(['REP', 'ITEM'].includes(value.unit ?? ''), 'VALIDATION_ERROR', '请选择次或个', 400);
    }
    if (value.metric === 'DURATION') {
      must(value.unit === 'MINUTE', 'VALIDATION_ERROR', '时长单位必须为整分钟', 400);
    }
    if (value.metric === 'DISTANCE') {
      must(value.unit === 'METER', 'VALIDATION_ERROR', '距离单位必须为整米', 400);
    }
  }
  if (value.type === 'ROUTINE') {
    must(
      value.weekdays?.length &&
        new Set(value.weekdays).size === value.weekdays.length &&
        !value.startsAt &&
        !value.endsAt,
      'VALIDATION_ERROR',
      '日常请选择不重复的星期，不填写挑战窗口',
      400,
    );
  } else {
    must(
      value.startsAt &&
        value.endsAt &&
        new Date(value.endsAt) > new Date(value.startsAt) &&
        !value.weekdays,
      'VALIDATION_ERROR',
      '挑战起止时间无效',
      400,
    );
  }
  return value;
}
async function insertVersion(
  db: Db,
  familyId: string,
  planId: string,
  revision: number,
  input: PlanInput,
  options: { effectiveFrom?: Date; publishedAt?: Date; active?: boolean } = {},
) {
  const result = await one<any>(
    db,
    `INSERT INTO activity_plan_versions(family_id,plan_id,revision,title,description,metric,target_value,unit,award_points,weekdays,starts_at,ends_at,active,effective_from,published_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      familyId,
      planId,
      revision,
      input.title,
      input.description,
      input.metric,
      input.targetValue ?? null,
      input.unit ?? null,
      input.awardPoints,
      input.weekdays ?? null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      options.active ?? true,
      options.effectiveFrom ?? null,
      options.publishedAt ?? null,
    ],
  );
  await db.query(
    'INSERT INTO plan_version_children(family_id,plan_version_id,child_id) SELECT $1,$2,x FROM unnest($3::uuid[]) x',
    [familyId, result.id, input.childIds],
  );
  return result;
}
async function versionInput(db: Db, v: any, type: 'ROUTINE' | 'CHALLENGE'): Promise<PlanInput> {
  const children = await rows<any>(
    db,
    'SELECT child_id FROM plan_version_children WHERE plan_version_id=$1 ORDER BY child_id',
    [v.id],
  );
  return {
    type,
    title: v.title,
    description: v.description,
    metric: v.metric,
    targetValue: v.targetValue ?? undefined,
    unit: v.unit ?? undefined,
    awardPoints: v.awardPoints,
    childIds: children.map((c) => c.childId),
    weekdays: v.weekdays ?? undefined,
    startsAt: v.startsAt ?? undefined,
    endsAt: v.endsAt ?? undefined,
  };
}
export async function planViews(db: Db, plans: any[]) {
  if (!plans.length) {
    return [];
  }
  const versions = await rows<any>(
    db,
    `SELECT v.*,COALESCE(array_agg(c.child_id ORDER BY c.child_id) FILTER(WHERE c.child_id IS NOT NULL),'{}') AS child_ids
    FROM activity_plan_versions v LEFT JOIN plan_version_children c ON c.plan_version_id=v.id WHERE v.plan_id=ANY($1::uuid[]) GROUP BY v.id ORDER BY v.revision DESC`,
    [plans.map((p) => p.id)],
  );
  // Publication and effective windows use the database clock, including this read.
  const now = (await serverNow(db)).getTime();
  return plans.map((p) => {
    const pv = versions.filter((v) => v.planId === p.id);
    const valid = pv.filter((v) => v.publishedAt && !v.supersededAt);
    const current = valid.find(
      (v) =>
        Date.parse(v.effectiveFrom) <= now && (!v.effectiveTo || Date.parse(v.effectiveTo) > now),
    );
    const scheduled = valid
      .filter((v) => Date.parse(v.effectiveFrom) > now)
      .sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom))[0];
    return {
      ...p,
      currentVersion: current ?? null,
      scheduledVersion: scheduled ?? null,
      draftVersion: pv.find((v) => !v.publishedAt) ?? null,
      applicableChildIds: (current ?? scheduled ?? pv[0])?.childIds ?? [],
    };
  });
}
export async function materialize(
  db: Db,
  input: { familyId: string; from: string; to: string; childId?: string; planId?: string },
): Promise<void> {
  if (typeof (db as any).release !== 'function') {
    return transaction(db as any, (client) => materialize(client, input));
  }
  await one(db, "SELECT id FROM families WHERE id=$1 AND status<>'DELETING' FOR SHARE", [
    input.familyId,
  ]);
  const end = input.to > today() ? today() : input.to;
  if (input.from <= end) {
    await db.query(
      `INSERT INTO activity_occurrences(family_id,plan_id,plan_version_id,child_id,occurrence_key,type,business_date,starts_at,ends_at,title_snapshot,description_snapshot,metric_snapshot,target_value_snapshot,unit_snapshot,award_points_snapshot)
      SELECT p.family_id,p.id,v.id,c.id,'D:'||ds.d::date::text,'ROUTINE',ds.d::date,
        GREATEST(ds.d::timestamp AT TIME ZONE 'Asia/Shanghai',v.effective_from,pc.assigned_at,c.created_at),
        (ds.d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai',v.title,v.description,v.metric,v.target_value,v.unit,v.award_points
      FROM activity_plans p JOIN activity_plan_versions v ON v.plan_id=p.id
      JOIN plan_version_children pc ON pc.plan_version_id=v.id JOIN child_profiles c ON c.id=pc.child_id AND c.family_id=p.family_id
      CROSS JOIN generate_series($2::date,$3::date,'1 day'::interval) ds(d)
      WHERE p.family_id=$1 AND p.type='ROUTINE' AND p.lifecycle<>'DRAFT' AND v.published_at IS NOT NULL AND v.superseded_at IS NULL AND v.active
        AND ($4::uuid IS NULL OR c.id=$4) AND ($5::uuid IS NULL OR p.id=$5)
        AND EXTRACT(ISODOW FROM ds.d)::smallint=ANY(v.weekdays)
        AND v.effective_from<((ds.d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        AND (v.effective_to IS NULL OR v.effective_to>(ds.d::timestamp AT TIME ZONE 'Asia/Shanghai'))
        AND c.created_at<((ds.d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        AND pc.assigned_at<((ds.d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        AND (c.archived_at IS NULL OR c.archived_at>(ds.d::timestamp AT TIME ZONE 'Asia/Shanghai'))
      ON CONFLICT(family_id,plan_id,child_id,occurrence_key) DO NOTHING`,
      [input.familyId, input.from, end, input.childId ?? null, input.planId ?? null],
    );
  }
  await db.query(
    `INSERT INTO activity_occurrences(family_id,plan_id,plan_version_id,child_id,occurrence_key,type,starts_at,ends_at,title_snapshot,description_snapshot,metric_snapshot,target_value_snapshot,unit_snapshot,award_points_snapshot)
    SELECT p.family_id,p.id,v.id,c.id,'C','CHALLENGE',GREATEST(v.starts_at,v.published_at,pc.assigned_at,c.created_at),v.ends_at,v.title,v.description,v.metric,v.target_value,v.unit,v.award_points
    FROM activity_plans p JOIN activity_plan_versions v ON v.plan_id=p.id JOIN plan_version_children pc ON pc.plan_version_id=v.id
    JOIN child_profiles c ON c.id=pc.child_id AND c.family_id=p.family_id
    WHERE p.family_id=$1 AND p.type='CHALLENGE' AND p.lifecycle<>'DRAFT' AND v.published_at IS NOT NULL AND v.superseded_at IS NULL
      AND ($2::uuid IS NULL OR c.id=$2) AND ($3::uuid IS NULL OR p.id=$3)
      AND GREATEST(v.starts_at,v.published_at,pc.assigned_at,c.created_at)<v.ends_at
      AND (c.archived_at IS NULL OR c.archived_at>GREATEST(v.starts_at,v.published_at,pc.assigned_at,c.created_at))
    ON CONFLICT(family_id,plan_id,child_id,occurrence_key) DO NOTHING`,
    [input.familyId, input.childId ?? null, input.planId ?? null],
  );
}
export function occurrenceView(o: any, actor?: Actor, now = new Date()) {
  let displayState = o.status;
  if (o.status === 'OPEN') {
    displayState = o.stoppedAt
      ? 'STOPPED'
      : now < new Date(o.startsAt)
        ? 'NOT_STARTED'
        : now >= new Date(o.endsAt)
          ? 'OVERDUE'
          : 'OPEN';
  }
  if (o.status === 'NEEDS_CHANGES' && now >= new Date(o.supplementUntil)) {
    displayState = 'SUPPLEMENT_OVERDUE';
  }
  const allowedActions: string[] = [];
  if (['OPEN', 'NEEDS_CHANGES'].includes(o.status)) {
    allowedActions.push('SAVE_DRAFT');
    if (
      (o.status === 'OPEN' && displayState === 'OPEN') ||
      (o.status === 'NEEDS_CHANGES' && displayState === 'NEEDS_CHANGES')
    ) {
      allowedActions.push('SUBMIT');
    }
  }
  if (actor?.mode === 'GUARDIAN') {
    if (o.status === 'SUBMITTED') {
      allowedActions.push('APPROVE', 'RETURN');
    }
    if (['OPEN', 'SUBMITTED', 'NEEDS_CHANGES'].includes(o.status)) {
      allowedActions.push('EXEMPT');
    }
    if (['OPEN', 'NEEDS_CHANGES'].includes(o.status)) {
      allowedActions.push('DIRECT_COMPLETE');
    }
    if (o.status === 'APPROVED') {
      allowedActions.push('REVOKE');
    }
  }
  return {
    ...o,
    displayState,
    snapshot: {
      title: o.titleSnapshot,
      description: o.descriptionSnapshot,
      metric: o.metricSnapshot,
      targetValue: o.targetValueSnapshot,
      unit: o.unitSnapshot,
      awardPoints: o.awardPointsSnapshot,
    },
    allowedActions,
  };
}
export async function occurrenceDetail(
  db: Db,
  familyId: string,
  occurrenceId: string,
  actor?: Actor,
) {
  const o = await maybe<any>(
    db,
    'SELECT o.*,p.stopped_at FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id WHERE o.family_id=$1 AND o.id=$2',
    [familyId, occurrenceId],
  );
  must(o, 'RESOURCE_NOT_FOUND', '完成记录不存在', 404);
  if (actor) {
    target(actor, familyId, o.childId);
  }
  const submissions = await rows<any>(
    db,
    `SELECT s.*,COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'status',m.status,'retentionUntil',m.retention_until) ORDER BY sm.sort_order) FILTER(WHERE m.id IS NOT NULL),'[]'::jsonb) AS media
    FROM completion_submissions s LEFT JOIN submission_media sm ON sm.submission_id=s.id LEFT JOIN media_assets m ON m.id=sm.media_id
    WHERE s.family_id=$1 AND s.occurrence_id=$2 GROUP BY s.id ORDER BY s.sequence DESC`,
    [familyId, occurrenceId],
  );
  const decisions = await rows<any>(
    db,
    'SELECT * FROM completion_decisions WHERE family_id=$1 AND occurrence_id=$2 ORDER BY created_at,id',
    [familyId, occurrenceId],
  );
  const draft = await maybe(
    db,
    'SELECT * FROM completion_drafts WHERE family_id=$1 AND occurrence_id=$2',
    [familyId, occurrenceId],
  );
  return {
    ...occurrenceView(o, actor),
    latestSubmission: submissions[0] ?? null,
    submissions,
    reviewHistory: decisions,
    draft,
  };
}
async function lockOccurrence(db: Db, actor: Actor, familyId: string, occurrenceId: string) {
  const source = await one<any>(
    db,
    'SELECT plan_id FROM activity_occurrences WHERE family_id=$1 AND id=$2',
    [familyId, occurrenceId],
  );
  await one(db, 'SELECT id FROM activity_plans WHERE family_id=$1 AND id=$2 FOR SHARE', [
    familyId,
    source.planId,
  ]);
  const o = await maybe<any>(
    db,
    `SELECT o.*,p.stopped_at FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id WHERE o.family_id=$1 AND o.id=$2 FOR UPDATE OF o`,
    [familyId, occurrenceId],
  );
  must(o, 'RESOURCE_NOT_FOUND', '完成记录不存在', 404);
  target(actor, familyId, o.childId);
  await activeChild(db, familyId, o.childId);
  return o;
}
function validateValue(
  o: any,
  input: { checked?: boolean; actualValue?: number },
  requireTarget: boolean,
) {
  if (o.metricSnapshot === 'CHECK') {
    must(input.actualValue === undefined, 'VALIDATION_ERROR', '此活动只需确认完成', 400);
    if (requireTarget) {
      must(input.checked === true, 'TARGET_NOT_MET', '请确认已经完成', 422);
    }
  } else {
    const upper: Record<string, number> = { COUNT: 100000, DURATION: 1440, DISTANCE: 1000000 };
    must(
      input.checked === undefined &&
        input.actualValue !== undefined &&
        input.actualValue >= 0 &&
        input.actualValue <= upper[o.metricSnapshot],
      'VALIDATION_ERROR',
      '请输入有效的整数完成量',
      400,
    );
    if (requireTarget) {
      must(
        input.actualValue >= o.targetValueSnapshot,
        'TARGET_NOT_MET',
        '尚未达到约定目标，可以先保存草稿',
        422,
      );
    }
  }
}
async function createSubmission(
  db: Db,
  services: Services,
  actor: Actor,
  o: any,
  input: any,
  now: Date,
) {
  await services.media.assertAttachable(db, actor, {
    familyId: o.familyId,
    childId: o.childId,
    occurrenceId: o.id,
    mediaIds: input.mediaIds,
  });
  const seq = await one<any>(
    db,
    'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM completion_submissions WHERE occurrence_id=$1',
    [o.id],
  );
  const submission = await one<any>(
    db,
    `INSERT INTO completion_submissions(family_id,occurrence_id,child_id,sequence,checked,actual_value,note,submitted_by_user_id,actor_mode,child_session_source,completed_at,recorded_at,submitted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [
      o.familyId,
      o.id,
      o.childId,
      seq.sequence,
      input.checked ?? null,
      input.actualValue ?? null,
      input.note,
      actor.userId,
      actor.mode,
      actor.childSessionSource ?? null,
      input.completedAt ?? null,
      now,
    ],
  );
  await services.media.linkSubmission(db, actor, {
    familyId: o.familyId,
    childId: o.childId,
    occurrenceId: o.id,
    submissionId: submission.id,
    mediaIds: input.mediaIds,
    submittedAt: now,
  });
  await db.query('DELETE FROM completion_drafts WHERE occurrence_id=$1', [o.id]);
  return submission;
}
const completionFields = {
  checked: z.boolean().optional(),
  actualValue: z.number().int().min(0).max(1000000).optional(),
  note,
  mediaIds,
};

export async function registerActivities(app: FastifyInstance, services: Services) {
  const base = '/families/:familyId';
  app.get(`${base}/plans`, async (request) => {
    const familyId = idParam(request, 'familyId');
    await services.auth.require(request, { familyId, guardian: true });
    const q = request.query as any;
    const type = enumFilter(q.type, ['ROUTINE', 'CHALLENGE']);
    const lifecycle = enumFilter(q.lifecycle, ['DRAFT', 'PUBLISHED', 'STOPPED']);
    const childId = q.childId ? uuid.parse(q.childId) : null;
    const page = paging(q, { familyId, type, lifecycle, childId });
    const plans = await rows<any>(
      services.pool as any,
      `SELECT p.* FROM activity_plans p WHERE family_id=$1 AND ($2::text IS NULL OR type=$2) AND ($3::text IS NULL OR lifecycle=$3)
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM activity_plan_versions v JOIN plan_version_children c ON c.plan_version_id=v.id WHERE v.plan_id=p.id AND c.child_id=$4 AND v.superseded_at IS NULL))
      AND ($5::timestamptz IS NULL OR (p.created_at,p.id)<($5,$6::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT $7`,
      [
        familyId,
        type,
        lifecycle,
        childId,
        page.after?.createdAt ?? null,
        page.after?.id ?? null,
        page.limit + 1,
      ],
    );
    return ok(request, page.result(await planViews(services.pool as any, plans)));
  });
  app.post(`${base}/plans`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const input = validatePlan(planInput.parse(request.body));
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      await validateChildren(db, familyId, input.childIds);
      const plan = await one<any>(
        db,
        'INSERT INTO activity_plans(family_id,type,display_description,creator_membership_id) VALUES($1,$2,$3,$4) RETURNING *',
        [familyId, input.type, input.description, actor.membershipId],
      );
      await insertVersion(db, familyId, plan.id, 1, input);
      await audit(db, actor, 'PLAN_CREATE', {
        familyId,
        sourceId: plan.id,
        details: { type: input.type },
      });
      return (await planViews(db, [plan]))[0];
    });
  });
  app.get(`${base}/plans/:planId`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    await services.auth.require(request, { familyId, guardian: true });
    const plan = await maybe<any>(
      services.pool as any,
      'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2',
      [familyId, planId],
    );
    must(plan, 'RESOURCE_NOT_FOUND', '计划不存在', 404);
    return ok(request, (await planViews(services.pool as any, [plan]))[0]);
  });
  app.patch(`${base}/plans/:planId`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const body = z
      .object({
        ...planFields,
        ...Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])),
        expectedVersion: version,
      })
      .strict()
      .parse(request.body) as any;
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const plan = await one<any>(
        db,
        'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
        [familyId, planId],
      );
      assertVersion(plan.version, body.expectedVersion);
      must(plan.lifecycle === 'DRAFT', 'PLAN_FROZEN', '已发布计划请创建新修订');
      const v = await one<any>(
        db,
        'SELECT * FROM activity_plan_versions WHERE plan_id=$1 ORDER BY revision DESC LIMIT 1',
        [planId],
      );
      const { expectedVersion, ...patch } = body;
      const input = validatePlan(
        planInput.parse({ ...(await versionInput(db, v, plan.type)), ...patch }),
      );
      must(input.type === plan.type, 'INVALID_STATE', '计划类型不能改变');
      await validateChildren(db, familyId, input.childIds);
      await db.query('DELETE FROM plan_version_children WHERE plan_version_id=$1', [v.id]);
      await db.query('DELETE FROM activity_plan_versions WHERE id=$1', [v.id]);
      await insertVersion(db, familyId, planId, v.revision, input);
      const updated = await one<any>(
        db,
        'UPDATE activity_plans SET display_description=$3,version=version+1,updated_at=clock_timestamp() WHERE family_id=$1 AND id=$2 RETURNING *',
        [familyId, planId, input.description],
      );
      await audit(db, actor, 'PLAN_EDIT', { familyId, sourceId: planId, details: {} });
      return (await planViews(db, [updated]))[0];
    });
  });
  app.post(`${base}/plans/:planId/publish`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const body = z
      .object({ expectedVersion: version, startPolicy: z.enum(['TOMORROW', 'TODAY']).optional() })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const plan = await one<any>(
        db,
        'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
        [familyId, planId],
      );
      assertVersion(plan.version, body.expectedVersion);
      must(plan.lifecycle === 'DRAFT', 'INVALID_STATE', '计划已发布');
      const v = await one<any>(
        db,
        'SELECT * FROM activity_plan_versions WHERE plan_id=$1 ORDER BY revision DESC LIMIT 1',
        [planId],
      );
      const input = validatePlan(await versionInput(db, v, plan.type));
      await validateChildren(db, familyId, input.childIds);
      const now = await serverNow(db);
      if (plan.type === 'CHALLENGE') {
        must(!body.startPolicy, 'VALIDATION_ERROR', '挑战不接受日常生效选项', 400);
        must(new Date(input.endsAt!) > now, 'WINDOW_CLOSED', '挑战已经结束');
      }
      const effective =
        plan.type === 'ROUTINE' && body.startPolicy !== 'TODAY' ? dayEnd(today(now)) : now;
      await db.query(
        'UPDATE activity_plan_versions SET published_at=$2,effective_from=$3 WHERE id=$1',
        [v.id, now, effective],
      );
      await db.query('UPDATE plan_version_children SET assigned_at=$2 WHERE plan_version_id=$1', [
        v.id,
        now,
      ]);
      const updated = await one<any>(
        db,
        "UPDATE activity_plans SET lifecycle='PUBLISHED',version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [planId],
      );
      await materialize(db, { familyId, from: today(now), to: today(now), planId });
      await audit(db, actor, 'PLAN_PUBLISH', {
        familyId,
        sourceId: planId,
        details: { effectiveFrom: effective.toISOString() },
      });
      return (await planViews(db, [updated]))[0];
    });
  });
  for (const action of ['revisions', 'pause', 'resume'] as const) {
    app.post(`${base}/plans/:planId/${action}`, async (request) => {
      const familyId = idParam(request, 'familyId');
      const planId = idParam(request, 'planId');
      const body =
        action === 'revisions'
          ? z
              .object({ ...planFields, expectedVersion: version })
              .strict()
              .parse(request.body)
          : z.object({ expectedVersion: version }).strict().parse(request.body);
      return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
        const plan = await one<any>(
          db,
          'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
          [familyId, planId],
        );
        assertVersion(plan.version, body.expectedVersion);
        must(
          plan.type === 'ROUTINE' && plan.lifecycle === 'PUBLISHED',
          'PLAN_FROZEN',
          '仅已发布日常可修改或暂停恢复',
        );
        const latest = await one<any>(
          db,
          'SELECT * FROM activity_plan_versions WHERE plan_id=$1 AND superseded_at IS NULL ORDER BY revision DESC LIMIT 1',
          [planId],
        );
        const input = validatePlan(
          action === 'revisions'
            ? planInput.parse(
                Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'expectedVersion')),
              )
            : await versionInput(db, latest, 'ROUTINE'),
        );
        must(input.type === 'ROUTINE', 'PLAN_FROZEN', '日常类型不能改变');
        await validateChildren(db, familyId, input.childIds);
        const now = await serverNow(db);
        const effective = dayEnd(today(now));
        await db.query(
          'UPDATE activity_plan_versions SET superseded_at=$3 WHERE plan_id=$1 AND effective_from>=$2 AND superseded_at IS NULL',
          [planId, effective, now],
        );
        await db.query(
          'UPDATE activity_plan_versions SET effective_to=$2 WHERE plan_id=$1 AND published_at IS NOT NULL AND superseded_at IS NULL AND effective_from<$2 AND (effective_to IS NULL OR effective_to>$2)',
          [planId, effective],
        );
        const max = await one<any>(
          db,
          'SELECT MAX(revision)+1 AS revision FROM activity_plan_versions WHERE plan_id=$1',
          [planId],
        );
        await insertVersion(db, familyId, planId, max.revision, input, {
          effectiveFrom: effective,
          publishedAt: now,
          active: action === 'pause' ? false : action === 'resume' ? true : latest.active,
        });
        const updated = await one<any>(
          db,
          'UPDATE activity_plans SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [planId],
        );
        await audit(db, actor, `PLAN_${action.toUpperCase()}`, {
          familyId,
          sourceId: planId,
          details: { effectiveFrom: effective.toISOString() },
        });
        return (await planViews(db, [updated]))[0];
      });
    });
  }
  app.patch(`${base}/plans/:planId/display-description`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const body = z
      .object({ description: z.string().trim().max(500), expectedVersion: version })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const p = await one<any>(
        db,
        'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
        [familyId, planId],
      );
      assertVersion(p.version, body.expectedVersion);
      must(
        p.type === 'CHALLENGE' && p.lifecycle !== 'DRAFT',
        'INVALID_STATE',
        '此接口仅修改已发布挑战说明',
      );
      const updated = await one(
        db,
        'UPDATE activity_plans SET display_description=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [planId, body.description],
      );
      await audit(db, actor, 'PLAN_DESCRIPTION', { familyId, sourceId: planId, details: {} });
      return updated;
    });
  });
  app.post(`${base}/plans/:planId/stop`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const body = z.object({ reason, expectedVersion: version }).strict().parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const p = await one<any>(
        db,
        'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
        [familyId, planId],
      );
      assertVersion(p.version, body.expectedVersion);
      must(
        p.type === 'CHALLENGE' && p.lifecycle === 'PUBLISHED',
        'INVALID_STATE',
        '只有进行中的挑战可停止',
      );
      const result = await one(
        db,
        "UPDATE activity_plans SET lifecycle='STOPPED',stopped_at=clock_timestamp(),stop_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [planId, body.reason],
      );
      await audit(db, actor, 'CHALLENGE_STOP', {
        familyId,
        sourceId: planId,
        details: { reason: body.reason },
      });
      return result;
    });
  });
  app.post(`${base}/plans/:planId/copy`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const body = z
      .object({ newTitle: z.string().trim().min(2).max(40), expectedVersion: version })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const p = await one<any>(
        db,
        'SELECT * FROM activity_plans WHERE family_id=$1 AND id=$2 FOR UPDATE',
        [familyId, planId],
      );
      assertVersion(p.version, body.expectedVersion);
      const v = await one<any>(
        db,
        'SELECT * FROM activity_plan_versions WHERE plan_id=$1 AND superseded_at IS NULL ORDER BY revision DESC LIMIT 1',
        [planId],
      );
      const input = { ...(await versionInput(db, v, p.type)), title: body.newTitle };
      const fresh = await one<any>(
        db,
        'INSERT INTO activity_plans(family_id,type,display_description,creator_membership_id) VALUES($1,$2,$3,$4) RETURNING *',
        [familyId, p.type, input.description, actor.membershipId],
      );
      await insertVersion(db, familyId, fresh.id, 1, input);
      await audit(db, actor, 'PLAN_COPY', {
        familyId,
        sourceId: fresh.id,
        details: { copiedFrom: planId },
      });
      return (await planViews(db, [fresh]))[0];
    });
  });
  app.get(`${base}/plans/:planId/versions`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    await services.auth.require(request, { familyId, guardian: true });
    const page = paging(request.query, { familyId, planId });
    const result = await rows<any>(
      services.pool as any,
      `SELECT v.*,COALESCE(array_agg(c.child_id) FILTER(WHERE c.child_id IS NOT NULL),'{}') child_ids FROM activity_plan_versions v LEFT JOIN plan_version_children c ON c.plan_version_id=v.id
      WHERE v.family_id=$1 AND v.plan_id=$2 AND ($3::timestamptz IS NULL OR (v.created_at,v.id)<($3,$4::uuid)) GROUP BY v.id ORDER BY v.created_at DESC,v.id DESC LIMIT $5`,
      [familyId, planId, page.after?.createdAt ?? null, page.after?.id ?? null, page.limit + 1],
    );
    return ok(request, page.result(result));
  });
  app.get(`${base}/plans/:planId/schedule-preview`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    await services.auth.require(request, { familyId, guardian: true });
    const q = request.query as any;
    const { from, to } = range(q, 90);
    const childId = q.childId ? uuid.parse(q.childId) : null;
    const preview = await rows<any>(
      services.pool as any,
      `SELECT DISTINCT ON(c.id,d::date) c.id child_id,c.nickname,d::date business_date,v.id plan_version_id,v.title,v.metric,v.target_value,v.award_points,v.active,
      GREATEST(d::timestamp AT TIME ZONE 'Asia/Shanghai',v.effective_from,pc.assigned_at,c.created_at) starts_at,(d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' ends_at
      FROM activity_plans p JOIN activity_plan_versions v ON v.plan_id=p.id JOIN plan_version_children pc ON pc.plan_version_id=v.id JOIN child_profiles c ON c.id=pc.child_id
      CROSS JOIN generate_series($3::date,$4::date,'1 day') d WHERE p.family_id=$1 AND p.id=$2 AND p.type='ROUTINE' AND v.published_at IS NOT NULL AND v.superseded_at IS NULL AND v.active
      AND ($5::uuid IS NULL OR c.id=$5) AND EXTRACT(ISODOW FROM d)::smallint=ANY(v.weekdays)
      AND v.effective_from<((d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND (v.effective_to IS NULL OR v.effective_to>(d::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND c.created_at<((d::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND (c.archived_at IS NULL OR c.archived_at>(d::timestamp AT TIME ZONE 'Asia/Shanghai'))
      ORDER BY c.id,d::date,v.revision DESC`,
      [familyId, planId, from, to, childId],
    );
    return ok(request, { items: preview, preview: true, dateFrom: from, dateTo: to });
  });
  app.get(`${base}/plans/:planId/occurrences`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const planId = idParam(request, 'planId');
    const actor = await services.auth.require(request, { familyId, guardian: true });
    const q = request.query as any;
    const { from, to } = range(q);
    const childId = q.childId ? uuid.parse(q.childId) : null;
    const status = enumFilter(q.status, occurrenceStatuses);
    const page = paging(q, { familyId, planId, childId, status, from, to });
    await materialize(services.pool as any, {
      familyId,
      from,
      to,
      planId,
      childId: childId ?? undefined,
    });
    const filters = `o.family_id=$1 AND o.plan_id=$2 AND ($3::uuid IS NULL OR o.child_id=$3) AND ($4::text IS NULL OR o.status=$4) AND (o.type='CHALLENGE' OR o.business_date BETWEEN $5::date AND $6::date)`;
    const result = await rows<any>(
      services.pool as any,
      `SELECT o.*,p.stopped_at,c.nickname AS child_nickname FROM activity_occurrences o JOIN activity_plans p ON p.id=o.plan_id JOIN child_profiles c ON c.id=o.child_id WHERE ${filters} AND ($7::timestamptz IS NULL OR (o.created_at,o.id)<($7,$8::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $9`,
      [
        familyId,
        planId,
        childId,
        status,
        from,
        to,
        page.after?.createdAt ?? null,
        page.after?.id ?? null,
        page.limit + 1,
      ],
    );
    const counts = await rows(
      services.pool as any,
      `SELECT status,COUNT(*)::int AS count FROM activity_occurrences o WHERE ${filters} GROUP BY status`,
      [familyId, planId, childId, status, from, to],
    );
    return ok(request, { ...page.result(result.map((o) => occurrenceView(o, actor))), counts });
  });
  app.get(`${base}/occurrences/:occurrenceId`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const actor = await services.auth.require(request, { familyId });
    return ok(request, await occurrenceDetail(services.pool as any, familyId, occurrenceId, actor));
  });
  app.put(`${base}/occurrences/:occurrenceId/draft`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const body = z
      .object({
        ...completionFields,
        expectedOccurrenceVersion: version,
        expectedDraftVersion: z.number().int().nonnegative().safe(),
      })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId }, async (db, actor) => {
      const o = await lockOccurrence(db, actor, familyId, occurrenceId);
      assertVersion(o.version, body.expectedOccurrenceVersion);
      must(['OPEN', 'NEEDS_CHANGES'].includes(o.status), 'INVALID_STATE', '此记录不能再保存草稿');
      validateValue(o, body, false);
      await services.media.assertAttachable(db, actor, {
        familyId,
        childId: o.childId,
        occurrenceId,
        mediaIds: body.mediaIds,
      });
      const old = await maybe<any>(
        db,
        'SELECT * FROM completion_drafts WHERE occurrence_id=$1 FOR UPDATE',
        [occurrenceId],
      );
      assertVersion(old?.version ?? 0, body.expectedDraftVersion);
      const draft = await one<any>(
        db,
        `INSERT INTO completion_drafts(family_id,occurrence_id,child_id,checked,actual_value,note,media_ids) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(occurrence_id) DO UPDATE SET checked=EXCLUDED.checked,actual_value=EXCLUDED.actual_value,note=EXCLUDED.note,media_ids=EXCLUDED.media_ids,version=completion_drafts.version+1,updated_at=clock_timestamp() RETURNING *`,
        [
          familyId,
          occurrenceId,
          o.childId,
          body.checked ?? null,
          body.actualValue ?? null,
          body.note,
          body.mediaIds,
        ],
      );
      return { draft, occurrenceVersion: o.version };
    });
  });
  app.post(`${base}/occurrences/:occurrenceId/submissions`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const body = z
      .object({ ...completionFields, expectedVersion: version })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId }, async (db, actor) => {
      const o = await lockOccurrence(db, actor, familyId, occurrenceId);
      assertVersion(o.version, body.expectedVersion);
      must(['OPEN', 'NEEDS_CHANGES'].includes(o.status), 'INVALID_STATE', '该记录不能重复提交');
      const now = await serverNow(db);
      if (o.status === 'OPEN') {
        must(
          !o.stoppedAt && now >= new Date(o.startsAt) && now < new Date(o.endsAt),
          'WINDOW_CLOSED',
          '活动未开始、已结束或已停止',
        );
      } else {
        must(
          o.supplementUntil && now < new Date(o.supplementUntil),
          'WINDOW_CLOSED',
          '补充期限已结束',
        );
      }
      validateValue(o, body, true);
      const submission = await createSubmission(db, services, actor, o, body, now);
      const updated = await one<any>(
        db,
        "UPDATE activity_occurrences SET status='SUBMITTED',latest_submission_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [o.id, submission.id],
      );
      await audit(db, actor, 'COMPLETION_SUBMIT', {
        familyId,
        childId: o.childId,
        sourceId: o.id,
        details: { submissionId: submission.id },
      });
      return { occurrence: occurrenceView(updated, actor), submission };
    });
  });
  app.post(`${base}/occurrences/:occurrenceId/review`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const body = z
      .object({
        decision: z.enum(['APPROVE', 'RETURN']),
        reason: reason.optional(),
        expectedVersion: version,
      })
      .strict()
      .parse(request.body);
    if (body.decision === 'RETURN') {
      must(body.reason, 'VALIDATION_ERROR', '请填写退回原因', 400);
    }
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const o = await lockOccurrence(db, actor, familyId, occurrenceId);
      assertVersion(o.version, body.expectedVersion);
      must(o.status === 'SUBMITTED', 'INVALID_STATE', '记录已被处理，请刷新');
      const now = await serverNow(db);
      if (body.decision === 'RETURN') {
        const until = new Date(Math.max(Date.parse(o.endsAt), now.getTime() + 24 * HOUR));
        await db.query(
          "INSERT INTO completion_decisions(family_id,occurrence_id,submission_id,action,reason,operator_membership_id,supplement_until) VALUES($1,$2,$3,'RETURN',$4,$5,$6)",
          [familyId, o.id, o.latestSubmissionId, body.reason, actor.membershipId, until],
        );
        const updated = await one<any>(
          db,
          "UPDATE activity_occurrences SET status='NEEDS_CHANGES',supplement_until=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [o.id, until],
        );
        await audit(db, actor, 'COMPLETION_RETURN', {
          familyId,
          childId: o.childId,
          sourceId: o.id,
          details: { reason: body.reason, supplementUntil: until.toISOString() },
        });
        return { occurrence: occurrenceView(updated, actor) };
      }
      const awarded = await movePoints(db, actor, {
        familyId,
        childId: o.childId,
        type: 'ACTIVITY_AWARD',
        points: o.awardPointsSnapshot,
        sourceType: 'OCCURRENCE',
        sourceId: o.id,
        reason: `完成：${o.titleSnapshot}`,
      });
      await db.query(
        "INSERT INTO completion_decisions(family_id,occurrence_id,submission_id,action,operator_membership_id) VALUES($1,$2,$3,'APPROVE',$4)",
        [familyId, o.id, o.latestSubmissionId, actor.membershipId],
      );
      const updated = await one<any>(
        db,
        "UPDATE activity_occurrences SET status='APPROVED',award_ledger_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [o.id, awarded.ledgerEntry.id],
      );
      await audit(db, actor, 'COMPLETION_APPROVE', {
        familyId,
        childId: o.childId,
        sourceId: o.id,
        details: { points: o.awardPointsSnapshot },
      });
      return { occurrence: occurrenceView(updated, actor), ...awarded };
    });
  });
  app.post(`${base}/occurrences/:occurrenceId/direct-completion`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const body = z
      .object({ ...completionFields, completedAt: instant, expectedVersion: version })
      .strict()
      .parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const o = await lockOccurrence(db, actor, familyId, occurrenceId);
      assertVersion(o.version, body.expectedVersion);
      must(
        ['OPEN', 'NEEDS_CHANGES'].includes(o.status),
        'INVALID_STATE',
        '只能为未提交或需补充的记录直接记录完成',
      );
      const now = await serverNow(db);
      const completed = new Date(body.completedAt);
      must(
        completed >= new Date(o.startsAt) && completed < new Date(o.endsAt) && completed <= now,
        'VALIDATION_ERROR',
        '实际完成时间须在原活动窗口内且不晚于现在',
        400,
      );
      if (o.stoppedAt) {
        must(completed < new Date(o.stoppedAt), 'WINDOW_CLOSED', '仅可补记挑战停止前的真实完成');
      }
      if (o.type === 'ROUTINE') {
        must(
          o.businessDate >= addDays(today(now), -7) && o.businessDate <= today(now),
          'BACKFILL_WINDOW_CLOSED',
          '仅可补记今天及过去7个日期',
        );
      } else {
        must(
          now.getTime() < Date.parse(o.endsAt) + 7 * DAY,
          'BACKFILL_WINDOW_CLOSED',
          '挑战补记期限已结束',
        );
      }
      validateValue(o, body, true);
      const submission = await createSubmission(db, services, actor, o, body, now);
      const awarded = await movePoints(db, actor, {
        familyId,
        childId: o.childId,
        type: 'ACTIVITY_AWARD',
        points: o.awardPointsSnapshot,
        sourceType: 'OCCURRENCE',
        sourceId: o.id,
        reason: `家长记录完成：${o.titleSnapshot}`,
      });
      await db.query(
        "INSERT INTO completion_decisions(family_id,occurrence_id,submission_id,action,operator_membership_id,actual_value) VALUES($1,$2,$3,'DIRECT_COMPLETE',$4,$5)",
        [familyId, o.id, submission.id, actor.membershipId, body.actualValue ?? null],
      );
      const updated = await one<any>(
        db,
        "UPDATE activity_occurrences SET status='APPROVED',latest_submission_id=$2,award_ledger_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [o.id, submission.id, awarded.ledgerEntry.id],
      );
      await audit(db, actor, 'DIRECT_COMPLETE', {
        familyId,
        childId: o.childId,
        sourceId: o.id,
        details: { completedAt: body.completedAt, afterStop: !!o.stoppedAt },
      });
      return { occurrence: occurrenceView(updated, actor), submission, ...awarded };
    });
  });
  app.post(`${base}/occurrences/:occurrenceId/exemption`, async (request) => {
    const familyId = idParam(request, 'familyId');
    const occurrenceId = idParam(request, 'occurrenceId');
    const body = z.object({ reason, expectedVersion: version }).strict().parse(request.body);
    return services.mutate(request, { familyId, guardian: true }, async (db, actor) => {
      const o = await lockOccurrence(db, actor, familyId, occurrenceId);
      assertVersion(o.version, body.expectedVersion);
      must(
        ['OPEN', 'SUBMITTED', 'NEEDS_CHANGES'].includes(o.status),
        'INVALID_STATE',
        '已通过或已终止的记录不能免做',
      );
      const updated = await one<any>(
        db,
        "UPDATE activity_occurrences SET status='EXEMPTED',version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [o.id],
      );
      await db.query(
        "INSERT INTO completion_decisions(family_id,occurrence_id,submission_id,action,reason,operator_membership_id) VALUES($1,$2,$3,'EXEMPT',$4,$5)",
        [familyId, o.id, o.latestSubmissionId, body.reason, actor.membershipId],
      );
      await db.query('DELETE FROM completion_drafts WHERE occurrence_id=$1', [o.id]);
      await audit(db, actor, 'COMPLETION_EXEMPT', {
        familyId,
        childId: o.childId,
        sourceId: o.id,
        details: { reason: body.reason },
      });
      return occurrenceView(updated, actor);
    });
  });
}
