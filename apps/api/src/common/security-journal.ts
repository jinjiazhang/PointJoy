import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { rows, canonical, type Services } from './index.js';
function encrypt(key: string, value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function decryptJournal(key: string, body: Buffer) {
  const cipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(key).digest(),
    body.subarray(0, 12),
  );
  cipher.setAuthTag(body.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(body.subarray(28)), cipher.final()]).toString('utf8'),
  );
}
export type JournalManifest = {
  version: 1;
  sealedAt: string;
  entries: { id: string; file: string; sha256: string }[];
  signature: string;
};
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
export function manifestSignature(key: string, manifest: Omit<JournalManifest, 'signature'>) {
  return createHmac('sha256', key).update(canonical(manifest)).digest('hex');
}
export async function verifyJournalManifest(
  directory: string,
  key: string,
): Promise<JournalManifest> {
  const manifest: JournalManifest = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  const { signature, ...unsigned } = manifest;
  const actual = Buffer.from(manifestSignature(key, unsigned), 'hex');
  const expected = Buffer.from(signature || '', 'hex');
  if (
    manifest.version !== 1 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error('JOURNAL_MANIFEST_INVALID');
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !/^[0-9a-f-]{36}\.enc$/.test(entry.file) ||
      entry.file !== entry.id + '.enc' ||
      seen.has(entry.id)
    ) {
      throw new Error('JOURNAL_MANIFEST_INVALID');
    }
    seen.add(entry.id);
    const body = await fs.readFile(path.join(directory, entry.file));
    if (digest(body) !== entry.sha256) {
      throw new Error('JOURNAL_FILE_MISMATCH');
    }
    const event = decryptJournal(key, body);
    if (event.id !== entry.id) {
      throw new Error('JOURNAL_ID_MISMATCH');
    }
  }
  return manifest;
}
async function durableWrite(dir: string, name: string, body: Buffer) {
  const temporary = path.join(dir, name + '.' + randomBytes(8).toString('hex') + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path.join(dir, name));
  const folder = await fs.open(dir, 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
export function securityJournal(services: Services) {
  let pending: Promise<void> | undefined;
  const flush = async () => {
    const hasPending = await services.pool.query(
      "SELECT 1 FROM outbox WHERE event_type='SECURITY_PROTECTION' AND status!='COMPLETED' LIMIT 1",
    );
    if (
      !hasPending.rowCount &&
      (await fs.stat(path.join(services.config.securityJournalDir, 'manifest.json')).then(
        () => true,
        () => false,
      ))
    ) {
      return;
    }
    const db = await services.pool.connect();
    try {
      await db.query('SELECT pg_advisory_lock(74321092)');
      const dir = services.config.securityJournalDir;
      const key = services.config.securityJournalKey;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      let entries: JournalManifest['entries'] = [];
      const manifestExists = await fs.stat(path.join(dir, 'manifest.json')).then(
        () => true,
        (e: any) => {
          if (e.code === 'ENOENT') {
            return false;
          }
          throw e;
        },
      );
      if (manifestExists) {
        entries = (await verifyJournalManifest(dir, key)).entries;
      } else {
        const files = (await fs.readdir(dir)).filter((x) => x.endsWith('.enc'));
        if (files.length && services.config.appEnv === 'production') {
          throw new Error('JOURNAL_MANIFEST_MISSING');
        }
        for (const file of files) {
          const body = await fs.readFile(path.join(dir, file));
          const event = decryptJournal(key, body);
          entries.push({ id: event.id, file, sha256: digest(body) });
        }
        const initial = { version: 1 as const, sealedAt: new Date().toISOString(), entries };
        await durableWrite(
          dir,
          'manifest.json',
          Buffer.from(JSON.stringify({ ...initial, signature: manifestSignature(key, initial) })),
        );
      }
      const byId = new Map(entries.map((e) => [e.id, e]));
      const events = await rows(
        db,
        "SELECT * FROM outbox WHERE event_type='SECURITY_PROTECTION' AND status!='COMPLETED' ORDER BY created_at,id LIMIT 500",
      );
      for (const event of events) {
        if (!byId.has(event.id)) {
          const file = event.id + '.enc';
          const body = encrypt(key, {
            id: event.id,
            createdAt: event.createdAt,
            payload: event.payload,
          });
          await durableWrite(dir, file, body);
          byId.set(event.id, { id: event.id, file, sha256: digest(body) });
        }
      }
      const unsigned = {
        version: 1 as const,
        sealedAt: new Date().toISOString(),
        entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      };
      await durableWrite(
        dir,
        'manifest.json',
        Buffer.from(JSON.stringify({ ...unsigned, signature: manifestSignature(key, unsigned) })),
      );
      if (events.length) {
        await db.query(
          "UPDATE outbox SET status='COMPLETED',completed_at=clock_timestamp(),locked_until=NULL WHERE id=ANY($1::uuid[])",
          [events.map((e) => e.id)],
        );
      }
      const left = await db.query(
        "SELECT 1 FROM outbox WHERE event_type='SECURITY_PROTECTION' AND status!='COMPLETED' LIMIT 1",
      );
      if (left.rowCount) {
        throw new Error('JOURNAL_PENDING');
      }
    } finally {
      try {
        await db.query('SELECT pg_advisory_unlock(74321092)');
      } finally {
        db.release();
      }
    }
  };
  return async () => {
    if (!pending) {
      pending = flush().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}
