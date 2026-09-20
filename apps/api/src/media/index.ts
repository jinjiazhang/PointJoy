import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { rows, one, maybe, ok } from '../common/index.js';
import type { Actor, Db, Services } from '../common/index.js';
import { digest, secret, fail, connection, transaction } from '../identity/index.js';
const uuid = z.string().uuid();
const maxBytes = 10 * 1024 * 1024;
export function mediaView(m: any) {
  return {
    id: m.id,
    purpose: m.purpose,
    status: m.status,
    mime: m.status === 'READY' ? 'image/jpeg' : m.mime,
    width: m.width,
    height: m.height,
    sizeBytes: m.originalSize,
    retentionUntil: m.retentionUntil,
    failureCode: m.failureCode,
    version: m.version,
    createdAt: m.createdAt,
  };
}
function privatePath(s: Services, key: string) {
  if (!/^[a-z]+\/[a-zA-Z0-9.-]+$/.test(key)) {
    throw new Error('UNSAFE_MEDIA_KEY');
  }
  return join(s.config.mediaDir, key);
}
export class MediaService {
  constructor(private s: Services) {}
  async authorize(db: Db, actor: Actor, m: any, write = false) {
    if (m.purpose === 'USER_AVATAR') {
      if (actor.childSessionSource === 'DELEGATED') {
        fail(404, 'RESOURCE_NOT_FOUND', '图片不存在或无权访问');
      }
      if (m.uploaderUserId === actor.userId) {
        await this.s.auth.recheck(db, actor, { profile: false, account: true });
        return;
      }
      if (!write && actor.mode === 'GUARDIAN') {
        await this.s.auth.recheck(db, actor, {
          familyId: actor.familyId!,
          guardian: true,
          allowArchived: true,
        });
        const colleague = await maybe(
          db,
          `SELECT 1 FROM guardian_memberships g JOIN users u ON u.id=g.user_id WHERE g.family_id=$1 AND g.user_id=$2 AND g.status='ACTIVE' AND u.avatar_media_id=$3`,
          [actor.familyId, m.uploaderUserId, m.id],
        );
        if (colleague) {
          return;
        }
        if (actor.role !== 'OWNER') {
          fail(404, 'RESOURCE_NOT_FOUND', '图片不存在或无权访问');
        }
        const allowed = await maybe(
          db,
          `SELECT 1 FROM join_applications WHERE family_id=$1 AND status='PENDING' AND applicant_user_id=$2 AND applicant_profile_snapshot->>'avatarMediaId'=$3 UNION ALL SELECT 1 FROM child_binding_applications WHERE family_id=$1 AND status='PENDING' AND applicant_user_id=$2 AND applicant_profile_snapshot->>'avatarMediaId'=$3`,
          [actor.familyId, m.uploaderUserId, m.id],
        );
        if (allowed) {
          return;
        }
      }
      fail(404, 'RESOURCE_NOT_FOUND', '图片不存在或无权访问');
    }
    await this.s.auth.recheck(db, actor, {
      familyId: m.familyId,
      childId: m.childId || undefined,
      guardian: m.purpose === 'CHILD_AVATAR' && !m.childId,
      write,
      allowArchived: !write,
    });
    if (write && m.uploaderUserId !== actor.userId) {
      fail(403, 'FORBIDDEN', '只能处理自己上传的图片');
    }
    if (
      !write &&
      m.purpose === 'COMPLETION_EVIDENCE' &&
      m.uploaderUserId !== actor.userId &&
      !(await maybe(db, 'SELECT id FROM submission_media WHERE media_id=$1', [m.id]))
    ) {
      fail(404, 'RESOURCE_NOT_FOUND', '图片尚未正式提交');
    }
    if (!write && m.childDraftId && !m.childId && m.uploaderUserId !== actor.userId) {
      fail(404, 'RESOURCE_NOT_FOUND', '图片不存在');
    }
  }
  async assertAttachable(
    db: Db,
    actor: Actor,
    input: { familyId: string; childId: string; occurrenceId: string; mediaIds: string[] },
  ) {
    await this.s.auth.recheck(db, actor, {
      familyId: input.familyId,
      childId: input.childId,
      write: true,
    });
    if (input.mediaIds.length > 3 || new Set(input.mediaIds).size !== input.mediaIds.length) {
      fail(400, 'VALIDATION_ERROR', '最多选择三张不同照片');
    }
    const found = await rows(
      db,
      'SELECT * FROM media_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [input.mediaIds],
    );
    if (found.length !== input.mediaIds.length) {
      fail(409, 'MEDIA_NOT_READY', '部分照片已不可用，请重新选择');
    }
    for (const m of found) {
      if (
        m.purpose !== 'COMPLETION_EVIDENCE' ||
        m.familyId !== input.familyId ||
        m.childId !== input.childId ||
        m.occurrenceId !== input.occurrenceId
      ) {
        fail(409, 'MEDIA_SCOPE_MISMATCH', '照片只能用于对应孩子的这次活动');
      }
      if (
        m.uploaderUserId !== actor.userId &&
        !(await maybe(
          db,
          'SELECT id FROM submission_media WHERE media_id=$1 AND occurrence_id=$2',
          [m.id, input.occurrenceId],
        ))
      ) {
        fail(409, 'MEDIA_SCOPE_MISMATCH', '请使用本人上传或这次活动已正式提交的照片');
      }
      if (
        m.status !== 'READY' ||
        (m.retentionUntil && new Date(m.retentionUntil).getTime() <= Date.now())
      ) {
        fail(409, 'MEDIA_NOT_READY', '请等待照片处理完成或重新上传');
      }
    }
    return found;
  }
  async linkSubmission(db: Db, actor: Actor, input: any) {
    await this.assertAttachable(db, actor, input);
    for (let i = 0; i < input.mediaIds.length; i++) {
      const id = input.mediaIds[i];
      await db.query(
        `UPDATE media_assets SET first_submitted_at=COALESCE(first_submitted_at,$2),retention_until=CASE WHEN first_submitted_at IS NULL THEN $2::timestamptz+interval '180 days' ELSE retention_until END,updated_at=now() WHERE id=$1`,
        [id, input.submittedAt],
      );
      await db.query(
        'INSERT INTO submission_media(family_id,child_id,occurrence_id,submission_id,media_id,sort_order) VALUES($1,$2,$3,$4,$5,$6)',
        [input.familyId, input.childId, input.occurrenceId, input.submissionId, id, i],
      );
    }
  }
  async childAvatar(
    db: Db,
    actor: Actor,
    id: string,
    familyId: string,
    target: { childId?: string; childDraftId?: string },
  ) {
    const m = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id]);
    if (
      m.status !== 'READY' ||
      m.purpose !== 'CHILD_AVATAR' ||
      m.familyId !== familyId ||
      m.uploaderUserId !== actor.userId ||
      (target.childId && m.childId !== target.childId) ||
      (target.childDraftId && m.childDraftId !== target.childDraftId)
    ) {
      fail(409, 'MEDIA_SCOPE_MISMATCH', '请选择为这个孩子上传并处理完成的头像');
    }
    return m;
  }
  async deriveAvatar(
    db: Db,
    actor: Actor,
    userId: string,
    familyId: string,
    childId: string,
    mediaId: string,
  ) {
    const source = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [mediaId]);
    if (
      source.uploaderUserId !== userId ||
      source.purpose !== 'USER_AVATAR' ||
      source.status !== 'READY'
    ) {
      fail(409, 'MEDIA_NOT_READY', '申请人的头像已不可用，请重新申请');
    }
    const derivative = await one(
      db,
      `INSERT INTO media_assets(uploader_user_id,family_id,child_id,purpose,status,object_key,original_size,mime,width,height,source_media_id,ready_at) VALUES($1,$2,$3,'CHILD_AVATAR','READY',$4,$5,'image/jpeg',$6,$7,$8,now()) RETURNING *`,
      [
        actor.userId,
        familyId,
        childId,
        source.objectKey,
        source.originalSize,
        source.width,
        source.height,
        source.id,
      ],
    );
    return derivative;
  }
}
export const createMedia = (s: Services) => new MediaService(s);
export async function registerMedia(app: FastifyInstance, s: Services) {
  await Promise.all(
    ['incoming', 'original', 'processed'].map((x) =>
      mkdir(join(s.config.mediaDir, x), { recursive: true, mode: 0o700 }),
    ),
  );
  app.post('/media/upload-intents', async (request) => {
    const b = z
      .object({
        purpose: z.enum(['USER_AVATAR', 'CHILD_AVATAR', 'COMPLETION_EVIDENCE']),
        filename: z.string().min(1).max(255),
        mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        sizeBytes: z.number().int().positive().max(maxBytes),
        familyId: uuid.optional(),
        childId: uuid.optional(),
        childDraftId: uuid.optional(),
        occurrenceId: uuid.optional(),
        crop: z
          .object({
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    if (
      b.purpose === 'USER_AVATAR' &&
      (b.familyId || b.childId || b.childDraftId || b.occurrenceId)
    ) {
      fail(400, 'VALIDATION_ERROR', '本人头像不使用家庭范围');
    }
    if (b.purpose !== 'USER_AVATAR' && !b.familyId) {
      fail(400, 'VALIDATION_ERROR', '请选择家庭');
    }
    if (b.purpose === 'CHILD_AVATAR' && (!b.childId === !b.childDraftId || b.occurrenceId)) {
      fail(400, 'VALIDATION_ERROR', '请选择孩子或新建孩子草稿');
    }
    if (
      b.purpose === 'COMPLETION_EVIDENCE' &&
      (!b.childId || !b.occurrenceId || b.childDraftId || b.crop)
    ) {
      fail(400, 'VALIDATION_ERROR', '完成照片必须对应活动');
    }
    return s.mutate(
      request,
      {
        profile: b.purpose !== 'USER_AVATAR',
        account: b.purpose === 'USER_AVATAR',
        familyId: b.familyId,
        childId: b.childId,
        guardian: b.purpose === 'CHILD_AVATAR',
      },
      async (db: Db, actor: Actor) => {
        if (b.childDraftId) {
          const draft = await maybe(
            db,
            'SELECT * FROM child_drafts WHERE id=$1 AND family_id=$2 AND creator_user_id=$3 AND consumed_at IS NULL AND expires_at>now()',
            [b.childDraftId, b.familyId, actor.userId],
          );
          if (!draft) {
            fail(409, 'INVALID_STATE', '新建档案已过期，请重新开始');
          }
        }
        if (b.occurrenceId) {
          const occurrence = await maybe(
            db,
            'SELECT id,status FROM activity_occurrences WHERE id=$1 AND family_id=$2 AND child_id=$3',
            [b.occurrenceId, b.familyId, b.childId],
          );
          if (!occurrence || !['OPEN', 'NEEDS_CHANGES'].includes(occurrence.status)) {
            fail(409, 'INVALID_STATE', '当前活动不能添加照片');
          }
        }
        const token = secret();
        const asset = await one(
          db,
          `INSERT INTO media_assets(uploader_user_id,family_id,child_id,child_draft_id,occurrence_id,purpose,mime,original_size,crop,upload_hash,upload_session_id,upload_expires_at,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '10 minutes',now()+interval '24 hours') RETURNING *`,
          [
            actor.userId,
            b.familyId ?? null,
            b.childId ?? null,
            b.childDraftId ?? null,
            b.occurrenceId ?? null,
            b.purpose,
            b.mime,
            b.sizeBytes,
            b.crop ? JSON.stringify(b.crop) : null,
            digest(token),
            actor.sessionId,
          ],
        );
        return {
          mediaId: asset.id,
          uploadUrl: `${s.config.apiBaseUrl}/media/uploads/${token}`,
          uploadMethod: 'POST',
          formFieldName: 'file',
          formData: {},
          requiredHeaders: {},
          expiresAt: asset.uploadExpiresAt,
          maxBytes,
        };
      },
    );
  });
  app.post('/media/uploads/:token', { bodyLimit: maxBytes + 65536 }, async (request) => {
    const token = z
      .string()
      .min(30)
      .max(100)
      .parse((request.params as any).token);
    const m = await connection(s, async (db) => {
      const asset = await maybe(
        db,
        'SELECT * FROM media_assets WHERE upload_hash=$1 AND upload_expires_at>now()',
        [digest(token)],
      );
      if (!asset || asset.status !== 'UPLOADING') {
        fail(410, 'UPLOAD_EXPIRED', '上传已过期，请重新选择照片');
      }
      const session = await one(db, 'SELECT * FROM auth_sessions WHERE id=$1', [
        asset.uploadSessionId,
      ]);
      await s.media.authorize(db, s.auth.actor(session), asset, true);
      return asset;
    });
    const tmp = privatePath(s, `incoming/${randomUUID()}`);
    let uploaded = false;
    try {
      const part = await (request as any).file({
        limits: { fileSize: maxBytes, files: 1, fields: 0 },
      });
      if (!part || part.fieldname !== 'file') {
        fail(400, 'VALIDATION_ERROR', '请上传一个图片文件');
      }
      await pipeline(part.file, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) {
        fail(413, 'MEDIA_TOO_LARGE', '图片不能超过10MiB');
      }
      const size = (await stat(tmp)).size;
      if (size !== m.originalSize) {
        fail(400, 'MEDIA_SIZE_MISMATCH', '图片大小已改变，请重新选择');
      }
      await transaction(s, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [m.uploaderUserId]);
        if (m.familyId) {
          await db.query('SELECT id FROM families WHERE id=$1 FOR SHARE', [m.familyId]);
        }
        const current = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [m.id]);
        if (current.status !== 'UPLOADING' || current.uploadedAt) {
          fail(409, 'UPLOAD_ALREADY_USED', '这次上传已完成');
        }
        const session = await one(db, 'SELECT * FROM auth_sessions WHERE id=$1', [
          current.uploadSessionId,
        ]);
        await s.media.authorize(db, s.auth.actor(session), current, true);
        const key = `original/${m.id}`;
        await rename(tmp, privatePath(s, key));
        uploaded = true;
        await db.query(
          `UPDATE media_assets SET original_object_key=$2,uploaded_at=now(),retention_until=now()+interval '24 hours',upload_hash=NULL,updated_at=now() WHERE id=$1`,
          [m.id, key],
        );
      });
      return ok(request, { uploaded: true, mediaId: m.id });
    } finally {
      if (!uploaded) {
        await unlink(tmp).catch(() => {});
      }
    }
  });
  async function ownAsset(request: any) {
    const actor = await s.auth.require(request, { profile: false });
    const m = await connection(s, async (db) => {
      const found = await one(db, 'SELECT * FROM media_assets WHERE id=$1', [
        uuid.parse(request.params.m),
      ]);
      await s.media.authorize(db, actor, found);
      return found;
    });
    return { actor, m };
  }
  app.get('/media/:m', async (request) => {
    const { m } = await ownAsset(request);
    return ok(request, mediaView(m));
  });
  for (const path of ['finish', 'retry-processing']) {
    app.post(`/media/:m/${path}`, async (request) => {
      const { m } = await ownAsset(request);
      return s.mutate(
        request,
        {
          profile: m.purpose !== 'USER_AVATAR',
          account: m.purpose === 'USER_AVATAR',
          familyId: m.familyId ?? undefined,
          childId: m.childId ?? undefined,
          status: 202,
        },
        async (db: Db, actor: Actor) => {
          const asset = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [m.id]);
          await s.media.authorize(db, actor, asset, true);
          if (path === 'finish' && ['PROCESSING', 'READY'].includes(asset.status)) {
            return mediaView(asset);
          }
          if (
            path === 'retry-processing' &&
            (asset.status !== 'FAILED' || asset.failureCode !== 'PROCESSING_FAILED')
          ) {
            fail(409, 'INVALID_STATE', '请换一张有效图片重新上传');
          }
          if (path === 'finish' && (asset.status !== 'UPLOADING' || !asset.uploadedAt)) {
            fail(409, 'UPLOAD_INCOMPLETE', '请先完成文件上传');
          }
          await db.query(
            `INSERT INTO media_jobs(media_id) VALUES($1) ON CONFLICT(media_id) DO UPDATE SET status='PENDING',attempts=0,next_attempt_at=now(),lease_until=NULL`,
            [asset.id],
          );
          return mediaView(
            await one(
              db,
              `UPDATE media_assets SET status='PROCESSING',failure_code=NULL,version=version+1 WHERE id=$1 RETURNING *`,
              [asset.id],
            ),
          );
        },
      );
    });
  }
  app.delete('/media/:m', async (request) => {
    const { m } = await ownAsset(request);
    return s.mutate(
      request,
      {
        profile: m.purpose !== 'USER_AVATAR',
        account: m.purpose === 'USER_AVATAR',
        familyId: m.familyId ?? undefined,
        childId: m.childId ?? undefined,
      },
      async (db: Db, actor: Actor) => {
        const asset = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [m.id]);
        await s.media.authorize(db, actor, asset, true);
        const linked = await maybe(
          db,
          'SELECT 1 FROM users WHERE avatar_media_id=$1 UNION ALL SELECT 1 FROM child_profiles WHERE avatar_media_id=$1 UNION ALL SELECT 1 FROM submission_media WHERE media_id=$1',
          [m.id],
        );
        if (linked) {
          fail(409, 'MEDIA_IN_USE', '已使用的图片按保留期限或隐私申请处理');
        }
        await db.query(
          `UPDATE media_assets SET status='DELETING',retention_until=now(),version=version+1 WHERE id=$1`,
          [m.id],
        );
        return { deleted: true };
      },
    );
  });
  app.post('/media/:m/read-grants', async (request) => {
    const { actor, m } = await ownAsset(request);
    if (m.status !== 'READY') {
      fail(410, 'MEDIA_EXPIRED', '图片已清理或尚未就绪');
    }
    const token = secret();
    await connection(s, (db) =>
      db.query(
        `INSERT INTO media_read_grants(token_hash,media_id,session_id,expires_at) VALUES($1,$2,$3,now()+interval '60 seconds')`,
        [digest(token), m.id, actor.sessionId],
      ),
    );
    return ok(request, {
      readUrl: `${s.config.apiBaseUrl}/media/content/${token}`,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  app.get('/media/content/:grant', async (request, reply) => {
    const key = await connection(s, async (db) => {
      const g = await maybe(
        db,
        'SELECT * FROM media_read_grants WHERE token_hash=$1 AND expires_at>now()',
        [
          digest(
            z
              .string()
              .min(30)
              .max(100)
              .parse((request.params as any).grant),
          ),
        ],
      );
      if (!g) {
        fail(410, 'MEDIA_EXPIRED', '图片链接已过期');
      }
      const session = await one(db, 'SELECT * FROM auth_sessions WHERE id=$1', [g.sessionId]);
      const m = await one(db, 'SELECT * FROM media_assets WHERE id=$1', [g.mediaId]);
      await s.media.authorize(db, s.auth.actor(session), m);
      if (
        m.status !== 'READY' ||
        (m.retentionUntil && new Date(m.retentionUntil).getTime() <= Date.now())
      ) {
        fail(410, 'MEDIA_EXPIRED', '图片已到保留期限');
      }
      return m.objectKey;
    });
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type('image/jpeg');
    return reply.send(createReadStream(privatePath(s, key)));
  });
}
async function processImage(s: Services, m: any) {
  return new Promise<any>((resolve) => {
    const worker = fork(
      new URL(
        existsSync(new URL('./processor.js', import.meta.url))
          ? './processor.js'
          : './processor.ts',
        import.meta.url,
      ),
      [],
      {
        execArgv: process.execArgv,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
        serialization: 'json',
      },
    );
    let finished = false;
    const done = (result: any) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      worker.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, code: 'PROCESSING_FAILED' }), 20000);
    worker.on('message', done);
    worker.on('error', () => done({ ok: false, code: 'PROCESSING_FAILED' }));
    worker.on('exit', () => done({ ok: false, code: 'PROCESSING_FAILED' }));
    worker.send({
      inputPath: privatePath(s, m.originalObjectKey),
      outputPath: privatePath(s, `processed/${m.id}.jpg`),
      purpose: m.purpose,
      crop: m.crop,
    });
  });
}
export async function runMediaJobs(s: Services) {
  const pending = await transaction(s, async (db) => {
    const jobs = await rows(
      db,
      `SELECT j.* FROM media_jobs j JOIN media_assets m ON m.id=j.media_id WHERE j.status IN ('PENDING','PROCESSING') AND j.next_attempt_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) AND m.status='PROCESSING' ORDER BY j.updated_at FOR UPDATE OF j SKIP LOCKED LIMIT 3`,
    );
    for (const j of jobs) {
      await db.query(
        `UPDATE media_jobs SET status='PROCESSING',attempts=attempts+1,lease_until=now()+interval '1 minute' WHERE media_id=$1`,
        [j.mediaId],
      );
    }
    return jobs;
  });
  for (const j of pending) {
    const m = await connection(s, (db) =>
      one(db, 'SELECT * FROM media_assets WHERE id=$1', [j.mediaId]),
    );
    const result = await processImage(s, m);
    await transaction(s, async (db) => {
      await db.query('SELECT id FROM media_assets WHERE id=$1 FOR UPDATE', [m.id]);
      if (result.ok) {
        await db.query(
          `UPDATE media_assets SET status='READY',object_key=$2,mime='image/jpeg',width=$3,height=$4,ready_at=now(),version=version+1 WHERE id=$1 AND status='PROCESSING'`,
          [m.id, `processed/${m.id}.jpg`, result.width, result.height],
        );
        await db.query(`UPDATE media_jobs SET status='DONE',lease_until=NULL WHERE media_id=$1`, [
          m.id,
        ]);
      } else {
        await db.query(
          `UPDATE media_assets SET status='FAILED',failure_code=$2,version=version+1 WHERE id=$1 AND status='PROCESSING'`,
          [m.id, result.code],
        );
        await db.query(
          `UPDATE media_jobs SET status='FAILED',last_error=$2,lease_until=NULL WHERE media_id=$1`,
          [m.id, result.code],
        );
      }
    });
    if (result.ok) {
      await unlink(privatePath(s, m.originalObjectKey)).catch(() => {});
      await connection(s, (db) =>
        db.query('UPDATE media_assets SET original_object_key=NULL WHERE id=$1', [m.id]),
      );
    }
  }
  const expired = await connection(s, (db) =>
    rows(
      db,
      `SELECT m.* FROM media_assets m WHERE m.status<>'DELETED' AND (m.status='DELETING' OR COALESCE(m.retention_until,m.created_at+interval '24 hours')<=now()) AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_media_id=m.id) AND NOT EXISTS(SELECT 1 FROM child_profiles c WHERE c.avatar_media_id=m.id) ORDER BY m.id LIMIT 100`,
    ),
  );
  for (const m of expired) {
    await transaction(s, async (db) => {
      const current = await one(db, 'SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [m.id]);
      const used = await maybe(
        db,
        'SELECT 1 FROM users WHERE avatar_media_id=$1 UNION ALL SELECT 1 FROM child_profiles WHERE avatar_media_id=$1',
        [m.id],
      );
      if (
        used ||
        (current.retentionUntil && new Date(current.retentionUntil).getTime() > Date.now())
      ) {
        return;
      }
      await db.query(
        `UPDATE media_assets SET status='DELETED',upload_hash=NULL,version=version+1 WHERE id=$1`,
        [m.id],
      );
      for (const key of [current.originalObjectKey, current.objectKey].filter(Boolean)) {
        const others = await maybe(
          db,
          `SELECT 1 FROM media_assets WHERE id<>$1 AND object_key=$2 AND status NOT IN ('DELETED','DELETING')`,
          [m.id, key],
        );
        if (!others) {
          await unlink(privatePath(s, key)).catch(() => {});
        }
      }
      await db.query('DELETE FROM media_read_grants WHERE media_id=$1', [m.id]);
    });
  }
  await connection(s, (db) => db.query('DELETE FROM media_read_grants WHERE expires_at<now()'));
}
