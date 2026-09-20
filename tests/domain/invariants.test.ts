import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import { migrate } from '../../apps/api/src/migrate.js';
import { loadConfig } from '../../apps/api/src/common/config.js';
import * as common from '../../apps/api/src/common/index.js';
import { createAuth } from '../../apps/api/src/identity/index.js';
import { createMedia } from '../../apps/api/src/media/index.js';
import * as domain from '../../apps/api/src/domain/index.js';
import { movePoints } from '../../apps/api/src/domain/points.js';
import { planViews } from '../../apps/api/src/domain/activities.js';
import { today, addDays, dayStart, DAY } from '../../apps/api/src/domain/support.js';

const databaseUrl =
  process.env.DOMAIN_TEST_DATABASE_URL || 'postgresql://localhost/pointjoy_domain_test';
if (new URL(databaseUrl).pathname !== '/pointjoy_domain_test') {
  throw new Error('Domain tests may reset only the dedicated pointjoy_domain_test database');
}

test('PostgreSQL domain concurrency, historical windows and reconciliation', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  const services: any = {
    pool,
    config: loadConfig({ ...process.env, APP_ENV: 'test', DATABASE_URL: databaseUrl }),
  };
  services.auth = createAuth(services);
  services.media = createMedia(services);
  services.mutate = common.createMutationRunner(services);
  services.domain = domain.createDomain(services);
  const app = Fastify({ logger: false });
  app.setErrorHandler((e: any, _req, reply) =>
    reply
      .code(e.status || e.statusCode || (e.name === 'ZodError' ? 400 : 500))
      .send({ error: { code: e.code ?? e.name, message: e.message, details: e.details } }),
  );
  app.addHook('preSerialization', async (_req, reply, p: any) => {
    if (p?.[common.responseStatus]) {
      reply.code(p[common.responseStatus]);
    }
    return p;
  });
  await app.register(async (a) => domain.registerDomain(a, services), { prefix: '/api/v1' });
  await app.ready();
  t.after(async () => {
    await app.close();
    await pool.end();
  });

  let familyId = '';
  let childId = '';
  let parent: any;
  let other: any;
  let kid: any;
  let parentUserId = '';
  let membershipId = '';
  async function seedChild(
    db: common.Db,
    name: string,
    boundUserId?: string,
    createdAt = new Date(),
  ) {
    const avatar = await common.one(
      db,
      "INSERT INTO media_assets(uploader_user_id,family_id,purpose,status,object_key,mime,width,height) VALUES($1,$2,'CHILD_AVATAR','READY',$3,'image/jpeg',512,512) RETURNING *",
      [parentUserId, familyId, 'domain-fixture-' + randomUUID()],
    );
    const child = await common.one(
      db,
      'INSERT INTO child_profiles(family_id,nickname,avatar_media_id,bound_user_id,created_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [familyId, name, avatar.id, boundUserId ?? null, createdAt],
    );
    await domain.ensureChildAccount(db, { familyId, childId: child.id });
    return child;
  }
  // Fixtures bypass WeChat network only. Requests use the real session service,
  // family rechecks, SQL locks, idempotency runner and domain HTTP routes.
  await common.transaction(pool, async (db) => {
    async function user(name: string) {
      const u = await common.one(db, 'INSERT INTO users(display_name) VALUES($1) RETURNING *', [
        name,
      ]);
      const avatar = await common.one(
        db,
        "INSERT INTO media_assets(uploader_user_id,purpose,status,object_key,mime,width,height) VALUES($1,'USER_AVATAR','READY',$2,'image/jpeg',512,512) RETURNING *",
        [u.id, 'domain-avatar-' + randomUUID()],
      );
      return common.one(
        db,
        'UPDATE users SET avatar_media_id=$2,profile_completed_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [u.id, avatar.id],
      );
    }
    const p = await user('家长甲');
    const g = await user('家长乙');
    const c = await user('小禾');
    parentUserId = p.id;
    familyId = randomUUID();
    membershipId = randomUUID();
    await db.query('INSERT INTO families(id,name,owner_membership_id) VALUES($1,$2,$3)', [
      familyId,
      '领域测试家庭',
      membershipId,
    ]);
    await db.query('INSERT INTO guardian_memberships(id,family_id,user_id) VALUES($1,$2,$3)', [
      membershipId,
      familyId,
      p.id,
    ]);
    const m = await common.one(
      db,
      'INSERT INTO guardian_memberships(family_id,user_id) VALUES($1,$2) RETURNING *',
      [familyId, g.id],
    );
    const child = await seedChild(db, '小禾', c.id);
    childId = child.id;
    parent = await services.auth.issue(db, p, 'GUARDIAN', { familyId, membershipId });
    other = await services.auth.issue(db, g, 'GUARDIAN', { familyId, membershipId: m.id });
    kid = await services.auth.issue(db, c, 'CHILD', {
      familyId,
      childId,
      bindingVersion: 1,
      childSessionSource: 'DIRECT',
    });
  });
  const base = `/api/v1/families/${familyId}`;
  async function raw(
    method: any,
    path: string,
    body: any = undefined,
    who = parent,
    key = randomUUID(),
  ) {
    return app.inject({
      method,
      url: path.startsWith('/api/') ? path : base + path,
      headers: { authorization: 'Bearer ' + who.accessToken, 'idempotency-key': key },
      ...(body !== undefined ? { payload: body } : {}),
    });
  }
  async function request(
    method: any,
    path: string,
    body: any = undefined,
    who = parent,
    key = randomUUID(),
    expected = 200,
  ) {
    const r = await raw(method, path, body, who, key);
    let json: any;
    try {
      json = r.json();
    } catch {
      json = { raw: r.body };
    }
    assert.equal(r.statusCode, expected, `${method} ${path}: ${JSON.stringify(json)}`);
    return json.data ?? json;
  }
  const account = () => request('GET', `/children/${childId}/account`);
  async function newReward(costPoints: number, extra: any = {}) {
    const reward = await request('POST', '/rewards', {
      name: '约定奖励',
      category: 'ITEM',
      benefitDescription: '一份约定奖励',
      artKey: 'gift',
      costPoints,
      stockMode: 'UNLIMITED',
      childIds: [childId],
      ...extra,
    });
    return request('POST', `/rewards/${reward.id}/status`, {
      status: 'ACTIVE',
      expectedVersion: reward.version,
    });
  }
  async function newOrder(reward: any) {
    return request(
      'POST',
      `/children/${childId}/orders`,
      {
        rewardId: reward.id,
        expectedRewardVersion: reward.version,
        expectedCostPoints: reward.costPoints,
      },
      kid,
    );
  }
  let plan: any;
  let occurrence: any;
  let reward: any;
  let unlimited: any;
  let award: any;

  await t.test(
    'two reviewers award once; draft is independent and below target is rejected',
    async () => {
      plan = await request('POST', '/plans', {
        type: 'ROUTINE',
        title: '跳绳练习',
        metric: 'COUNT',
        targetValue: 10,
        unit: 'REP',
        awardPoints: 20,
        childIds: [childId],
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      });
      plan = await request('POST', `/plans/${plan.id}/publish`, {
        startPolicy: 'TODAY',
        expectedVersion: plan.version,
      });
      occurrence = (await request('GET', `/children/${childId}/today`, undefined, kid)).routines[0];
      const draft = await request(
        'PUT',
        `/occurrences/${occurrence.id}/draft`,
        {
          actualValue: 5,
          note: '练习中',
          mediaIds: [],
          expectedOccurrenceVersion: 1,
          expectedDraftVersion: 0,
        },
        kid,
      );
      assert.equal(draft.occurrenceVersion, 1);
      assert.equal(draft.draft.version, 1);
      await request(
        'POST',
        `/occurrences/${occurrence.id}/submissions`,
        { actualValue: 5, mediaIds: [], expectedVersion: 1 },
        kid,
        randomUUID(),
        422,
      );
      const submitted = await request(
        'POST',
        `/occurrences/${occurrence.id}/submissions`,
        { actualValue: 10, note: '完成', mediaIds: [], expectedVersion: 1 },
        kid,
      );
      const approvals = await Promise.all(
        [parent, other].map((w) =>
          raw(
            'POST',
            `/occurrences/${occurrence.id}/review`,
            { decision: 'APPROVE', expectedVersion: submitted.occurrence.version },
            w,
          ),
        ),
      );
      assert.deepEqual(approvals.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal((await account()).availablePoints, 20);
      assert.equal((await account()).version, 1);
      assert.equal(
        (
          await common.one(
            pool,
            "SELECT COUNT(*)::int n FROM point_ledger WHERE source_id=$1 AND type='ACTIVITY_AWARD'",
            [occurrence.id],
          )
        ).n,
        1,
      );
    },
  );
  await t.test(
    'operation replay cannot duplicate a grant or reuse its key for another body',
    async () => {
      const key = randomUUID();
      const body = { points: 200, reason: '认真坚持' };
      await request('POST', `/children/${childId}/praises`, body, parent, key);
      await request('POST', `/children/${childId}/praises`, body, parent, key);
      const mismatch = await request(
        'POST',
        `/children/${childId}/praises`,
        { points: 201, reason: '认真坚持' },
        parent,
        key,
        409,
      );
      assert.equal(mismatch.error.code, 'IDEMPOTENCY_MISMATCH');
      assert.equal((await account()).availablePoints, 220);
    },
  );
  await t.test(
    'concurrent requests reserve the last stock and weekly quota only once',
    async () => {
      reward = await newReward(40, {
        name: '冰淇淋一份',
        category: 'FOOD',
        artKey: 'icecream',
        stockMode: 'FINITE',
        initialStock: 1,
        weeklyLimit: 1,
      });
      const body = {
        rewardId: reward.id,
        expectedRewardVersion: reward.version,
        expectedCostPoints: 40,
      };
      const requests = await Promise.all(
        [1, 2].map(() => raw('POST', `/children/${childId}/orders`, body, kid)),
      );
      assert.deepEqual(requests.map((r) => r.statusCode).sort(), [200, 409]);
      const order = requests.find((r) => r.statusCode === 200)!.json().data.order;
      assert.equal((await account()).availablePoints, 180);
      assert.equal((await account()).heldPoints, 40);
      const ready = await request('POST', `/orders/${order.id}/approve`, {
        expectedVersion: order.version,
      });
      assert.equal(ready.account.heldPoints, 0);
      reward = await request('PATCH', `/rewards/${reward.id}`, {
        costPoints: 80,
        expectedVersion: reward.version,
      });
      const canceled = await request(
        'POST',
        `/orders/${order.id}/cancel`,
        { reasonCode: 'CHANGED_MIND', expectedVersion: ready.order.version },
        kid,
      );
      assert.equal(canceled.account.availablePoints, 220);
      assert.equal((await request('GET', `/rewards/${reward.id}`)).stockAvailable, 1);
    },
  );
  await t.test(
    'fulfilled order cannot refund, and approval at expiry commits a release',
    async () => {
      const fresh = await newOrder(reward);
      const ready = await request('POST', `/orders/${fresh.order.id}/approve`, {
        expectedVersion: 1,
      });
      const fulfilled = await request('POST', `/orders/${fresh.order.id}/fulfill`, {
        expectedVersion: ready.order.version,
        note: '已经提供',
      });
      assert.equal(fulfilled.status, 'FULFILLED');
      await request(
        'POST',
        `/orders/${fresh.order.id}/cancel`,
        { expectedVersion: fulfilled.version, reasonCode: 'OTHER' },
        kid,
        randomUUID(),
        409,
      );
      unlimited = await newReward(30, {
        name: '游戏时间',
        category: 'TIME',
        timeMinutes: 20,
        artKey: 'game',
      });
      const exp = await newOrder(unlimited);
      await pool.query(
        "UPDATE redemption_orders SET approval_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
        [exp.order.id],
      );
      const expired = await request(
        'POST',
        `/orders/${exp.order.id}/approve`,
        { expectedVersion: 1 },
        parent,
        randomUUID(),
        409,
      );
      assert.equal(expired.order.status, 'EXPIRED');
      assert.equal(expired.account.availablePoints, 140);
    },
  );
  await t.test(
    'reversal preserves immutable ledger and updates the original occurrence',
    async () => {
      award = (await request('GET', `/children/${childId}/ledger`)).items.find(
        (x: any) => x.type === 'ACTIVITY_AWARD',
      );
      await request('POST', `/ledger/${award.id}/reversal`, {
        reason: '纠正错误记录',
        expectedAccountVersion: (await account()).version,
      });
      assert.equal(
        (await request('GET', `/occurrences/${occurrence.id}`, undefined, kid)).status,
        'REVOKED',
      );
      assert.equal((await account()).availablePoints, 120);
      await assert.rejects(
        pool.query("UPDATE point_ledger SET reason='malicious edit' WHERE id=$1", [award.id]),
        (e) => (e as any).code === '42501',
      );
    },
  );
  await t.test(
    'routine revision, pause and resume affect tomorrow; previews never create future instances',
    async () => {
      plan = await request('POST', `/plans/${plan.id}/revisions`, {
        type: 'ROUTINE',
        title: '跳绳新目标',
        metric: 'COUNT',
        targetValue: 20,
        unit: 'REP',
        awardPoints: 30,
        childIds: [childId],
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        expectedVersion: plan.version,
      });
      assert.equal(plan.currentVersion.awardPoints, 20);
      assert.equal(plan.scheduledVersion.awardPoints, 30);
      const tomorrow = addDays(today(), 1);
      assert.equal(plan.scheduledVersion.effectiveFrom, dayStart(tomorrow).toISOString());
      plan = await request('POST', `/plans/${plan.id}/pause`, { expectedVersion: plan.version });
      assert.equal(plan.currentVersion.active, true);
      assert.equal(plan.scheduledVersion.active, false);
      assert.equal(
        (
          await request(
            'GET',
            `/plans/${plan.id}/schedule-preview?dateFrom=${tomorrow}&dateTo=${tomorrow}`,
          )
        ).items.length,
        0,
      );
      plan = await request('POST', `/plans/${plan.id}/resume`, { expectedVersion: plan.version });
      assert.equal(plan.scheduledVersion.active, true);
      const preview = await request(
        'GET',
        `/plans/${plan.id}/schedule-preview?dateFrom=${tomorrow}&dateTo=${tomorrow}`,
      );
      assert.equal(preview.items[0].awardPoints, 30);
      assert.equal(
        (
          await common.one(
            pool,
            'SELECT COUNT(*)::int n FROM activity_occurrences WHERE plan_id=$1 AND business_date>$2',
            [plan.id, today()],
          )
        ).n,
        0,
      );
      const current = (await request('GET', `/children/${childId}/today`, undefined, kid))
        .routines[0];
      assert.equal(current.snapshot.awardPoints, 20);
      assert.equal(current.status, 'REVOKED');
      assert.equal((await domain.reconcile(services)).status, 'PASS');
    },
  );

  let historicalChild: any;
  await t.test(
    'unopened history uses version and assignment dates; day seven is inclusive',
    async () => {
      const oldDate = addDays(today(), -20);
      const old = dayStart(oldDate);
      historicalChild = await common.transaction(pool, (db) =>
        seedChild(db, '历史孩子', undefined, old),
      );
      // Build an actually old publication without advancing the machine clock.
      const historicalPlan = await common.transaction(pool, async (db) => {
        const p = await common.one(
          db,
          "INSERT INTO activity_plans(family_id,type,lifecycle,creator_membership_id,created_at) VALUES($1,'ROUTINE','PUBLISHED',$2,$3) RETURNING *",
          [familyId, membershipId, old],
        );
        const v = await common.one(
          db,
          "INSERT INTO activity_plan_versions(family_id,plan_id,revision,title,metric,award_points,weekdays,effective_from,published_at,created_at) VALUES($1,$2,1,'每日整理','CHECK',10,ARRAY[1,2,3,4,5,6,7]::smallint[],$3,$3,$3) RETURNING *",
          [familyId, p.id, old],
        );
        await db.query(
          'INSERT INTO plan_version_children(family_id,plan_version_id,child_id,assigned_at) VALUES($1,$2,$3,$4)',
          [familyId, v.id, historicalChild.id, dayStart(addDays(today(), -10))],
        );
        return p;
      });
      assert.equal(
        (
          await common.one(
            pool,
            'SELECT COUNT(*)::int n FROM activity_occurrences WHERE plan_id=$1',
            [historicalPlan.id],
          )
        ).n,
        0,
      );
      const history = await request(
        'GET',
        `/plans/${historicalPlan.id}/occurrences?dateFrom=${oldDate}&dateTo=${today()}&limit=100`,
      );
      assert.equal(history.items.length, 11);
      assert.ok(history.items.every((o: any) => o.businessDate >= addDays(today(), -10)));
      const seven = history.items.find((o: any) => o.businessDate === addDays(today(), -7));
      const eight = history.items.find((o: any) => o.businessDate === addDays(today(), -8));
      const accepted = await request('POST', `/occurrences/${seven.id}/direct-completion`, {
        checked: true,
        completedAt: new Date(Date.parse(seven.startsAt) + 1000).toISOString(),
        expectedVersion: 1,
      });
      assert.equal(accepted.occurrence.status, 'APPROVED');
      const rejected = await request(
        'POST',
        `/occurrences/${eight.id}/direct-completion`,
        {
          checked: true,
          completedAt: new Date(Date.parse(eight.startsAt) + 1000).toISOString(),
          expectedVersion: 1,
        },
        parent,
        randomUUID(),
        409,
      );
      assert.equal(rejected.error.code, 'BACKFILL_WINDOW_CLOSED');
      const count = (
        await common.one(
          pool,
          'SELECT COUNT(*)::int n FROM activity_occurrences WHERE plan_id=$1',
          [historicalPlan.id],
        )
      ).n;
      await domain.materialize(pool as any, {
        familyId,
        planId: historicalPlan.id,
        from: oldDate,
        to: today(),
      });
      assert.equal(
        (
          await common.one(
            pool,
            'SELECT COUNT(*)::int n FROM activity_occurrences WHERE plan_id=$1',
            [historicalPlan.id],
          )
        ).n,
        count,
      );
    },
  );
  await t.test(
    'archive boundary preserves historical instances even when child is currently archived',
    async () => {
      const old = dayStart(addDays(today(), -20));
      const archivedAt = dayStart(addDays(today(), -3));
      const archived = await common.transaction(pool, (db) =>
        seedChild(db, '已归档孩子', undefined, old),
      );
      const p = await common.transaction(pool, async (db) => {
        const plan = await common.one(
          db,
          "INSERT INTO activity_plans(family_id,type,lifecycle,creator_membership_id) VALUES($1,'ROUTINE','PUBLISHED',$2) RETURNING *",
          [familyId, membershipId],
        );
        const v = await common.one(
          db,
          "INSERT INTO activity_plan_versions(family_id,plan_id,revision,title,metric,award_points,weekdays,effective_from,published_at) VALUES($1,$2,1,'旧的安排','CHECK',5,ARRAY[1,2,3,4,5,6,7]::smallint[],$3,$3) RETURNING *",
          [familyId, plan.id, old],
        );
        await db.query(
          'INSERT INTO plan_version_children(family_id,plan_version_id,child_id,assigned_at) VALUES($1,$2,$3,$4)',
          [familyId, v.id, archived.id, old],
        );
        await db.query("UPDATE child_profiles SET status='ARCHIVED',archived_at=$2 WHERE id=$1", [
          archived.id,
          archivedAt,
        ]);
        return plan;
      });
      const h = await request(
        'GET',
        `/plans/${p.id}/occurrences?dateFrom=${addDays(today(), -10)}&dateTo=${today()}&limit=100`,
      );
      assert.equal(h.items.length, 7);
      assert.ok(h.items.every((o: any) => o.businessDate < addDays(today(), -3)));
    },
  );

  async function challenge(name: string) {
    let p = await request('POST', '/plans', {
      type: 'CHALLENGE',
      title: name,
      metric: 'CHECK',
      awardPoints: 7,
      childIds: [historicalChild.id],
      startsAt: new Date(Date.now() - DAY).toISOString(),
      endsAt: new Date(Date.now() + DAY).toISOString(),
    });
    p = await request('POST', `/plans/${p.id}/publish`, { expectedVersion: p.version });
    const o = (await request('GET', `/plans/${p.id}/occurrences`)).items[0];
    return { plan: p, occurrence: o };
  }
  await t.test(
    'plan versions use the publication clock even when the application clock drifts',
    async (clockTest) => {
      const { plan } = await challenge('时钟偏差验证');
      const publishedVersionId = plan.currentVersion.id;

      for (const applicationTime of [0, Date.now() + DAY]) {
        const clock = clockTest.mock.method(Date, 'now', () => applicationTime);
        try {
          const [view] = await common.transaction(pool, (db) => planViews(db, [plan]));
          assert.equal(view.currentVersion.id, publishedVersionId);
          assert.equal(view.scheduledVersion, null);
        } finally {
          clock.mock.restore();
        }
      }
    },
  );
  await t.test(
    'stopped challenge rejects new claims but permits truthful completion before stopping',
    async () => {
      const c = await challenge('停止后补记');
      // Challenge declared yesterday, but this child's occurrence begins only at publication.
      assert.ok(Date.parse(c.occurrence.startsAt) >= Date.parse(c.plan.currentVersion.publishedAt));
      const before = await common.one(pool, 'SELECT clock_timestamp() now');
      const stopped = await request('POST', `/plans/${c.plan.id}/stop`, {
        reason: '安排有变化',
        expectedVersion: c.plan.version,
      });
      assert.ok(Date.parse(before.now) < Date.parse(stopped.stoppedAt));
      const blocked = await request(
        'POST',
        `/occurrences/${c.occurrence.id}/submissions`,
        { checked: true, expectedVersion: 1 },
        parent,
        randomUUID(),
        409,
      );
      assert.equal(blocked.error.code, 'WINDOW_CLOSED');
      await request(
        'POST',
        `/occurrences/${c.occurrence.id}/direct-completion`,
        {
          checked: true,
          completedAt: new Date(Date.parse(c.occurrence.startsAt) - 1).toISOString(),
          expectedVersion: 1,
        },
        parent,
        randomUUID(),
        400,
      );
      const after = await request(
        'POST',
        `/occurrences/${c.occurrence.id}/direct-completion`,
        { checked: true, completedAt: stopped.stoppedAt, expectedVersion: 1 },
        parent,
        randomUUID(),
        409,
      );
      assert.equal(after.error.code, 'WINDOW_CLOSED');
      const result = await request('POST', `/occurrences/${c.occurrence.id}/direct-completion`, {
        checked: true,
        completedAt: before.now,
        expectedVersion: 1,
      });
      assert.equal(result.occurrence.status, 'APPROVED');
    },
  );
  await t.test('stopping preserves submitted review and returned supplementation', async () => {
    const c = await challenge('停止后继续审核');
    let result = await request('POST', `/occurrences/${c.occurrence.id}/submissions`, {
      checked: true,
      expectedVersion: 1,
    });
    await request('POST', `/plans/${c.plan.id}/stop`, {
      reason: '停止新参与',
      expectedVersion: c.plan.version,
    });
    result = await request('POST', `/occurrences/${c.occurrence.id}/review`, {
      decision: 'RETURN',
      reason: '补充说明',
      expectedVersion: result.occurrence.version,
    });
    assert.equal(result.occurrence.status, 'NEEDS_CHANGES');
    assert.ok(Date.parse(result.occurrence.supplementUntil) >= Date.parse(c.occurrence.endsAt));
    result = await request('POST', `/occurrences/${c.occurrence.id}/submissions`, {
      checked: true,
      note: '已经补充',
      expectedVersion: result.occurrence.version,
    });
    result = await request('POST', `/occurrences/${c.occurrence.id}/review`, {
      decision: 'APPROVE',
      expectedVersion: result.occurrence.version,
    });
    assert.equal(result.occurrence.status, 'APPROVED');
  });
  await t.test(
    'cancel and fulfillment race has one terminal transition and a consistent ledger',
    async () => {
      const pending = await newOrder(unlimited);
      const ready = await request('POST', `/orders/${pending.order.id}/approve`, {
        expectedVersion: 1,
      });
      const results = await Promise.all([
        raw('POST', `/orders/${pending.order.id}/fulfill`, {
          expectedVersion: ready.order.version,
        }),
        raw(
          'POST',
          `/orders/${pending.order.id}/cancel`,
          { expectedVersion: ready.order.version, reasonCode: 'OTHER' },
          kid,
        ),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal((await domain.reconcile(services)).status, 'PASS');
    },
  );
  await t.test('original refund may cross one million while new grants remain capped', async () => {
    const actor = await services.auth.require({
      headers: { authorization: 'Bearer ' + parent.accessToken },
    });
    const initial = (await account()).availablePoints;
    // Reach 999,000 entirely through valid immutable grants, never a balance edit.
    await common.transaction(pool, async (db) => {
      for (
        let remaining = 999000 - initial;
        remaining > 0;
        remaining -= Math.min(remaining, 1000)
      ) {
        await movePoints(db, actor, {
          familyId,
          childId,
          type: 'PRAISE',
          points: Math.min(remaining, 1000),
          sourceType: 'PRAISE',
          sourceId: randomUUID(),
          reason: '额度边界准备',
        });
      }
    });
    unlimited = await request('PATCH', `/rewards/${unlimited.id}`, {
      costPoints: 1000,
      expectedVersion: unlimited.version,
    });
    const pending = await newOrder(unlimited);
    const ready = await request('POST', `/orders/${pending.order.id}/approve`, {
      expectedVersion: 1,
    });
    await request('POST', `/children/${childId}/praises`, { points: 1000, reason: '新的表扬' });
    await request('POST', `/children/${childId}/praises`, {
      points: 1,
      reason: '到达边界前的表扬',
    });
    const refunded = await request(
      'POST',
      `/orders/${pending.order.id}/cancel`,
      { expectedVersion: ready.order.version, reasonCode: 'OTHER' },
      kid,
    );
    assert.equal(refunded.account.availablePoints, 1000001);
    const denied = await request(
      'POST',
      `/children/${childId}/praises`,
      { points: 1, reason: '不能再新增' },
      parent,
      randomUUID(),
      409,
    );
    assert.equal(denied.error.code, 'GRANT_CAP_EXCEEDED');
    assert.equal((await domain.reconcile(services)).status, 'PASS');
  });
  await t.test(
    'reconciliation freezes only affected scope; repair requires clean facts and audit reason',
    async () => {
      const id = historicalChild.id;
      const before = await common.one(pool, 'SELECT * FROM point_accounts WHERE child_id=$1', [id]);
      await pool.query(
        'UPDATE point_accounts SET available_points=available_points+1 WHERE child_id=$1',
        [id],
      );
      const report = await domain.reconcile(services);
      assert.equal(report.status, 'FAIL');
      assert.ok(report.issues.some((x: any) => x.code === 'ACCOUNT_LEDGER' && x.childId === id));
      const frozen = await request('GET', `/children/${id}/account`);
      assert.equal(frozen.frozen, true);
      const denied = await request(
        'POST',
        `/children/${id}/praises`,
        { points: 1, reason: '冻结时拒绝' },
        parent,
        randomUUID(),
        409,
      );
      assert.equal(denied.error.code, 'ACCOUNT_FROZEN');
      assert.equal((await account()).frozen, false);
      await assert.rejects(
        domain.resolveIncidents(services, {
          familyId,
          childId: id,
          operator: 'domain-test',
          reason: '尚未修复',
        }),
        (e: any) => e.code === 'RECONCILIATION_FAILED',
      );
      // Operational repair changes the derived balance only, preserving all facts.
      await pool.query('UPDATE point_accounts SET available_points=$2 WHERE child_id=$1', [
        id,
        before.availablePoints,
      ]);
      assert.equal((await domain.reconcile(services)).status, 'PASS');
      assert.equal(
        (await request('GET', `/children/${id}/account`)).frozen,
        true,
        'PASS alone cannot silently unfreeze',
      );
      const resolved = await domain.resolveIncidents(services, {
        familyId,
        childId: id,
        operator: 'domain-test',
        reason: '已按不可变账本修复余额缓存并复核',
      });
      assert.ok(resolved.resolved.length);
      await request('POST', `/children/${id}/praises`, { points: 1, reason: '复核后恢复' });
      assert.equal((await request('GET', `/children/${id}/account`)).frozen, false);
      assert.equal(
        (
          await common.one(
            pool,
            "SELECT COUNT(*)::int n FROM audit_logs WHERE family_id=$1 AND action='RECONCILIATION_RESOLVE'",
            [familyId],
          )
        ).n,
        1,
      );
      assert.equal((await domain.reconcile(services)).status, 'PASS');
    },
  );
});
