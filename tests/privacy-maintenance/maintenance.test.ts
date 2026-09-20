import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { migrate } from '../../apps/api/src/migrate.js';
import { buildApp } from '../../apps/api/src/main.js';
import { loadConfig } from '../../apps/api/src/common/config.js';
import {
  confirmBackupPurge,
  listSupportRequests,
  showSupportRequest,
  updateSupportRequest,
  validateMaintenanceConfig,
} from '../../apps/api/src/privacy/maintenance.js';
const execute = promisify(execFile);
const DAY = 86_400_000;
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const databaseUrl = 'postgresql://localhost/pointjoy_privacy_maintenance_qa';
const runtime = { environment: 'test' as const, databaseUrl };
const stamp = (time: number) =>
  new Date(time)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

test('backup confirmation checks real files, authenticates backup, and preserves public receipt stages', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  const root = path.join(projectRoot, '.var/privacy-maintenance-' + randomUUID());
  const rotating = path.join(root, 'rotating');
  const legacy = path.join(root, 'legacy');
  const exports = path.join(root, 'exports');
  const keyPath = path.join(root, 'backup.key');
  await Promise.all(
    [rotating, legacy, exports].map((p) => fs.mkdir(p, { recursive: true, mode: 0o700 })),
  );
  const rawKey = randomBytes(32);
  await fs.writeFile(keyPath, rawKey, { mode: 0o600 });
  const config = {
    version: 1 as const,
    backupDirectories: [
      { path: rotating, kind: 'ROTATING' as const, keyFile: keyPath },
      { path: legacy, kind: 'LEGACY' as const, keyFile: keyPath },
    ],
    exportDirectory: exports,
    backupLockFile: path.join(root, 'backup.lock'),
    maxLatestBackupAgeMinutes: 30,
  };
  const configFile = path.join(root, 'maintenance.json');
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const appConfig = {
    ...loadConfig({ APP_ENV: 'test', DATABASE_URL: databaseUrl }),
    mediaDir: path.join(root, 'media'),
    exportDir: exports,
    securityJournalDir: path.join(root, 'journal'),
  };
  const { app } = await buildApp(appConfig);
  await app.ready();
  t.after(async () => {
    await app.close();
    await pool.end();
    await fs.rm(root, { recursive: true, force: true });
  });
  const user = (
    await pool.query(
      "INSERT INTO users(status,display_name) VALUES('DISABLED','已删除账号') RETURNING id",
    )
  ).rows[0];
  const receipt = randomBytes(32).toString('base64url');
  const request = (
    await pool.query(
      `INSERT INTO privacy_requests(user_id,type,scope,status,outcome_code,requested_at,due_at,completed_at,receipt_token_hash,user_visible_note) VALUES($1,'DELETE','SELF_ACCOUNT','COMPLETED','ONLINE_DELETION_COMPLETED',now()-interval '40 days',now()-interval '33 days',now()-interval '36 days',$2,'在线数据已删除，备份仍在轮换。') RETURNING id`,
      [user.id, createHash('sha256').update(receipt).digest('hex')],
    )
  ).rows[0];
  const marker = (
    await pool.query(
      `INSERT INTO deletion_tombstones(request_id,subject_hash,deleted_at,backup_purge_due_at,clear_after) VALUES($1,$2,now()-interval '36 days',now()-interval '1 day',now()+interval '29 days') RETURNING id`,
      [request.id, createHash('sha256').update(user.id).digest('hex')],
    )
  ).rows[0];
  const encrypted = (contents: Buffer) => {
    const magic = Buffer.from('PJBGCM1');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(rawKey).digest(), iv);
    cipher.setAAD(magic);
    const data = Buffer.concat([cipher.update(contents), cipher.final()]);
    return Buffer.concat([magic, iv, data, cipher.getAuthTag()]);
  };
  const now = Date.now();
  const latestPath = path.join(rotating, stamp(now) + '.tgz.enc');
  const oldPath = path.join(rotating, stamp(now - 37 * DAY) + '.tgz.enc');
  const legacyPath = path.join(legacy, 'before-v1.dump.enc');
  const latestBytes = encrypted(gzipSync(Buffer.from('fixture new backup after online deletion')));
  await fs.writeFile(latestPath, latestBytes, { mode: 0o600 });
  await fs.writeFile(oldPath, encrypted(gzipSync(Buffer.from('fixture old backup'))), {
    mode: 0o600,
  });
  await fs.utimes(oldPath, new Date(now - 37 * DAY), new Date(now - 37 * DAY));
  await fs.writeFile(legacyPath, encrypted(Buffer.from('PGDMP fixture legacy snapshot')), {
    mode: 0o600,
  });
  await fs.utimes(legacyPath, new Date(now - 38 * DAY), new Date(now - 38 * DAY));
  const run = (dryRun = false) =>
    confirmBackupPurge(pool, config, runtime, 'privacy.operator', {
      dryRun,
      requestId: request.id,
    });
  const receiptState = async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/privacy-receipts/' + receipt,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  await t.test(
    'actual old rotating and legacy files block a due request and keep anonymous receipt pending',
    async () => {
      const r = await run();
      assert.equal(r.results[0].state, 'PENDING');
      assert.ok(r.results[0].reasons.some((s: string) => s.includes(oldPath)));
      assert.ok(r.results[0].reasons.some((s: string) => s.includes(legacyPath)));
      const view = await receiptState();
      assert.equal(view.backupStatus, 'PENDING');
      assert.equal(view.userId, undefined);
      assert.equal(view.familyId, undefined);
      assert.equal(
        (await pool.query('SELECT completed_at FROM deletion_tombstones WHERE id=$1', [marker.id]))
          .rows[0].completed_at,
        null,
      );
    },
  );
  await t.test(
    'missing mandatory legacy directory is not treated as an empty trustworthy directory',
    async () => {
      await fs.rename(legacy, legacy + '-missing');
      const r = await run();
      assert.ok(r.results[0].reasons.some((x: string) => x.startsWith('DIRECTORY_MISSING:')));
      assert.equal(r.results[0].state, 'PENDING');
      await fs.rename(legacy + '-missing', legacy);
    },
  );
  await t.test(
    'corrupt latest AES-GCM backup cannot prove a working backup inventory',
    async () => {
      const bad = Buffer.from(latestBytes);
      bad[bad.length - 1] ^= 1;
      await fs.writeFile(latestPath, bad);
      const r = await run();
      assert.ok(r.results[0].reasons.includes('LATEST_BACKUP_AUTHENTICATION_FAILED'));
      await fs.writeFile(latestPath, latestBytes);
    },
  );
  await t.test(
    'partial files and symlinks block confirmation without following untrusted targets',
    async () => {
      const partial = path.join(rotating, 'unfinished.tgz.enc.partial');
      const link = path.join(legacy, 'symlink.enc');
      await fs.writeFile(partial, 'partial');
      await fs.symlink(latestPath, link);
      const r = await run();
      assert.ok(r.results[0].reasons.some((x: string) => x.startsWith('UNKNOWN_OR_PARTIAL_FILE:')));
      assert.ok(
        r.results[0].reasons.some((x: string) => x.startsWith('UNEXPECTED_STORAGE_ENTRY:')),
      );
      await fs.unlink(partial);
      await fs.unlink(link);
    },
  );
  await t.test(
    'after actual backup rotation an untracked or known old export still blocks completion',
    async () => {
      await fs.unlink(oldPath);
      await fs.unlink(legacyPath);
      const key = randomUUID() + '.zip';
      const filename = path.join(exports, key);
      await fs.writeFile(filename, 'fixture old export');
      await fs.utimes(filename, new Date(now - 37 * DAY), new Date(now - 37 * DAY));
      let r = await run();
      assert.ok(r.results[0].reasons.some((x: string) => x.startsWith('UNTRACKED_EXPORT_COPY:')));
      const other = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0];
      const ex = (
        await pool.query(
          `INSERT INTO privacy_requests(user_id,type,scope,status,due_at,requested_at,completed_at,export_object_key,export_expires_at) VALUES($1,'EXPORT','SELF_ACCOUNT','COMPLETED',now()-interval '36 days',now()-interval '39 days',now()-interval '38 days',$2,now()-interval '31 days') RETURNING id`,
          [other.id, key],
        )
      ).rows[0];
      r = await run();
      assert.ok(
        r.results[0].reasons.some((x: string) => x.startsWith('OLD_OR_EXPIRED_EXPORT_COPY:')),
      );
      await fs.unlink(filename);
      r = await run();
      assert.ok(r.results[0].reasons.includes('EXPORT_DATABASE_FILE_MISMATCH'));
      await pool.query('UPDATE privacy_requests SET export_object_key=NULL WHERE id=$1', [ex.id]);
    },
  );
  await t.test(
    'actual CLI check is read only and marks eligible without modifying tombstone',
    async () => {
      const result = await execute(
        process.execPath,
        [
          ...process.execArgv,
          path.join(projectRoot, 'apps/api/src/privacy/maintenance.ts'),
          'backup-check',
          '--config',
          configFile,
          '--operator',
          'privacy.operator',
          '--request-id',
          request.id,
        ],
        {
          env: { ...process.env, APP_ENV: 'test', PRIVACY_DATABASE_URL: databaseUrl },
          maxBuffer: 1024 * 1024,
        },
      );
      const report = JSON.parse(result.stdout);
      assert.equal(report.results[0].state, 'ELIGIBLE');
      assert.equal(
        (await pool.query('SELECT completed_at FROM deletion_tombstones WHERE id=$1', [marker.id]))
          .rows[0].completed_at,
        null,
      );
    },
  );
  await t.test(
    'confirmed complete requires the real clean inventory and updates the no-session receipt with 30-day retention',
    async () => {
      const r = await run();
      assert.equal(r.results[0].state, 'COMPLETED', JSON.stringify(r));
      const row = (await pool.query('SELECT * FROM deletion_tombstones WHERE id=$1', [marker.id]))
        .rows[0];
      assert.ok(row.completed_at);
      assert.ok(Math.abs((row.clear_after - row.completed_at) / DAY - 30) < 0.001);
      assert.equal((await receiptState()).backupStatus, 'COMPLETED');
      const events = (
        await pool.query(
          "SELECT details FROM audit_logs WHERE source_id=$1 AND action='BACKUP_PURGE_CONFIRMED'",
          [request.id],
        )
      ).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].details.operator, 'privacy.operator');
      assert.equal(events[0].details.verifiedLatestSha256.length, 64);
      assert.equal((await run()).results[0].state, 'ALREADY_COMPLETED');
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE source_id=$1 AND action='BACKUP_PURGE_CONFIRMED'",
            [request.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await t.test(
    'calendar elapsed is a hard prerequisite and cannot be supplied as a CLI clock override',
    async () => {
      const p = (
        await pool.query(
          `INSERT INTO privacy_requests(user_id,type,scope,status,outcome_code,due_at,completed_at) VALUES($1,'DELETE','SELF_ACCOUNT','COMPLETED','ONLINE_DELETION_COMPLETED',now(),now()-interval '34 days') RETURNING id`,
          [user.id],
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO deletion_tombstones(request_id,deleted_at,backup_purge_due_at,clear_after) VALUES($1,now()-interval '34 days',now()-interval '1 day',now()+interval '31 days')`,
        [p.id],
      );
      const r = await confirmBackupPurge(pool, config, runtime, 'privacy.operator', {
        requestId: p.id,
      });
      assert.equal(r.results[0].state, 'NOT_DUE');
      assert.throws(() =>
        validateMaintenanceConfig({ ...config, now: '2099-01-01T00:00:00Z' }, runtime),
      );
      assert.throws(() =>
        validateMaintenanceConfig(
          { ...config, backupDirectories: [config.backupDirectories[0]] },
          runtime,
        ),
      );
    },
  );
  await t.test(
    'support CLI records an accountable assignee/status, rejects stale updates and never changes PIN',
    async () => {
      const u = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0];
      await pool.query(
        "INSERT INTO pin_credentials(user_id,pin_hash,recovery_hash,enabled_at,recovery_blocked) VALUES($1,'fixture-secret-pin-hash','fixture-secret-recovery-hash',now(),true)",
        [u.id],
      );
      const p = (
        await pool.query(
          `INSERT INTO privacy_requests(user_id,type,scope,status,confirmation,user_visible_note,due_at) VALUES($1,'PIN_RECOVERY','PIN_SUPPORT','RECEIVED',$2,'收到支持申请',now()+interval '3 days') RETURNING id,version`,
          [u.id, JSON.stringify({ description: '恢复后无法通过验证，误填数字123456' })],
        )
      ).rows[0];
      const detail = await showSupportRequest(pool, p.id);
      assert.ok(!detail.description.includes('123456'));
      assert.equal(detail.confirmation, undefined);
      const initial = (await pool.query('SELECT * FROM pin_credentials WHERE user_id=$1', [u.id]))
        .rows[0];
      let changed = await updateSupportRequest(pool, {
        requestId: p.id,
        status: 'VERIFYING',
        expectedVersion: p.version,
        operator: 'operator.alice',
        note: '已受理，请通过独立支持渠道提交已有工单的验证资料。',
        evidenceReference: 'support/PJ-TEST',
      });
      assert.equal(changed.assignedOperator, 'operator.alice');
      assert.equal(changed.pinChanged, false);
      await assert.rejects(() =>
        updateSupportRequest(pool, {
          requestId: p.id,
          status: 'NEEDS_ACTION',
          expectedVersion: p.version,
          operator: 'operator.bob',
          note: '等待额外独立证明材料。',
        }),
      );
      changed = await updateSupportRequest(pool, {
        requestId: p.id,
        status: 'NEEDS_ACTION',
        expectedVersion: changed.version,
        operator: 'operator.bob',
        note: '当前证明不足，请补充经批准方案要求的独立证据。',
      });
      const list = await listSupportRequests(pool, { status: 'NEEDS_ACTION' });
      assert.equal(list.find((x: any) => x.id === p.id)?.assignedOperator, 'operator.bob');
      assert.ok(changed.assignedAt);
      assert.equal(
        new Date(changed.dueAt).getTime(),
        new Date(
          (await pool.query('SELECT due_at FROM privacy_requests WHERE id=$1', [p.id])).rows[0]
            .due_at,
        ).getTime(),
      );
      changed = await updateSupportRequest(pool, {
        requestId: p.id,
        status: 'REJECTED',
        expectedVersion: changed.version,
        operator: 'operator.bob',
        note: '无法取得充分的独立证明，本次不重置密码，账号继续保持锁定。',
      });
      assert.equal(changed.status, 'REJECTED');
      assert.deepEqual(
        (await pool.query('SELECT * FROM pin_credentials WHERE user_id=$1', [u.id])).rows[0],
        initial,
      );
      await assert.rejects(() =>
        updateSupportRequest(pool, {
          requestId: request.id,
          status: 'REJECTED',
          expectedVersion: 1,
          operator: 'operator.bob',
          note: '不能把隐私删除操作当成普通支持结单。',
        }),
      );
    },
  );
});
