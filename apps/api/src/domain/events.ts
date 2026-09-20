import { randomUUID } from 'node:crypto';
import { audit as appendAudit, outbox, type Actor, type Db } from '../common/index.js';

export async function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  input: {
    familyId?: string | null;
    childId?: string | null;
    sourceId?: string | null;
    details?: unknown;
  } = {},
) {
  await appendAudit(db, actor, action, input);
  // Private station views are rebuilt from domain facts; the outbox is a durable
  // change notification for cache invalidation and worker observability.
  await outbox(db, `domain:${randomUUID()}`, 'DOMAIN_CHANGED', {
    action,
    familyId: input.familyId ?? actor?.familyId ?? null,
    childId: input.childId ?? null,
    sourceId: input.sourceId ?? null,
  });
}
