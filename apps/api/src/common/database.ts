import pg from 'pg';
import { AppError } from './errors.js';
import type { Db, Queryable } from './types.js';

function parseSafeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error('INTEGER_OVERFLOW');
  }
  return number;
}

// PostgreSQL int8 and numeric values must remain exact for points and versions.
pg.types.setTypeParser(20, parseSafeInteger);
pg.types.setTypeParser(1700, parseSafeInteger);
pg.types.setTypeParser(1082, (value) => value);

export function camel<T = any>(value: any): T {
  if (value instanceof Date) {
    return value.toISOString() as T;
  }
  if (Buffer.isBuffer(value)) {
    return value as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => camel(v)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        camel(v),
      ]),
    ) as T;
  }
  return value;
}

export async function rows<T = any>(db: Queryable, sql: string, values: any[] = []): Promise<T[]> {
  return camel((await db.query(sql, values)).rows);
}

export async function maybe<T = any>(
  db: Queryable,
  sql: string,
  values: any[] = [],
): Promise<T | null> {
  return (await rows<T>(db, sql, values))[0] ?? null;
}

export async function one<T = any>(db: Queryable, sql: string, values: any[] = []): Promise<T> {
  const r = await maybe<T>(db, sql, values);
  if (!r) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', '内容不存在或无权访问');
  }
  return r;
}

export async function transaction<T>(
  pool: pg.Pool,
  fn: (db: Db) => Promise<T>,
  isolation = 'READ COMMITTED',
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query(
      `BEGIN ISOLATION LEVEL ${isolation === 'REPEATABLE READ' ? 'REPEATABLE READ' : 'READ COMMITTED'}`,
    );
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
