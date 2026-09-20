import type { FastifyInstance } from 'fastify';
import type { Services } from '../common/index.js';
import { registerActivities, materialize } from './activities.js';
import { registerPoints, ensureChildAccount } from './points.js';
import { registerRewards, expireDueOrders } from './rewards.js';
import { registerGrowth, getBlockers } from './growth.js';
import {
  exportFamilyDomain,
  exportSubjectDomain,
  deleteFamilyDomain,
  anonymizeSubjectDomain,
} from './lifecycle.js';
export { runDomainJobs, reconcile, resolveIncidents } from './jobs.js';
export {
  materialize,
  ensureChildAccount,
  getBlockers,
  exportFamilyDomain,
  exportSubjectDomain,
  deleteFamilyDomain,
  anonymizeSubjectDomain,
};
export function createDomain(services: Services) {
  return {
    ensureChildAccount,
    getBlockers,
    exportFamilyDomain,
    exportSubjectDomain,
    deleteFamilyDomain,
    anonymizeSubjectDomain,
    materialize,
    expireDueOrders: () => expireDueOrders(services),
  };
}
export async function registerDomain(app: FastifyInstance, services: Services) {
  await registerActivities(app, services);
  await registerPoints(app, services);
  await registerRewards(app, services);
  await registerGrowth(app, services);
}
