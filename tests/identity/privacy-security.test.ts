import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';
import { buildApp } from '../../apps/api/src/main.js';
import { loadConfig } from '../../apps/api/src/common/config.js';
import { migrate } from '../../apps/api/src/migrate.js';
import { runMediaJobs } from '../../apps/api/src/media/index.js';
import { runPrivacyJobs } from '../../apps/api/src/privacy/index.js';
const databaseUrl = 'postgresql://localhost/pointjoy_identity_qa_20260919';
const root = path.resolve('.var/identity-qa-' + randomUUID());
const config = {
  ...loadConfig({ APP_ENV: 'test', DATABASE_URL: databaseUrl }),
  mediaDir: path.join(root, 'media'),
  exportDir: path.join(root, 'exports'),
  securityJournalDir: path.join(root, 'security'),
};
let app: any;
let s: any;
type Client = {
  token: string;
  refresh: string;
  subject: string;
  session: any;
  userId?: string;
  pin?: string;
};
async function call(c: Client | null, method: string, url: string, body?: any, key?: string) {
  const response = await app.inject({
    method,
    url: url.startsWith('/api/v1') ? url : '/api/v1' + url,
    headers: {
      ...(c ? { authorization: 'Bearer ' + c.token } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': key || randomUUID() } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
  let result: any;
  try {
    result = response.json();
  } catch {
    result = response.body;
  }
  return {
    status: response.statusCode,
    data: result?.data,
    error: result?.error,
    response,
    body: result,
  };
}
async function good(c: Client | null, method: string, url: string, body?: any, key?: string) {
  const r = await call(c, method, url, body, key);
  assert.ok(
    r.status >= 200 && r.status < 300 && !r.error,
    `${method} ${url} ${r.status} ${JSON.stringify(r.body)}`,
  );
  return r.data;
}
function tokens(c: Client, d: any) {
  c.token = d.accessToken;
  c.refresh = d.refreshToken;
  c.session = d.session;
}
async function login(subject: string) {
  const c = { subject } as Client;
  tokens(
    c,
    await good(null, 'POST', '/auth/wechat/login', {
      code: 'local:' + subject,
      loginAttemptId: randomUUID(),
    }),
  );
  return c;
}
async function upload(c: Client, purpose: string, scope: any = {}) {
  const bytes = await sharp({
    create: { width: 50, height: 60, channels: 3, background: '#296b58' },
  })
    .png()
    .toBuffer();
  const intent = await good(c, 'POST', '/media/upload-intents', {
    purpose,
    filename: 'qa.png',
    mime: 'image/png',
    sizeBytes: bytes.length,
    ...scope,
  });
  const boundary = 'QA' + randomUUID();
  const r = await app.inject({
    method: 'POST',
    url: new URL(intent.uploadUrl).pathname,
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(r.statusCode, 200, r.body);
  await good(c, 'POST', `/media/${intent.mediaId}/finish`, {});
  await runMediaJobs(s);
  const m = await good(c, 'GET', `/media/${intent.mediaId}`);
  assert.equal(m.status, 'READY');
  return m;
}
async function complete(c: Client, name: string) {
  const m = await upload(c, 'USER_AVATAR');
  const p = await good(c, 'GET', '/me/profile');
  const d = await good(c, 'PUT', '/me/profile', {
    displayName: name,
    avatarMediaId: m.id,
    privacyVersion: config.privacyVersion,
    expectedVersion: p.version,
  });
  c.session = d.session;
  c.userId = d.profile.id;
}
async function createFamily(c: Client, name: string) {
  const f = await good(c, 'POST', '/families', { name });
  tokens(c, await good(c, 'POST', '/auth/context', { contextId: f.contextId }));
  return f.family;
}
async function createChild(c: Client, fid: string, name: string) {
  const draft = await good(c, 'POST', `/families/${fid}/child-drafts`, {});
  const m = await upload(c, 'CHILD_AVATAR', { familyId: fid, childDraftId: draft.childDraftId });
  return good(c, 'POST', `/families/${fid}/children`, {
    childDraftId: draft.childDraftId,
    nickname: name,
    avatarMediaId: m.id,
  });
}
async function step(c: Client, action: string) {
  return (
    await good(c, 'POST', '/auth/step-up', {
      action,
      ...(c.pin ? { pin: c.pin } : { newWechatCode: 'local:' + c.subject }),
    })
  ).stepUpToken;
}
async function enroll(c: Client) {
  const e = await good(c, 'POST', '/auth/pin/enroll', { pin: '246810', confirmationPin: '246810' });
  await good(c, 'POST', '/auth/pin/enroll/confirm', {
    enrollmentId: e.enrollmentId,
    recoverySaved: true,
  });
  c.pin = '246810';
  return e.recoveryCode;
}
function zipEntries(buffer: Buffer) {
  let at = 0;
  const entries: Record<string, Buffer> = {};
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameSize = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameSize).toString();
    const start = at + 30 + nameSize + extra;
    entries[name] = buffer.subarray(start, start + size);
    at = start + size;
  }
  assert.equal(buffer.readUInt32LE(at), 0x02014b50);
  return entries;
}

test('identity/privacy real PostgreSQL and private-file lifecycle', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await pool.end();
  ({ app, services: s } = await buildApp(config));
  if (process.env.IDENTITY_QA_DEBUG) {
    app.addHook('onError', async (_r: any, _p: any, error: any) => {
      if (error.statusCode >= 500 || !error.statusCode) {
        console.error(error.stack);
      }
    });
  }
  await app.ready();
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const owner = await login('qa-owner');
  await complete(owner, '隐私测试家长');
  const family = await createFamily(owner, '隐私测试家庭');
  const child = await createChild(owner, family.id, '测试孩子');
  let recovery = await enroll(owner);
  let exportRequest: any;
  let selfDeletion: any;
  let evidenceId: string;
  await t.test(
    'prepare earned points, evidence and fulfilled reward for full deletion coverage',
    async () => {
      const plan = await good(owner, 'POST', `/families/${family.id}/plans`, {
        type: 'ROUTINE',
        title: '整理自己的书桌',
        metric: 'CHECK',
        awardPoints: 10,
        childIds: [child.id],
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      });
      await good(owner, 'POST', `/families/${family.id}/plans/${plan.id}/publish`, {
        startPolicy: 'TODAY',
        expectedVersion: plan.version,
      });
      const o = (await good(owner, 'GET', `/families/${family.id}/children/${child.id}/today`))
        .routines[0];
      const photo = await upload(owner, 'COMPLETION_EVIDENCE', {
        familyId: family.id,
        childId: child.id,
        occurrenceId: o.id,
      });
      evidenceId = photo.id;
      await good(owner, 'POST', `/families/${family.id}/occurrences/${o.id}/direct-completion`, {
        checked: true,
        completedAt: new Date().toISOString(),
        note: '需要删除的完成文本',
        mediaIds: [photo.id],
        expectedVersion: o.version,
      });
      let r = await good(owner, 'POST', `/families/${family.id}/rewards`, {
        name: '看一本新书',
        category: 'ITEM',
        benefitDescription: '选一本喜欢的书',
        costPoints: 4,
        stockMode: 'FINITE',
        initialStock: 2,
        childIds: [child.id],
      });
      r = await good(owner, 'POST', `/families/${family.id}/rewards/${r.id}/status`, {
        status: 'ACTIVE',
        expectedVersion: r.version,
      });
      let order = (
        await good(owner, 'POST', `/families/${family.id}/children/${child.id}/orders`, {
          rewardId: r.id,
          expectedRewardVersion: r.version,
          expectedCostPoints: 4,
        })
      ).order;
      order = (
        await good(owner, 'POST', `/families/${family.id}/orders/${order.id}/approve`, {
          expectedVersion: order.version,
        })
      ).order;
      await good(owner, 'POST', `/families/${family.id}/orders/${order.id}/fulfill`, {
        expectedVersion: order.version,
        note: '已读完',
      });
    },
  );
  await t.test('credential enrollment is journaled without authentication secrets', async () => {
    const result = await s.pool.query(
      "SELECT payload FROM outbox WHERE event_type='SECURITY_PROTECTION' AND payload->>'kind'='PIN_ENROLLED'",
    );
    assert.equal(result.rows.length, 1);
    const text = JSON.stringify(result.rows[0].payload);
    assert.ok(text.includes('credentialVersion'));
    assert.ok(!/pinHash|recoveryHash|246810/.test(text));
  });
  await t.test('OWNER personal delete needs action even after family archive', async () => {
    selfDeletion = await good(owner, 'POST', '/me/privacy-requests', {
      type: 'DELETE',
      scope: 'SELF_ACCOUNT',
      confirmation: { confirmed: true, deleteOwnChildSensitiveDataConfirmed: true },
      stepUpToken: await step(owner, 'DELETE_SELF'),
    });
    assert.equal(selfDeletion.status, 'NEEDS_ACTION');
    const f = await good(owner, 'GET', `/families/${family.id}`);
    await good(owner, 'POST', `/families/${family.id}/archive`, {
      expectedVersion: f.family.version,
      retainLedgersConfirmed: true,
      stepUpToken: await step(owner, 'ARCHIVE_FAMILY'),
    });
    await runPrivacyJobs(s);
    assert.equal(
      (await good(owner, 'GET', `/privacy-requests/${selfDeletion.id}`)).status,
      'NEEDS_ACTION',
    );
  });
  await t.test(
    'archived family can request and download real private ZIP with manifest JSON CSV',
    async () => {
      exportRequest = await good(owner, 'POST', `/families/${family.id}/privacy-requests`, {
        type: 'EXPORT',
        scope: 'FAMILY',
        confirmation: { confirmed: true },
        stepUpToken: await step(owner, 'EXPORT_FAMILY'),
      });
      await runPrivacyJobs(s);
      const p = await good(owner, 'GET', `/privacy-requests/${exportRequest.id}`);
      assert.equal(p.status, 'COMPLETED');
      assert.equal(p.downloadAvailable, true);
      const grant = await good(owner, 'POST', `/privacy-requests/${p.id}/download-grant`, {});
      const response = await app.inject({
        method: 'GET',
        url: new URL(grant.downloadUrl).pathname,
      });
      assert.equal(response.statusCode, 200, response.body);
      const entries = zipEntries(response.rawPayload);
      assert.ok(entries['manifest.json']);
      assert.ok(entries['data/children.csv']);
      assert.ok(entries[`photos/${evidenceId}.jpg`]);
      const manifest = JSON.parse(entries['manifest.json'].toString());
      assert.equal(manifest.recordCounts.children, 1);
      assert.equal(manifest.timezone, 'Asia/Shanghai');
      const text = Object.values(entries)
        .map((b) => b.toString())
        .join('\n');
      assert.ok(!/access_hash|pin_hash|recovery_hash|openid/.test(text));
      await s.pool.query(
        "UPDATE privacy_requests SET export_expires_at=now()-interval '1 second' WHERE id=$1",
        [p.id],
      );
      await runPrivacyJobs(s);
      assert.equal(
        (await call(owner, 'POST', `/privacy-requests/${p.id}/download-grant`, {})).status,
        410,
      );
      assert.equal((await fs.readdir(config.exportDir)).length, 0);
    },
  );
  await t.test(
    'family delete removes full online scope and keeps bounded 35-day backup tombstone',
    async () => {
      const p = await good(owner, 'POST', `/families/${family.id}/privacy-requests`, {
        type: 'DELETE',
        scope: 'FAMILY',
        confirmation: {
          confirmed: true,
          familyName: family.name,
          deleteNonzeroBalancesConfirmed: true,
        },
        stepUpToken: await step(owner, 'DELETE_FAMILY'),
      });
      await runPrivacyJobs(s);
      const stored = (await s.pool.query('SELECT * FROM privacy_requests WHERE id=$1', [p.id]))
        .rows[0];
      assert.equal(stored.status, 'COMPLETED', JSON.stringify(stored));
      for (const table of [
        'families',
        'child_profiles',
        'guardian_memberships',
        'media_assets',
        'point_accounts',
        'point_ledger',
        'redemption_orders',
        'completion_submissions',
        'activity_plans',
        'stock_ledger',
      ]) {
        assert.equal(
          (
            await s.pool.query(
              `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'families' ? 'id' : 'family_id'}=$1`,
              [family.id],
            )
          ).rows[0].n,
          0,
          table,
        );
      }
      const tomb = (
        await s.pool.query('SELECT * FROM deletion_tombstones WHERE request_id=$1', [p.id])
      ).rows[0];
      assert.equal(Math.round((tomb.backup_purge_due_at - tomb.deleted_at) / 86400000), 35);
      assert.equal(Math.round((tomb.clear_after - tomb.deleted_at) / 86400000), 65);
      assert.equal(tomb.completed_at, null);
      assert.equal((await call(owner, 'GET', `/families/${family.id}`)).status, 401);
    },
  );
  await t.test(
    'personal deletion resumes after the last owned family is actually deleted',
    async () => {
      await runPrivacyJobs(s);
      const p = (
        await s.pool.query('SELECT * FROM privacy_requests WHERE id=$1', [selfDeletion.id])
      ).rows[0];
      assert.equal(p.status, 'COMPLETED', JSON.stringify(p));
      const receipt = await good(null, 'GET', `/privacy-receipts/${selfDeletion.receiptToken}`);
      assert.equal(receipt.onlineDataStatus, 'COMPLETED');
      assert.equal(receipt.backupStatus, 'PENDING');
      assert.ok(receipt.backupPurgeDueAt);
      assert.equal(receipt.familyId, undefined);
      assert.equal(receipt.userId, undefined);
      assert.equal((await call(null, 'GET', `/privacy-receipts/${'x'.repeat(43)}`)).status, 404);
      assert.equal(
        (await s.pool.query('SELECT * FROM auth_identities WHERE user_id=$1', [owner.userId])).rows
          .length,
        0,
      );
      assert.equal(
        (
          await s.pool.query(
            'SELECT display_name,profile_completed_at,status FROM users WHERE id=$1',
            [owner.userId],
          )
        ).rows[0].status,
        'DISABLED',
      );
    },
  );
  const solo = await login('qa-solo');
  await complete(solo, '本人账号');
  await t.test(
    'ACCOUNT personal export works without family/PIN and only its own profile',
    async () => {
      const p = await good(solo, 'POST', '/me/privacy-requests', {
        type: 'EXPORT',
        scope: 'SELF_ACCOUNT',
        confirmation: { confirmed: true },
        stepUpToken: await step(solo, 'EXPORT_SELF'),
      });
      await runPrivacyJobs(s);
      const g = await good(solo, 'POST', `/privacy-requests/${p.id}/download-grant`, {});
      const r = await app.inject({ method: 'GET', url: new URL(g.downloadUrl).pathname });
      assert.equal(r.statusCode, 200);
      const entries = zipEntries(r.rawPayload);
      const profile = JSON.parse(entries['data/profile.json'].toString());
      assert.equal(profile[0].displayName, '本人账号');
      assert.equal(JSON.parse(entries['data/children.json'].toString()).length, 0);
    },
  );
  await t.test(
    'single account deletion clears identity/avatar/export and revokes all sessions',
    async () => {
      const p = await good(solo, 'POST', '/me/privacy-requests', {
        type: 'DELETE',
        scope: 'SELF_ACCOUNT',
        confirmation: { confirmed: true, deleteOwnChildSensitiveDataConfirmed: true },
        stepUpToken: await step(solo, 'DELETE_SELF'),
      });
      await runPrivacyJobs(s);
      const row = (
        await s.pool.query(
          'SELECT status,user_visible_note,outcome_code FROM privacy_requests WHERE id=$1',
          [p.id],
        )
      ).rows[0];
      assert.equal(row.status, 'COMPLETED', JSON.stringify(row));
      assert.equal((await call(solo, 'GET', '/auth/session')).status, 401);
      assert.equal((await fs.readdir(config.exportDir)).length, 0);
    },
  );
  await t.test(
    'DIRECT child deletion removes sensitive text/photos and prior family exports while preserving shared points',
    async () => {
      const parent = await login('qa-child-parent');
      await complete(parent, '仍在使用的家长');
      const f = await createFamily(parent, '孩子隐私验证家庭');
      const c = await createChild(parent, f.id, '将要删除的孩子昵称');
      const kid = await login('qa-direct-delete');
      await complete(kid, '孩子自己的微信昵称');
      const invitation = await good(
        parent,
        'POST',
        `/families/${f.id}/children/${c.id}/binding-invitations`,
        {},
      );
      const application = await good(kid, 'POST', '/child-binding-applications', {
        token: invitation.token,
      });
      await good(
        parent,
        'POST',
        `/families/${f.id}/child-binding-applications/${application.id}/decision`,
        { decision: 'APPROVE', syncProfile: true, expectedVersion: application.version },
      );
      const contexts = await good(kid, 'GET', '/me/contexts');
      tokens(
        kid,
        await good(kid, 'POST', '/auth/context', { contextId: contexts.items[0].contextId }),
      );
      const praiseKey = randomUUID();
      await good(
        parent,
        'POST',
        `/families/${f.id}/children/${c.id}/praises`,
        { points: 17, reason: '需要删除的孩子私有文本' },
        praiseKey,
      );
      const oldExport = await good(parent, 'POST', `/families/${f.id}/privacy-requests`, {
        type: 'EXPORT',
        scope: 'FAMILY',
        confirmation: { confirmed: true },
        stepUpToken: await step(parent, 'EXPORT_FAMILY'),
      });
      await runPrivacyJobs(s);
      const grant = await good(
        parent,
        'POST',
        `/privacy-requests/${oldExport.id}/download-grant`,
        {},
      );
      const deletion = await good(kid, 'POST', '/me/privacy-requests', {
        type: 'DELETE',
        scope: 'SELF_ACCOUNT',
        confirmation: { confirmed: true, deleteOwnChildSensitiveDataConfirmed: true },
        stepUpToken: await step(kid, 'DELETE_SELF'),
      });
      await runPrivacyJobs(s);
      const receipt = await good(null, 'GET', `/privacy-receipts/${deletion.receiptToken}`);
      assert.equal(receipt.onlineDataStatus, 'COMPLETED', JSON.stringify(receipt));
      assert.equal(receipt.backupStatus, 'PENDING');
      assert.equal(
        (await app.inject({ method: 'GET', url: new URL(grant.downloadUrl).pathname })).statusCode,
        410,
      );
      const retained = await good(parent, 'GET', `/families/${f.id}/children/${c.id}`);
      assert.equal(retained.boundUserId, null);
      assert.equal(retained.nickname, '已删除孩子资料');
      assert.equal(
        (await good(parent, 'GET', `/families/${f.id}/children/${c.id}/account`)).availablePoints,
        17,
      );
      const ledger = (
        await s.pool.query('SELECT reason,actor_user_id FROM point_ledger WHERE child_id=$1', [
          c.id,
        ])
      ).rows;
      assert.equal(ledger[0].reason, '已删除个人文本');
      const replay = await good(
        parent,
        'POST',
        `/families/${f.id}/children/${c.id}/praises`,
        { points: 17, reason: '需要删除的孩子私有文本' },
        praiseKey,
      );
      assert.equal(replay.redacted, true);
      assert.equal(
        (await good(parent, 'GET', `/families/${f.id}/children/${c.id}/account`)).availablePoints,
        17,
      );
      assert.equal((await call(kid, 'GET', '/auth/session')).status, 401);
    },
  );
  const adult = await login('qa-recovery');
  await complete(adult, '恢复测试家长');
  const fid = (await createFamily(adult, '恢复测试家庭')).id;
  recovery = await enroll(adult);
  const fresh = await login(adult.subject);
  fresh.pin = '246810';
  await t.test(
    'recovery response replay is bound to original locked bearer and same attempt',
    async () => {
      const body = {
        newWechatCode: 'local:' + fresh.subject,
        recoveryCode: recovery,
        newPin: '135790',
        confirmationPin: '135790',
        recoveryAttemptId: randomUUID(),
      };
      const old = { ...fresh };
      const first = await good(fresh, 'POST', '/auth/pin/recover', body);
      const replay = await good(old, 'POST', '/auth/pin/recover', body);
      assert.equal(first.accessToken, replay.accessToken);
      assert.equal(first.recoveryCode, replay.recoveryCode);
      assert.equal((await call(adult, 'GET', '/auth/session')).status, 401);
      const unrelated = await login(fresh.subject);
      assert.equal((await call(unrelated, 'POST', '/auth/pin/recover', body)).status, 403);
      tokens(fresh, first);
      fresh.pin = '135790';
      recovery = first.recoveryCode;
    },
  );
  await t.test(
    'refresh retry returns one new session and a later revoked result is never resurrected',
    async () => {
      const body = { refreshToken: fresh.refresh, refreshAttemptId: randomUUID() };
      const replies = await Promise.all([
        good(null, 'POST', '/auth/refresh', body),
        good(null, 'POST', '/auth/refresh', body),
      ]);
      assert.equal(replies[0].accessToken, replies[1].accessToken);
      tokens(fresh, replies[0]);
      await good(fresh, 'POST', '/auth/logout', {});
      assert.equal((await call(null, 'POST', '/auth/refresh', body)).status, 401);
    },
  );
  await t.test(
    'two concurrent context switches cannot both rotate the same source session',
    async () => {
      const c = await login(adult.subject);
      tokens(c, await good(c, 'POST', '/auth/pin/unlock', { pin: '135790' }));
      const ctx = (await good(c, 'GET', '/me/contexts')).items[0];
      const results = await Promise.all([
        call(c, 'POST', '/auth/context', { contextId: ctx.contextId }),
        call(c, 'POST', '/auth/context', { contextId: ctx.contextId }),
      ]);
      assert.equal(
        results.filter((r) => r.status === 200).length,
        1,
        JSON.stringify(results.map((r) => ({ status: r.status, error: r.error }))),
      );
      assert.equal(results.filter((r) => r.status === 401).length, 1);
    },
  );
  await t.test(
    'binding approval versus personal deletion never leaves a disabled user bound',
    async () => {
      const parent = await login('qa-delete-race-parent');
      await complete(parent, '竞态测试家长');
      const f = await createFamily(parent, '删除竞态测试家庭');
      const child = await createChild(parent, f.id, '竞态孩子');
      const applicant = await login('qa-delete-race-child');
      await complete(applicant, '待申请账号');
      const invite = await good(
        parent,
        'POST',
        `/families/${f.id}/children/${child.id}/binding-invitations`,
        {},
      );
      const application = await good(applicant, 'POST', '/child-binding-applications', {
        token: invite.token,
      });
      await good(applicant, 'POST', '/me/privacy-requests', {
        type: 'DELETE',
        scope: 'SELF_ACCOUNT',
        confirmation: { confirmed: true, deleteOwnChildSensitiveDataConfirmed: true },
        stepUpToken: await step(applicant, 'DELETE_SELF'),
      });
      await Promise.all([
        call(
          parent,
          'POST',
          `/families/${f.id}/child-binding-applications/${application.id}/decision`,
          { decision: 'APPROVE', syncProfile: true, expectedVersion: application.version },
        ),
        runPrivacyJobs(s),
      ]);
      const row = (
        await s.pool.query('SELECT bound_user_id FROM child_profiles WHERE id=$1', [child.id])
      ).rows[0];
      assert.equal(row.bound_user_id, null);
      assert.equal(
        (await s.pool.query('SELECT status FROM users WHERE id=$1', [applicant.userId])).rows[0]
          .status,
        'DISABLED',
      );
    },
  );
  await t.test(
    'DELETING family blocks guardian reads and writes, including previously issued media grants',
    async () => {
      const locked = await login(adult.subject);
      tokens(locked, await good(locked, 'POST', '/auth/pin/unlock', { pin: '135790' }));
      const contexts = await good(locked, 'GET', '/me/contexts');
      tokens(
        locked,
        await good(locked, 'POST', '/auth/context', {
          contextId: contexts.items.find((c: any) => c.family.id === fid).contextId,
        }),
      );
      const c = await createChild(locked, fid, '冻结测试孩子');
      const grant = await good(locked, 'POST', `/media/${c.avatarMediaId}/read-grants`, {});
      await s.pool.query("UPDATE families SET status='DELETING' WHERE id=$1", [fid]);
      assert.equal((await call(locked, 'GET', `/families/${fid}`)).error.code, 'FAMILY_FROZEN');
      assert.equal((await call(locked, 'GET', `/families/${fid}/children/${c.id}`)).status, 423);
      assert.equal(
        (await app.inject({ method: 'GET', url: new URL(grant.readUrl).pathname })).statusCode,
        423,
      );
      await s.pool.query("UPDATE families SET status='ACTIVE' WHERE id=$1", [fid]);
    },
  );
  await t.test(
    'restore protection blocks both PIN and recovery while allowing support request/status',
    async () => {
      const locked = await login(adult.subject);
      await s.pool.query('UPDATE pin_credentials SET recovery_blocked=true WHERE user_id=$1', [
        adult.userId,
      ]);
      assert.equal(
        (await call(locked, 'POST', '/auth/pin/unlock', { pin: '135790' })).error.code,
        'PIN_RECOVERY_REQUIRED',
      );
      const r = await call(locked, 'POST', '/auth/pin/recover', {
        newWechatCode: 'local:' + locked.subject,
        recoveryCode: recovery,
        newPin: '112233',
        confirmationPin: '112233',
        recoveryAttemptId: randomUUID(),
      });
      assert.equal(r.error.code, 'PIN_RECOVERY_REQUIRED');
      const support = await good(locked, 'POST', '/support/pin-recovery-requests', {
        description: '恢复后无法使用密码，需要独立核验',
      });
      assert.equal(support.type, 'PIN_RECOVERY');
      assert.ok(
        (await good(locked, 'GET', '/support/pin-recovery-requests')).items.some(
          (p: any) => p.id === support.id,
        ),
      );
    },
  );
});
