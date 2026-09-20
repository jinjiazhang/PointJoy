import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { rows, one, maybe, ok, audit, list, queueProtection } from '../common/index.js';
import type { Actor, Db, Services } from '../common/index.js';
import {
  digest,
  secret,
  fail,
  connection,
  validName,
  validReason,
  versionOf,
  publicProfile,
} from '../identity/index.js';
import { paging } from '../domain/support.js';
const uuid = z.string().uuid();
const version = z.number().int().positive();
const familyName = z
  .string()
  .trim()
  .refine((s) => [...s].length >= 2 && [...s].length <= 30, '家庭名称为2—30字');
const age = z.enum(['UNDER_4', 'AGE_4_6', 'AGE_7_9', 'AGE_10_12', 'OVER_12']);
const F = '/families/:f';
function ids(request: any) {
  return {
    familyId: uuid.parse(request.params.f),
    childId: request.params.c ? uuid.parse(request.params.c) : undefined,
  };
}
export function childView(c: any, guardian = true) {
  return {
    id: c.id,
    familyId: c.familyId,
    nickname: c.nickname,
    avatarMediaId: c.avatarMediaId,
    ageBand: c.ageBand,
    status: c.status,
    version: c.version,
    createdAt: c.createdAt,
    archivedAt: c.archivedAt,
    ...(guardian
      ? {
          boundUserId: c.boundUserId,
          bindingVersion: c.bindingVersion,
          bindingState: c.boundUserId ? 'BOUND' : 'UNBOUND',
        }
      : {}),
  };
}
function invitationView(i: any) {
  return {
    id: i.id,
    purpose: i.purpose,
    childId: i.childId,
    expiresAt: i.expiresAt,
    revokedAt: i.revokedAt,
    consumedAt: i.consumedAt,
    version: i.version,
    createdAt: i.createdAt,
    status: i.revokedAt
      ? 'REVOKED'
      : i.consumedAt
        ? 'CONSUMED'
        : new Date(i.expiresAt).getTime() <= Date.now()
          ? 'EXPIRED'
          : 'ACTIVE',
  };
}
function applicationView(a: any) {
  return {
    id: a.id,
    familyId: a.familyId,
    childId: a.childId,
    invitationId: a.invitationId,
    applicantProfile: a.applicantProfileSnapshot,
    status: a.status,
    reason: a.reason,
    version: a.version,
    createdAt: a.createdAt,
    decidedAt: a.decidedAt,
    syncProfile: a.syncProfile,
  };
}
async function page(
  db: Db,
  table: string,
  where: string,
  args: any[],
  query: any,
  transform = (x: any) => x,
) {
  const q = z
    .object({
      cursor: z.string().max(2000).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      status: z.string().optional(),
    })
    .passthrough()
    .parse(query);
  const p = paging(q, { table, where, args, status: q.status || null });
  let condition = where;
  if (q.status) {
    args.push(q.status);
    condition += ` AND status=$${args.length}`;
  }
  if (p.after) {
    args.push(p.after.createdAt, p.after.id);
    condition += ` AND (created_at,id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`;
  }
  args.push(p.limit + 1);
  const items = await rows(
    db,
    `SELECT * FROM ${table} WHERE ${condition} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`,
    args,
  );
  const result = p.result(items);
  return { ...result, items: result.items.map(transform) };
}
export async function familyContext(db: Db, actor: Actor, fid: string) {
  const family = await one(db, 'SELECT * FROM families WHERE id=$1', [fid]);
  const membership = await one(
    db,
    "SELECT id,version FROM guardian_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'",
    [fid, actor.userId],
  );
  return {
    family,
    membership: {
      ...membership,
      role: family.ownerMembershipId === membership.id ? 'OWNER' : 'GUARDIAN',
    },
    childrenSummary: (
      await rows(db, 'SELECT * FROM child_profiles WHERE family_id=$1 ORDER BY created_at,id', [
        fid,
      ])
    ).map((c) => childView(c)),
    capabilities:
      family.status === 'ACTIVE'
        ? ['VIEW', 'MANAGE_CHILDREN', 'ACTIVITIES', 'REWARDS']
        : ['VIEW_HISTORY'],
  };
}
export async function getArchiveBlockers(db: Db, familyId: string, childId?: string) {
  const values: any[] = [familyId];
  let condition = 'family_id=$1';
  if (childId) {
    values.push(childId);
    condition += ' AND child_id=$2';
  }
  const blockingOccurrences = await rows(
    db,
    `SELECT id,child_id,title_snapshot,status FROM activity_occurrences WHERE ${condition} AND status IN ('SUBMITTED','NEEDS_CHANGES') ORDER BY id`,
    values,
  );
  const blockingOrders = await rows(
    db,
    `SELECT id,child_id,status FROM redemption_orders WHERE ${condition} AND status IN ('PENDING_APPROVAL','READY') ORDER BY id`,
    values,
  );
  const accounts = await rows(
    db,
    `SELECT child_id,available_points,held_points,version FROM point_accounts WHERE ${condition} ORDER BY child_id`,
    values,
  );
  return {
    canArchive: blockingOccurrences.length === 0 && blockingOrders.length === 0,
    blockingOccurrences,
    blockingOrders,
    accounts,
    ...(childId ? { account: accounts[0] } : {}),
  };
}
export async function registerFamily(app: FastifyInstance, s: Services) {
  app.post('/families', async (request) => {
    const b = z.object({ name: familyName }).strict().parse(request.body);
    return s.mutate(request, { account: true }, async (db: Db, actor: Actor) => {
      const id = randomUUID();
      const mid = randomUUID();
      const family = await one(
        db,
        'INSERT INTO families(id,name,owner_membership_id) VALUES($1,$2,$3) RETURNING *',
        [id, b.name, mid],
      );
      await db.query('INSERT INTO guardian_memberships(id,family_id,user_id) VALUES($1,$2,$3)', [
        mid,
        id,
        actor.userId,
      ]);
      const context = await one(
        db,
        `INSERT INTO family_principals(family_id,user_id,kind,membership_id) VALUES($1,$2,'GUARDIAN',$3) RETURNING id`,
        [id, actor.userId, mid],
      );
      await audit(db, actor, 'FAMILY_CREATED', { familyId: id, sourceId: id });
      return {
        family,
        membership: { id: mid, role: 'OWNER', version: 1 },
        contextId: context.id,
        childrenSummary: [],
        capabilities: ['GUARDIAN'],
      };
    });
  });
  app.get(F, async (request) => {
    const { familyId } = ids(request);
    const actor = await s.auth.require(request, { familyId, guardian: true, allowArchived: true });
    return connection(s, async (db) => ok(request, await familyContext(db, actor, familyId)));
  });
  app.patch(F, async (request) => {
    const { familyId } = ids(request);
    const b = z.object({ name: familyName, expectedVersion: version }).strict().parse(request.body);
    return s.mutate(
      request,
      { familyId, owner: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        const f = await one(db, 'SELECT * FROM families WHERE id=$1', [familyId]);
        versionOf(f, b.expectedVersion);
        const result = await one(
          db,
          'UPDATE families SET name=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [familyId, b.name],
        );
        await audit(db, actor, 'FAMILY_UPDATED', { sourceId: familyId });
        return result;
      },
    );
  });
  app.post(`${F}/child-drafts`, async (request) => {
    const { familyId } = ids(request);
    return s.mutate(request, { familyId, guardian: true }, async (db: Db, actor: Actor) => {
      const d = await one(
        db,
        'INSERT INTO child_drafts(family_id,creator_user_id) VALUES($1,$2) RETURNING *',
        [familyId, actor.userId],
      );
      return { childDraftId: d.id, expiresAt: d.expiresAt };
    });
  });
  app.get(`${F}/children`, async (request) => {
    const { familyId } = ids(request);
    await s.auth.require(request, { familyId, guardian: true, allowArchived: true });
    return connection(s, async (db) =>
      ok(
        request,
        await page(db, 'child_profiles', 'family_id=$1', [familyId], request.query, (c) =>
          childView(c),
        ),
      ),
    );
  });
  app.post(`${F}/children`, async (request) => {
    const { familyId } = ids(request);
    const b = z
      .object({
        childDraftId: uuid,
        nickname: validName,
        avatarMediaId: uuid,
        ageBand: age.optional(),
      })
      .strict()
      .parse(request.body);
    return s.mutate(request, { familyId, guardian: true }, async (db: Db, actor: Actor) => {
      const d = await maybe(
        db,
        'SELECT * FROM child_drafts WHERE id=$1 AND family_id=$2 AND creator_user_id=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [b.childDraftId, familyId, actor.userId],
      );
      if (!d) {
        fail(409, 'INVALID_STATE', '新建孩子草稿已过期');
      }
      await s.media.childAvatar(db, actor, b.avatarMediaId, familyId, {
        childDraftId: b.childDraftId,
      });
      const child = await one(
        db,
        'INSERT INTO child_profiles(family_id,nickname,avatar_media_id,age_band) VALUES($1,$2,$3,$4) RETURNING *',
        [familyId, b.nickname, b.avatarMediaId, b.ageBand ?? null],
      );
      await db.query('UPDATE child_drafts SET consumed_at=now() WHERE id=$1', [d.id]);
      await db.query('UPDATE media_assets SET child_id=$2,retention_until=NULL WHERE id=$1', [
        b.avatarMediaId,
        child.id,
      ]);
      const account = await one(
        db,
        'INSERT INTO point_accounts(family_id,child_id) VALUES($1,$2) RETURNING *',
        [familyId, child.id],
      );
      await audit(db, actor, 'CHILD_CREATED', { childId: child.id, sourceId: child.id });
      return { ...childView(child), account };
    });
  });
  app.get(`${F}/children/:c`, async (request) => {
    const { familyId, childId } = ids(request);
    const actor = await s.auth.require(request, { familyId, childId, allowArchived: true });
    return connection(s, async (db) =>
      ok(
        request,
        childView(
          await one(db, 'SELECT * FROM child_profiles WHERE id=$1 AND family_id=$2', [
            childId,
            familyId,
          ]),
          actor.mode === 'GUARDIAN',
        ),
      ),
    );
  });
  app.patch(`${F}/children/:c`, async (request) => {
    const { familyId, childId } = ids(request);
    const b = z
      .object({
        nickname: validName.optional(),
        avatarMediaId: uuid.optional(),
        ageBand: age.nullable().optional(),
        expectedVersion: version,
      })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, childId, guardian: true },
      async (db: Db, actor: Actor) => {
        const c = await one(
          db,
          'SELECT * FROM child_profiles WHERE id=$1 AND family_id=$2 FOR UPDATE',
          [childId, familyId],
        );
        versionOf(c, b.expectedVersion);
        if (b.avatarMediaId) {
          await s.media.childAvatar(db, actor, b.avatarMediaId, familyId, { childId });
        }
        const result = await one(
          db,
          'UPDATE child_profiles SET nickname=$2,avatar_media_id=$3,age_band=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [
            childId,
            b.nickname ?? c.nickname,
            b.avatarMediaId ?? c.avatarMediaId,
            b.ageBand === undefined ? c.ageBand : b.ageBand,
          ],
        );
        if (b.avatarMediaId) {
          await db.query('UPDATE media_assets SET retention_until=NULL WHERE id=$1', [
            b.avatarMediaId,
          ]);
        }
        await audit(db, actor, 'CHILD_UPDATED', { childId, sourceId: childId });
        return childView(result);
      },
    );
  });
  app.get(`${F}/children/:c/archive-check`, async (request) => {
    const { familyId, childId } = ids(request);
    await s.auth.require(request, { familyId, childId, guardian: true });
    return connection(s, async (db) =>
      ok(request, {
        ...(await getArchiveBlockers(db, familyId, childId)),
        version: (await one(db, 'SELECT version FROM child_profiles WHERE id=$1', [childId]))
          .version,
      }),
    );
  });
  app.post(`${F}/children/:c/archive`, async (request) => {
    const { familyId, childId } = ids(request);
    const b = z
      .object({ expectedVersion: version, retainNonzeroBalanceConfirmed: z.boolean() })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, childId, guardian: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        const c = await one(db, 'SELECT * FROM child_profiles WHERE id=$1 FOR UPDATE', [childId]);
        versionOf(c, b.expectedVersion);
        const blockers = await getArchiveBlockers(db, familyId, childId);
        if (!blockers.canArchive) {
          fail(409, 'ARCHIVE_BLOCKED', '请先处理待审核活动和未完成兑换', blockers);
        }
        if (
          blockers.accounts.some((a) => a.availablePoints + a.heldPoints > 0) &&
          !b.retainNonzeroBalanceConfirmed
        ) {
          fail(409, 'CONFIRMATION_REQUIRED', '请确认非零积分将只读保留');
        }
        const child = await one(
          db,
          `UPDATE child_profiles SET status='ARCHIVED',archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [childId],
        );
        await db.query(
          `UPDATE auth_sessions SET revoked_at=now() WHERE child_id=$1 AND mode='CHILD' AND revoked_at IS NULL`,
          [childId],
        );
        await queueProtection(db, 'CHILD_ARCHIVED', {
          familyId,
          childId,
          bindingVersion: child.bindingVersion,
        });
        await audit(db, actor, 'CHILD_ARCHIVED', { childId, sourceId: childId });
        return childView(child);
      },
    );
  });
  app.get(`${F}/guardians`, async (request) => {
    const { familyId } = ids(request);
    await s.auth.require(request, { familyId, guardian: true, allowArchived: true });
    return connection(s, async (db) =>
      ok(
        request,
        list(
          await rows(
            db,
            `SELECT g.id,g.version,g.status,g.joined_at,u.display_name,u.avatar_media_id,jsonb_build_object('displayName',u.display_name,'avatarMediaId',u.avatar_media_id) AS user,CASE WHEN f.owner_membership_id=g.id THEN 'OWNER' ELSE 'GUARDIAN' END AS role FROM guardian_memberships g JOIN users u ON u.id=g.user_id JOIN families f ON f.id=g.family_id WHERE g.family_id=$1 AND g.status='ACTIVE' ORDER BY g.joined_at,g.id`,
            [familyId],
          ),
        ),
      ),
    );
  });
  const remove = async (
    db: Db,
    actor: Actor,
    familyId: string,
    mid: string,
    expected: number,
    reason: string,
  ) => {
    const family = await one(db, 'SELECT * FROM families WHERE id=$1', [familyId]);
    const m = await one(
      db,
      'SELECT * FROM guardian_memberships WHERE family_id=$1 AND id=$2 FOR UPDATE',
      [familyId, mid],
    );
    versionOf(m, expected);
    if (m.id === family.ownerMembershipId) {
      fail(409, 'OWNER_REQUIRED', '负责人需要先转让家庭');
    }
    if (m.status !== 'ACTIVE') {
      fail(409, 'INVALID_STATE', '家长已离开');
    }
    const result = await one(
      db,
      `UPDATE guardian_memberships SET status='REMOVED',removed_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
      [mid],
    );
    await db.query('DELETE FROM family_principals WHERE membership_id=$1', [mid]);
    await db.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE family_id=$1 AND user_id=$2 AND revoked_at IS NULL',
      [familyId, m.userId],
    );
    await queueProtection(db, 'MEMBERSHIP_REMOVED', {
      familyId,
      membershipId: mid,
      userId: m.userId,
      version: result.version,
    });
    await audit(db, actor, 'GUARDIAN_REMOVED', { sourceId: mid, details: { reason } });
    return { id: mid, status: result.status, version: result.version };
  };
  app.post(`${F}/guardians/:membershipId/remove`, async (request) => {
    const { familyId } = ids(request);
    const mid = uuid.parse((request.params as any).membershipId);
    const b = z
      .object({ expectedVersion: version, reason: validReason })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, owner: true, exclusiveFamily: true },
      (db: Db, actor: Actor) => remove(db, actor, familyId, mid, b.expectedVersion, b.reason),
    );
  });
  app.post(`${F}/leave`, async (request) => {
    const { familyId } = ids(request);
    const b = z.object({ expectedVersion: version }).strict().parse(request.body);
    return s.mutate(
      request,
      { familyId, guardian: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        await remove(db, actor, familyId, actor.membershipId!, b.expectedVersion, '本人退出家庭');
        return { left: true };
      },
    );
  });
  app.post(`${F}/ownership-transfer`, async (request) => {
    const { familyId } = ids(request);
    const b = z
      .object({
        newOwnerMembershipId: uuid,
        expectedVersion: version,
        stepUpToken: z.string().min(20),
      })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, owner: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        const f = await one(db, 'SELECT * FROM families WHERE id=$1', [familyId]);
        versionOf(f, b.expectedVersion);
        if (f.ownerMembershipId === b.newOwnerMembershipId) {
          fail(409, 'INVALID_STATE', '请选择另一位家长');
        }
        await one(
          db,
          `SELECT id FROM guardian_memberships WHERE id=$1 AND family_id=$2 AND status='ACTIVE'`,
          [b.newOwnerMembershipId, familyId],
        );
        await s.auth.consumeStepUp(db, actor, b.stepUpToken, 'OWNERSHIP_TRANSFER');
        const result = await one(
          db,
          'UPDATE families SET owner_membership_id=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [familyId, b.newOwnerMembershipId],
        );
        await queueProtection(db, 'OWNERSHIP_TRANSFERRED', {
          familyId,
          ownerMembershipId: b.newOwnerMembershipId,
          version: result.version,
        });
        await audit(db, actor, 'OWNERSHIP_TRANSFERRED', {
          sourceId: familyId,
          details: { newOwnerMembershipId: b.newOwnerMembershipId },
        });
        return result;
      },
    );
  });
  await registerInvitations(app, s);
  app.post(`${F}/children/:c/unbind`, async (request) => {
    const { familyId, childId } = ids(request);
    const b = z
      .object({
        expectedBindingVersion: version,
        reason: validReason,
        stepUpToken: z.string().min(20),
      })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, childId, owner: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        const c = await one(db, 'SELECT * FROM child_profiles WHERE id=$1 FOR UPDATE', [childId]);
        if (c.bindingVersion !== b.expectedBindingVersion) {
          fail(409, 'VERSION_CONFLICT', '绑定状态已变化');
        }
        if (!c.boundUserId) {
          fail(409, 'INVALID_STATE', '这个孩子尚未绑定微信');
        }
        await s.auth.consumeStepUp(db, actor, b.stepUpToken, 'UNBIND_CHILD');
        await db.query('DELETE FROM family_principals WHERE family_id=$1 AND child_id=$2', [
          familyId,
          childId,
        ]);
        const result = await one(
          db,
          'UPDATE child_profiles SET bound_user_id=NULL,binding_version=binding_version+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [childId],
        );
        await db.query(
          `UPDATE auth_sessions SET revoked_at=now() WHERE child_id=$1 AND child_session_source='DIRECT' AND revoked_at IS NULL`,
          [childId],
        );
        await queueProtection(db, 'CHILD_UNBOUND', {
          familyId,
          childId,
          userId: c.boundUserId,
          bindingVersion: result.bindingVersion,
        });
        await audit(db, actor, 'CHILD_UNBOUND', {
          childId,
          sourceId: childId,
          details: { reason: b.reason },
        });
        return childView(result);
      },
    );
  });
  app.get(`${F}/archive-check`, async (request) => {
    const { familyId } = ids(request);
    await s.auth.require(request, { familyId, owner: true });
    return connection(s, async (db) =>
      ok(request, {
        ...(await getArchiveBlockers(db, familyId)),
        version: (await one(db, 'SELECT version FROM families WHERE id=$1', [familyId])).version,
      }),
    );
  });
  app.post(`${F}/archive`, async (request) => {
    const { familyId } = ids(request);
    const b = z
      .object({
        expectedVersion: version,
        retainLedgersConfirmed: z.literal(true),
        stepUpToken: z.string().min(20),
      })
      .strict()
      .parse(request.body);
    return s.mutate(
      request,
      { familyId, owner: true, exclusiveFamily: true },
      async (db: Db, actor: Actor) => {
        const f = await one(db, 'SELECT * FROM families WHERE id=$1', [familyId]);
        versionOf(f, b.expectedVersion);
        const blockers = await getArchiveBlockers(db, familyId);
        if (!blockers.canArchive) {
          fail(409, 'ARCHIVE_BLOCKED', '请先处理待办', blockers);
        }
        await s.auth.consumeStepUp(db, actor, b.stepUpToken, 'ARCHIVE_FAMILY');
        const result = await one(
          db,
          `UPDATE families SET status='ARCHIVED',archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [familyId],
        );
        await db.query(
          `UPDATE auth_sessions SET revoked_at=now() WHERE family_id=$1 AND mode='CHILD' AND revoked_at IS NULL`,
          [familyId],
        );
        await queueProtection(db, 'FAMILY_ARCHIVED', { familyId, version: result.version });
        await audit(db, actor, 'FAMILY_ARCHIVED', { sourceId: familyId });
        return result;
      },
    );
  });
}
async function registerInvitations(app: FastifyInstance, s: Services) {
  for (const childBinding of [false, true]) {
    const invitations = childBinding ? 'child_binding_invitations' : 'invitations';
    const applications = childBinding ? 'child_binding_applications' : 'join_applications';
    const familyInvitePath = childBinding
      ? `${F}/children/:c/binding-invitations`
      : `${F}/invitations`;
    const revokePath = childBinding
      ? `${F}/binding-invitations/:invitationId/revoke`
      : `${F}/invitations/:invitationId/revoke`;
    const applicationsPath = childBinding ? 'child-binding-applications' : 'join-applications';
    const previewPath = childBinding ? '/child-bindings/preview' : '/invitations/preview';
    const purpose = childBinding ? 'CHILD_BIND' : 'GUARDIAN_JOIN';
    app.post(familyInvitePath, async (request) => {
      const { familyId, childId } = ids(request);
      return s.mutate(request, { familyId, childId, owner: true }, async (db: Db, actor: Actor) => {
        if (childBinding) {
          const c = await one(
            db,
            'SELECT bound_user_id FROM child_profiles WHERE id=$1 FOR UPDATE',
            [childId],
          );
          if (c.boundUserId) {
            fail(409, 'ALREADY_BOUND', '孩子已有微信绑定，请先明确解除');
          }
        }
        const token = secret();
        const i = await one(
          db,
          childBinding
            ? `INSERT INTO ${invitations}(family_id,child_id,creator_membership_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') RETURNING *`
            : `INSERT INTO ${invitations}(family_id,creator_membership_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING *`,
          childBinding
            ? [familyId, childId, actor.membershipId, digest(token)]
            : [familyId, actor.membershipId, digest(token)],
        );
        await audit(db, actor, 'INVITATION_CREATED', {
          childId,
          sourceId: i.id,
          details: { purpose },
        });
        return { invitation: invitationView(i), purpose, token, expiresAt: i.expiresAt };
      });
    });
    app.get(familyInvitePath, async (request) => {
      const { familyId, childId } = ids(request);
      await s.auth.require(request, { familyId, childId, owner: true, allowArchived: true });
      return connection(s, async (db) =>
        ok(
          request,
          await page(
            db,
            `(SELECT i.*,CASE WHEN revoked_at IS NOT NULL THEN 'REVOKED' WHEN consumed_at IS NOT NULL THEN 'CONSUMED' WHEN expires_at<=now() THEN 'EXPIRED' ELSE 'ACTIVE' END AS status FROM ${invitations} i) invitation_rows`,
            childBinding ? 'family_id=$1 AND child_id=$2' : 'family_id=$1',
            childBinding ? [familyId, childId] : [familyId],
            request.query,
            invitationView,
          ),
        ),
      );
    });
    app.post(revokePath, async (request) => {
      const { familyId } = ids(request);
      const id = uuid.parse((request.params as any).invitationId);
      const b = z.object({ expectedVersion: version }).strict().parse(request.body);
      return s.mutate(request, { familyId, owner: true }, async (db: Db, actor: Actor) => {
        const i = await one(
          db,
          `SELECT * FROM ${invitations} WHERE id=$1 AND family_id=$2 FOR UPDATE`,
          [id, familyId],
        );
        versionOf(i, b.expectedVersion);
        if (i.consumedAt || i.revokedAt) {
          fail(409, 'INVALID_STATE', '邀请已结束');
        }
        const result = await one(
          db,
          `UPDATE ${invitations} SET revoked_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
          [id],
        );
        await db.query(
          `UPDATE ${applications} SET status='EXPIRED',reason='INVITATION_REVOKED',version=version+1,decided_at=now() WHERE invitation_id=$1 AND status='PENDING'`,
          [id],
        );
        await audit(db, actor, 'INVITATION_REVOKED', { sourceId: id, details: { purpose } });
        return invitationView(result);
      });
    });
    app.post(previewPath, async (request) => {
      const b = z
        .object({ token: z.string().min(20).max(100) })
        .strict()
        .parse(request.body);
      const actor = await s.auth.require(request, { account: true });
      return connection(s, async (db) => {
        const i = await maybe(
          db,
          `SELECT i.*,f.name AS family_name,f.status AS family_status${childBinding ? ',c.nickname AS child_nickname,c.bound_user_id,c.status AS child_status' : ''} FROM ${invitations} i JOIN families f ON f.id=i.family_id ${childBinding ? 'JOIN child_profiles c ON c.id=i.child_id' : ''} WHERE i.token_hash=$1`,
          [digest(b.token)],
        );
        if (
          !i ||
          i.revokedAt ||
          i.consumedAt ||
          new Date(i.expiresAt).getTime() <= Date.now() ||
          i.familyStatus !== 'ACTIVE' ||
          (childBinding && (i.boundUserId || i.childStatus !== 'ACTIVE'))
        ) {
          fail(410, 'INVITATION_EXPIRED', '邀请已过期、撤销或被使用');
        }
        const principal = await maybe(
          db,
          'SELECT id FROM family_principals WHERE family_id=$1 AND user_id=$2',
          [i.familyId, actor.userId],
        );
        return ok(request, {
          purpose,
          familyName: i.familyName,
          childNickname: i.childNickname,
          expiresAt: i.expiresAt,
          canApply: !principal,
          profileDisclosure: '提交后，此家庭负责人可查看你的头像和昵称并决定是否接受。',
        });
      });
    });
    app.post(`/${applicationsPath}`, async (request) => {
      const b = z
        .object({ token: z.string().min(20).max(100) })
        .strict()
        .parse(request.body);
      return s.mutate(request, { account: true }, async (db: Db, actor: Actor) => {
        const initial = await one(db, `SELECT * FROM ${invitations} WHERE token_hash=$1`, [
          digest(b.token),
        ]);
        await db.query('SELECT id FROM families WHERE id=$1 FOR SHARE', [initial.familyId]);
        const i = await one(db, `SELECT * FROM ${invitations} WHERE id=$1 FOR UPDATE`, [
          initial.id,
        ]);
        const f = await one(db, 'SELECT status FROM families WHERE id=$1', [i.familyId]);
        if (
          i.revokedAt ||
          i.consumedAt ||
          new Date(i.expiresAt).getTime() <= Date.now() ||
          f.status !== 'ACTIVE'
        ) {
          fail(410, 'INVITATION_EXPIRED', '邀请已过期、撤销或被使用');
        }
        if (childBinding) {
          const c = await one(db, 'SELECT status,bound_user_id FROM child_profiles WHERE id=$1', [
            i.childId,
          ]);
          if (c.status !== 'ACTIVE' || c.boundUserId) {
            fail(409, 'ALREADY_BOUND', '孩子已绑定或已归档');
          }
        }
        if (
          await maybe(db, 'SELECT id FROM family_principals WHERE family_id=$1 AND user_id=$2', [
            i.familyId,
            actor.userId,
          ])
        ) {
          fail(409, 'IDENTITY_CONFLICT', '你在这个家庭已有身份');
        }
        const old = await maybe(
          db,
          `SELECT * FROM ${applications} WHERE family_id=$1 AND applicant_user_id=$2 AND status='PENDING'`,
          [i.familyId, actor.userId],
        );
        if (old) {
          fail(409, 'APPLICATION_PENDING', '你已有待处理申请');
        }
        const profile = publicProfile(
          await one(db, 'SELECT * FROM users WHERE id=$1', [actor.userId]),
        );
        const a = await one(
          db,
          childBinding
            ? `INSERT INTO ${applications}(family_id,child_id,invitation_id,applicant_user_id,applicant_profile_snapshot) VALUES($1,$2,$3,$4,$5) RETURNING *`
            : `INSERT INTO ${applications}(family_id,invitation_id,applicant_user_id,applicant_profile_snapshot) VALUES($1,$2,$3,$4) RETURNING *`,
          childBinding
            ? [i.familyId, i.childId, i.id, actor.userId, JSON.stringify(profile)]
            : [i.familyId, i.id, actor.userId, JSON.stringify(profile)],
        );
        await audit(db, actor, 'APPLICATION_CREATED', {
          familyId: i.familyId,
          childId: i.childId,
          sourceId: a.id,
          details: { purpose },
        });
        return applicationView(a);
      });
    });
    app.get(`/me/${applicationsPath}`, async (request) => {
      const actor = await s.auth.require(request, { account: true });
      return connection(s, async (db) =>
        ok(
          request,
          await page(
            db,
            applications,
            'applicant_user_id=$1',
            [actor.userId],
            request.query,
            applicationView,
          ),
        ),
      );
    });
    app.post(`/${applicationsPath}/:a/withdraw`, async (request) => {
      const id = uuid.parse((request.params as any).a);
      const b = z.object({ expectedVersion: version }).strict().parse(request.body);
      return s.mutate(request, { account: true }, async (db: Db, actor: Actor) => {
        const a = await one(
          db,
          `SELECT * FROM ${applications} WHERE id=$1 AND applicant_user_id=$2 FOR UPDATE`,
          [id, actor.userId],
        );
        versionOf(a, b.expectedVersion);
        if (a.status !== 'PENDING') {
          fail(409, 'INVALID_STATE', '申请已处理');
        }
        return applicationView(
          await one(
            db,
            `UPDATE ${applications} SET status='WITHDRAWN',decided_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
            [id],
          ),
        );
      });
    });
    app.get(`${F}/${applicationsPath}`, async (request) => {
      const { familyId } = ids(request);
      await s.auth.require(request, { familyId, owner: true, allowArchived: true });
      return connection(s, async (db) =>
        ok(
          request,
          await page(db, applications, 'family_id=$1', [familyId], request.query, applicationView),
        ),
      );
    });
    app.post(`${F}/${applicationsPath}/:a/decision`, async (request) => {
      const { familyId } = ids(request);
      const id = uuid.parse((request.params as any).a);
      const b = z
        .object({
          decision: z.enum(['APPROVE', 'REJECT']),
          syncProfile: z.boolean().optional(),
          reason: validReason.optional(),
          expectedVersion: version,
        })
        .strict()
        .parse(request.body);
      if (b.decision === 'REJECT' && !b.reason) {
        fail(400, 'VALIDATION_ERROR', '请填写拒绝原因');
      }
      await s.auth.require(request, { familyId, owner: true });
      const applicantGate = await connection(s, (db) =>
        one(db, `SELECT applicant_user_id FROM ${applications} WHERE id=$1 AND family_id=$2`, [
          id,
          familyId,
        ]),
      );
      return s.mutate(
        request,
        {
          familyId,
          owner: true,
          exclusiveFamily: true,
          extraUserIds: [applicantGate.applicantUserId],
        },
        async (db: Db, actor: Actor) => {
          const initial = await one(
            db,
            `SELECT * FROM ${applications} WHERE id=$1 AND family_id=$2`,
            [id, familyId],
          );
          const i = await one(db, `SELECT * FROM ${invitations} WHERE id=$1 FOR UPDATE`, [
            initial.invitationId,
          ]);
          const a = await one(db, `SELECT * FROM ${applications} WHERE id=$1 FOR UPDATE`, [id]);
          versionOf(a, b.expectedVersion);
          if (a.status !== 'PENDING') {
            fail(409, 'INVALID_STATE', '申请已处理');
          }
          if (b.decision === 'APPROVE') {
            if (i.revokedAt || i.consumedAt || new Date(i.expiresAt).getTime() <= Date.now()) {
              fail(410, 'INVITATION_EXPIRED', '邀请已过期、撤销或被使用');
            }
            if (
              await maybe(
                db,
                'SELECT id FROM family_principals WHERE family_id=$1 AND user_id=$2',
                [familyId, a.applicantUserId],
              )
            ) {
              fail(409, 'IDENTITY_CONFLICT', '申请人在这个家庭已有身份');
            }
            const applicant = await one(
              db,
              `SELECT * FROM users WHERE id=$1 AND status='ACTIVE' AND profile_completed_at IS NOT NULL`,
              [a.applicantUserId],
            );
            if (childBinding) {
              const c = await one(
                db,
                'SELECT * FROM child_profiles WHERE id=$1 AND family_id=$2 FOR UPDATE',
                [a.childId, familyId],
              );
              if (c.boundUserId || c.status !== 'ACTIVE') {
                fail(409, 'ALREADY_BOUND', '孩子已绑定或已归档');
              }
              let avatar = c.avatarMediaId;
              if (b.syncProfile) {
                avatar = (
                  await s.media.deriveAvatar(
                    db,
                    actor,
                    a.applicantUserId,
                    familyId,
                    c.id,
                    applicant.avatarMediaId,
                  )
                ).id;
              }
              const bound = await one(
                db,
                'UPDATE child_profiles SET bound_user_id=$2,binding_version=binding_version+1,avatar_media_id=$3,nickname=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
                [
                  c.id,
                  a.applicantUserId,
                  avatar,
                  b.syncProfile ? applicant.displayName : c.nickname,
                ],
              );
              await db.query(
                `INSERT INTO family_principals(family_id,user_id,kind,child_id) VALUES($1,$2,'CHILD',$3)`,
                [familyId, a.applicantUserId, c.id],
              );
              await queueProtection(db, 'CHILD_BOUND', {
                familyId,
                childId: c.id,
                userId: a.applicantUserId,
                bindingVersion: bound.bindingVersion,
              });
            } else {
              const m = await one(
                db,
                `INSERT INTO guardian_memberships(family_id,user_id) VALUES($1,$2) ON CONFLICT(family_id,user_id) DO UPDATE SET status='ACTIVE',removed_at=NULL,version=guardian_memberships.version+1,joined_at=now() RETURNING *`,
                [familyId, a.applicantUserId],
              );
              await db.query(
                `INSERT INTO family_principals(family_id,user_id,kind,membership_id) VALUES($1,$2,'GUARDIAN',$3)`,
                [familyId, a.applicantUserId, m.id],
              );
              await queueProtection(db, 'MEMBERSHIP_ADDED', {
                familyId,
                userId: a.applicantUserId,
                membershipId: m.id,
                version: m.version,
              });
            }
            await db.query(
              `UPDATE ${invitations} SET consumed_at=now(),consumed_by_application_id=$2,version=version+1 WHERE id=$1`,
              [i.id, a.id],
            );
            await db.query(
              `UPDATE ${applications} SET status='EXPIRED',reason='INVITATION_CONSUMED',decided_at=now(),version=version+1 WHERE invitation_id=$1 AND id<>$2 AND status='PENDING'`,
              [i.id, a.id],
            );
          }
          const result = await one(
            db,
            `UPDATE ${applications} SET status=$2,reason=$3,decided_by_membership_id=$4,decided_at=now(),version=version+1${childBinding ? ',sync_profile=$5' : ''} WHERE id=$1 RETURNING *`,
            childBinding
              ? [
                  id,
                  b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
                  b.reason ?? null,
                  actor.membershipId,
                  !!b.syncProfile,
                ]
              : [
                  id,
                  b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
                  b.reason ?? null,
                  actor.membershipId,
                ],
          );
          await audit(db, actor, 'APPLICATION_DECIDED', {
            childId: a.childId,
            sourceId: id,
            details: { purpose, decision: b.decision, syncProfile: !!b.syncProfile },
          });
          return applicationView(result);
        },
      );
    });
  }
}
export async function runFamilyJobs(s: Services) {
  await connection(s, async (db) => {
    for (const [a, i] of [
      ['join_applications', 'invitations'],
      ['child_binding_applications', 'child_binding_invitations'],
    ]) {
      await db.query(
        `UPDATE ${a} a SET status='EXPIRED',reason='INVITATION_EXPIRED',decided_at=now(),version=a.version+1 FROM ${i} i WHERE a.invitation_id=i.id AND a.status='PENDING' AND (i.expires_at<=now() OR i.revoked_at IS NOT NULL OR i.consumed_at IS NOT NULL)`,
      );
    }
  });
}
