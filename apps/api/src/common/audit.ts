import { randomUUID } from 'node:crypto';
import type { Actor, Db } from './types.js';

export async function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  input: {
    familyId?: string | null;
    childId?: string | null;
    sourceId?: string | null;
    details?: any;
  } = {},
) {
  await db.query(
    'INSERT INTO audit_logs (family_id,child_id,actor_user_id,actor_mode,action,source_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      input.familyId || actor?.familyId || null,
      input.childId || null,
      actor?.userId || null,
      actor?.mode || 'SYSTEM',
      action,
      input.sourceId || null,
      JSON.stringify(input.details || {}),
    ],
  );
}

export async function outbox(db: Db, eventKey: string, eventType: string, payload: any) {
  await db.query(
    'INSERT INTO outbox (event_key,event_type,payload) VALUES ($1,$2,$3) ON CONFLICT (event_key) DO NOTHING',
    [eventKey, eventType, JSON.stringify(payload)],
  );
}

export async function queueProtection(db: Db, kind: string, payload: any): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO outbox(id,event_key,event_type,payload) VALUES($1,$2,'SECURITY_PROTECTION',$3)",
    [id, `security:${id}`, JSON.stringify({ kind, ...payload })],
  );
  return id;
}
