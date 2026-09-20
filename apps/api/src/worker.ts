import { buildApp } from './main.js';
import { runMediaJobs } from './media/index.js';
import { runIdentityJobs } from './identity/index.js';
import { runFamilyJobs } from './family/index.js';
import { runPrivacyJobs } from './privacy/index.js';
import { runDomainJobs } from './domain/index.js';
const { app, services } = await buildApp();
await app.ready();
let stopping = false;
let lastMinute = 0;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}
while (!stopping) {
  const work: [string, () => Promise<any>][] = [
    ['media', () => runMediaJobs(services)],
    ['security', () => services.flushSecurityJournal()],
  ];
  if (Date.now() - lastMinute >= 30000) {
    lastMinute = Date.now();
    work.push(
      ['identity', () => runIdentityJobs(services)],
      ['domain', () => runDomainJobs(services)],
      ['family', () => runFamilyJobs(services)],
      ['privacy', () => runPrivacyJobs(services)],
    );
  }
  for (const [name, fn] of work) {
    try {
      await fn();
    } catch (error: any) {
      app.log.error({ job: name, errorCode: error.code || error.name }, 'Background job failed');
    }
  }
  if (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
await app.close();
