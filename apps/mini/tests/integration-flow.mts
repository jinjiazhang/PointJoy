import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { encodeMultipartImage } = createRequire(import.meta.url)(
  '../src/services/media-transport.ts',
);
const BASE = process.env.POINTJOY_TEST_API || 'http://127.0.0.1:4100/api/v1';
if (!['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname)) {
  throw new Error('This integration workflow only allows localhost');
}
let token = '';
let familyId = '';
let childId = '';
const key = () => randomUUID();
async function call<T = any>(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method: method === 'PATCH' ? 'POST' : method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': key(),
      ...(method === 'PATCH' ? { 'X-HTTP-Method-Override': 'PATCH' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const e = (await res.json()) as any;
  if (!res.ok || e.error) {
    throw new Error(`${method} ${path}: ${JSON.stringify(e.error)}`);
  }
  return e.data as T;
}
const accept = (x: any) => {
  token = x.accessToken;
  return x.session;
};
const f = (path = '') => `/families/${familyId}${path}`;
const c = (path = '') => f(`/children/${childId}${path}`);
const png = await readFile(new URL('./fixtures/avatar.png', import.meta.url));
async function upload(scope: any) {
  const i = await call('POST', '/media/upload-intents', {
    ...scope,
    filename: 'test-avatar.png',
    mime: 'image/png',
    sizeBytes: png.length,
  });
  assert.equal(i.uploadMethod, 'POST');
  const boundary = 'PointJoyIntegration' + key().replace(/-/g, '');
  const bytes = new Uint8Array(png).buffer;
  const body = encodeMultipartImage(bytes, 'image/png', boundary);
  const sent = await fetch(i.uploadUrl, {
    method: 'POST',
    headers: { ...i.requiredHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.ok(sent.ok);
  await call('POST', `/media/${i.mediaId}/finish`, {});
  for (let n = 0; n < 30; n++) {
    const m = await call('GET', `/media/${i.mediaId}`);
    if (m.status === 'READY') {
      return i.mediaId;
    }
    if (m.status === 'FAILED') {
      throw new Error('media processing failed ' + m.failureCode);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('media processing timeout');
}
const login = await call('POST', '/auth/wechat/login', {
  code: 'local:contracts-' + key(),
  loginAttemptId: key(),
});
assert.equal(accept(login).mode, 'PROFILE_ONLY');
const profile = await call('GET', '/me/profile');
const privacy = await call('GET', '/public/privacy');
const avatar = await upload({ purpose: 'USER_AVATAR' });
const saved = await call('PUT', '/me/profile', {
  displayName: '前端契约家长',
  avatarMediaId: avatar,
  privacyVersion: privacy.policyVersion,
  expectedVersion: profile.version,
});
assert.equal(saved.session.mode, 'ACCOUNT');
const created = await call('POST', '/families', { name: '前端契约测试家庭' });
familyId = created.family.id;
const contexts = await call('GET', '/me/contexts');
assert.ok(contexts.items.some((x: any) => x.contextId === created.contextId));
accept(await call('POST', '/auth/context', { contextId: created.contextId }));
const family = await call('GET', f());
await call('PATCH', f(), { name: '完整流程验证家庭', expectedVersion: family.family.version });
const childDraft = await call('POST', f('/child-drafts'), {});
const childAvatar = await upload({
  purpose: 'CHILD_AVATAR',
  familyId,
  childDraftId: childDraft.childDraftId,
});
const child = await call('POST', f('/children'), {
  childDraftId: childDraft.childDraftId,
  nickname: '测试小朋友',
  avatarMediaId: childAvatar,
  ageBand: 'OVER_12',
});
childId = child.id;
const plan = await call('POST', f('/plans'), {
  type: 'ROUTINE',
  title: '跳绳100次',
  description: '在安全场地完成',
  metric: 'COUNT',
  targetValue: 100,
  unit: 'REP',
  awardPoints: 30,
  childIds: [childId],
  weekdays: [1, 2, 3, 4, 5, 6, 7],
});
assert.equal(plan.draftVersion.title, '跳绳100次');
await call('POST', f(`/plans/${plan.id}/publish`), {
  expectedVersion: plan.version,
  startPolicy: 'TODAY',
});
const today = await call('GET', c('/today'));
assert.equal(today.routineProgress.expectedCount, 1);
const occurrence = today.routines[0];
let reward = await call('POST', f('/rewards'), {
  name: '游戏20分钟',
  category: 'TIME',
  benefitDescription: '和家长约定一次20分钟游戏时间',
  timeMinutes: 20,
  artKey: 'game',
  costPoints: 30,
  stockMode: 'UNLIMITED',
  weeklyLimit: null,
  childIds: [childId],
});
reward = await call('POST', f(`/rewards/${reward.id}/status`), {
  status: 'ACTIVE',
  expectedVersion: reward.version,
});
const enrolled = await call('POST', '/auth/pin/enroll', {
  pin: '827364',
  confirmationPin: '827364',
});
await call('POST', '/auth/pin/enroll/confirm', {
  enrollmentId: enrolled.enrollmentId,
  recoverySaved: true,
});
accept(await call('POST', '/auth/child-mode', { familyId, childId }));
const photo = await upload({
  purpose: 'COMPLETION_EVIDENCE',
  familyId,
  childId,
  occurrenceId: occurrence.id,
});
const draft = await call('PUT', f(`/occurrences/${occurrence.id}/draft`), {
  actualValue: 100,
  note: '我完成啦',
  mediaIds: [photo],
  expectedOccurrenceVersion: occurrence.version,
  expectedDraftVersion: 0,
});
const checkedDraft = await call('GET', f(`/occurrences/${occurrence.id}`));
assert.equal(checkedDraft.draft.mediaIds[0], photo);
await call('POST', f(`/occurrences/${occurrence.id}/submissions`), {
  actualValue: 100,
  note: '我完成啦',
  mediaIds: [photo],
  expectedVersion: draft.occurrenceVersion,
});
accept(await call('POST', '/auth/child-mode/exit', { pin: '827364' }));
const review = await call('GET', f(`/occurrences/${occurrence.id}`));
assert.equal(review.latestSubmission.media[0].status, 'READY');
await call('POST', f(`/occurrences/${occurrence.id}/review`), {
  decision: 'APPROVE',
  expectedVersion: review.version,
});
assert.equal((await call('GET', c('/account'))).availablePoints, 30);
accept(await call('POST', '/auth/child-mode', { familyId, childId }));
const availability = await call('GET', c(`/reward-availability/${reward.id}`));
assert.equal(availability.canRequest, true);
let order = await call('POST', c('/orders'), {
  rewardId: reward.id,
  expectedRewardVersion: availability.rewardVersion,
  expectedCostPoints: availability.costPoints,
});
assert.equal(order.account.availablePoints, 0);
assert.equal(order.account.heldPoints, 30);
const orderId = order.order.id;
accept(await call('POST', '/auth/child-mode/exit', { pin: '827364' }));
order = await call('POST', f(`/orders/${orderId}/approve`), {
  arrangementNote: '晚饭后一起安排',
  expectedVersion: order.order.version,
});
assert.equal(order.account.heldPoints, 0);
const fulfilled = await call('POST', f(`/orders/${orderId}/fulfill`), {
  note: '已完整提供20分钟',
  expectedVersion: order.order.version,
});
assert.equal(fulfilled.status, 'FULFILLED');
assert.ok(!fulfilled.allowedActions.includes('CANCEL'));
const account = await call('GET', c('/account'));
assert.deepEqual([account.availablePoints, account.heldPoints], [0, 0]);
const growth = await call('GET', c('/growth'));
assert.equal(growth.points.earned, 30);
assert.equal(growth.points.spent, 30);
console.log(
  JSON.stringify(
    {
      passed: true,
      flow: 'login → avatar → family → child → plan → photo draft → submit → PIN exit → approve → request → approve → fulfill',
      familyId,
      childId,
      occurrenceId: occurrence.id,
      orderId,
      balance: [account.availablePoints, account.heldPoints],
    },
    null,
    2,
  ),
);
