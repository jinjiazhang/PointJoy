import pg from 'pg';
import { loadConfig } from './common/config.js';
import { recoverFromJournal } from './common/recovery.js';
import type { Services } from './common/index.js';

const args = process.argv.slice(2);
const index = args.indexOf('--operator');
const operator = index >= 0 ? args[index + 1] : undefined;
if (
  !operator ||
  operator.startsWith('--') ||
  args.some((v, i) => !['--operator', '--journal-custody-confirmed'].includes(v) && i !== index + 1)
) {
  throw new Error('Usage: recovery --operator NAME --journal-custody-confirmed');
}
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const report = await recoverFromJournal({ pool, config } as Services, {
    operator,
    journalCustodyConfirmed: args.includes('--journal-custody-confirmed'),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.safeToStart) {
    process.exitCode = 1;
  }
} catch (error: any) {
  process.stderr.write(
    JSON.stringify({ code: error.code || 'RECOVERY_FAILED', safeToStart: false }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
