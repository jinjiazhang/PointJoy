import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256 } from './common/index.js';
import { loadConfig } from './common/config.js';
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7543021)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    for (const name of (await fs.readdir(directory)).filter((v) => v.endsWith('.sql')).sort()) {
      const sql = await fs.readFile(path.join(directory, name), 'utf8');
      const checksum = sha256(sql);
      const prior = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [
        name,
      ]);
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum changed: ${name}`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7543021)');
    client.release();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
