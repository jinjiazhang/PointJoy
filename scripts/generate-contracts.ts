import fs from 'node:fs/promises';
import { buildApp } from '../apps/api/src/main.js';
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const id = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date' };
const time = { type: 'string', format: 'date-time' };
const num = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bool = { type: 'boolean' };
const e = (...values: string[]) => ({ type: 'string', enum: values });
const array = (items: any) => ({ type: 'array', items });
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const obj = (
  properties: Record<string, any>,
  required = Object.keys(properties),
  additionalProperties = false,
) => ({ type: 'object', properties, required, additionalProperties });
const text = str();
const version = { ...num, minimum: 1 };
const reason = { type: 'string', minLength: 1, maxLength: 200 };
const pin = { type: 'string', pattern: '^[0-9]{6}$' };
const ids = { ...array(id), minItems: 1, uniqueItems: true };
const photos = { ...array(id), maxItems: 3, uniqueItems: true };
const schemas: Record<string, any> = {
  Error: obj({
    error: obj(
      { code: text, message: text, details: { type: 'object', additionalProperties: true } },
      ['code', 'message'],
    ),
    requestId: id,
    serverTime: time,
  }),
  UserProfile: obj(
    {
      id,
      displayName: { type: 'string', minLength: 1, maxLength: 24 },
      avatarMediaId: id,
      profileCompletedAt: time,
      version,
    },
    ['id', 'displayName', 'version'],
  ),
  SessionView: obj(
    {
      sessionId: id,
      mode: e('PROFILE_ONLY', 'LOCKED', 'ACCOUNT', 'GUARDIAN', 'CHILD'),
      childSessionSource: e('DIRECT', 'DELEGATED'),
      familyId: id,
      childId: id,
      expiresAt: time,
      actorScopeKey: text,
      accountScopeKey: text,
      capabilities: array(text),
      profileRequired: bool,
      pinRequired: bool,
      pinEnabled: bool,
    },
    ['sessionId', 'mode', 'expiresAt', 'actorScopeKey', 'accountScopeKey'],
  ),
  SessionTokens: obj(
    {
      accessToken: text,
      refreshToken: text,
      expiresIn: num,
      session: ref('SessionView'),
      recoveryCode: text,
    },
    ['accessToken', 'refreshToken', 'expiresIn', 'session'],
  ),
  Family: obj(
    {
      id,
      name: text,
      status: e('ACTIVE', 'ARCHIVED', 'DELETING'),
      ownerMembershipId: id,
      version,
      createdAt: time,
      archivedAt: time,
    },
    ['id', 'name', 'status', 'version'],
  ),
  Guardian: obj(
    {
      id,
      role: e('OWNER', 'GUARDIAN'),
      version,
      status: e('ACTIVE', 'REMOVED'),
      displayName: text,
      avatarMediaId: id,
      joinedAt: time,
      user: ref('UserProfile'),
    },
    ['id', 'role', 'version'],
  ),
  ChildProfile: obj(
    {
      id,
      familyId: id,
      nickname: text,
      avatarMediaId: id,
      ageBand: e('UNDER_4', 'AGE_4_6', 'AGE_7_9', 'AGE_10_12', 'OVER_12'),
      status: e('ACTIVE', 'ARCHIVED'),
      bindingState: e('BOUND', 'UNBOUND'),
      bindingVersion: version,
      version,
      boundUserId: id,
      createdAt: time,
      archivedAt: time,
      account: ref('Account'),
    },
    ['id', 'familyId', 'nickname', 'avatarMediaId', 'status', 'version'],
  ),
  FamilyContext: obj(
    {
      family: ref('Family'),
      membership: ref('Guardian'),
      childrenSummary: array(ref('ChildProfile')),
      contextId: id,
      capabilities: array(text),
    },
    ['family', 'membership', 'childrenSummary'],
  ),
  AuthorizedContext: obj(
    {
      contextId: id,
      family: ref('Family'),
      relation: e('OWNER', 'GUARDIAN', 'CHILD'),
      child: ref('ChildProfile'),
      requiresPin: bool,
    },
    ['contextId', 'family', 'relation', 'requiresPin'],
  ),
  Account: obj(
    {
      familyId: id,
      childId: id,
      availablePoints: num,
      heldPoints: num,
      totalHeldPoints: num,
      version: num,
      grantBlockedByCap: bool,
      frozen: bool,
      freezeReason: text,
    },
    ['familyId', 'childId', 'availablePoints', 'heldPoints', 'version'],
  ),
  LedgerEntry: obj(
    {
      id,
      familyId: id,
      childId: id,
      type: e(
        'ACTIVITY_AWARD',
        'PRAISE',
        'AWARD_REVERSAL',
        'ORDER_HOLD',
        'ORDER_CAPTURE',
        'ORDER_RELEASE',
        'ORDER_REFUND',
      ),
      availableDelta: { type: 'integer' },
      heldDelta: { type: 'integer' },
      availableAfter: num,
      heldAfter: num,
      accountVersion: num,
      sourceType: text,
      sourceId: id,
      operatorSummary: obj({ name: text, mode: text }),
      reason: text,
      reversalOfId: id,
      createdAt: time,
    },
    [
      'id',
      'childId',
      'type',
      'availableDelta',
      'heldDelta',
      'availableAfter',
      'heldAfter',
      'accountVersion',
      'sourceType',
      'sourceId',
      'createdAt',
    ],
  ),
  MediaAsset: obj(
    {
      id,
      purpose: e('USER_AVATAR', 'CHILD_AVATAR', 'COMPLETION_EVIDENCE'),
      status: e('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETING', 'DELETED'),
      width: num,
      height: num,
      mime: text,
      sizeBytes: num,
      retentionUntil: time,
      failureCode: text,
      version,
    },
    ['id', 'purpose', 'status'],
  ),
  UploadIntent: obj({
    mediaId: id,
    uploadUrl: { type: 'string', format: 'uri' },
    uploadMethod: e('POST'),
    formFieldName: e('file'),
    formData: { type: 'object', additionalProperties: { type: 'string' } },
    requiredHeaders: { type: 'object', additionalProperties: { type: 'string' } },
    expiresAt: time,
    maxBytes: num,
  }),
  PlanInput: obj(
    {
      type: e('ROUTINE', 'CHALLENGE'),
      title: { type: 'string', minLength: 1, maxLength: 60 },
      description: text,
      metric: e('CHECK', 'COUNT', 'DURATION', 'DISTANCE'),
      targetValue: num,
      unit: e('REP', 'ITEM', 'MINUTE', 'METER'),
      awardPoints: { type: 'integer', minimum: 1, maximum: 1000 },
      childIds: ids,
      weekdays: {
        ...array({ type: 'integer', minimum: 1, maximum: 7 }),
        minItems: 1,
        uniqueItems: true,
      },
      startsAt: time,
      endsAt: time,
    },
    ['type', 'title', 'metric', 'awardPoints', 'childIds'],
  ),
  PlanVersion: obj(
    {
      id,
      revision: version,
      title: text,
      description: text,
      metric: e('CHECK', 'COUNT', 'DURATION', 'DISTANCE'),
      targetValue: num,
      unit: text,
      awardPoints: num,
      childIds: array(id),
      weekdays: array(num),
      startsAt: time,
      endsAt: time,
      effectiveFrom: time,
      effectiveTo: time,
      active: bool,
      publishedAt: time,
    },
    ['id', 'revision', 'title', 'metric', 'awardPoints', 'active'],
  ),
  ActivityPlan: obj(
    {
      id,
      familyId: id,
      type: e('ROUTINE', 'CHALLENGE'),
      lifecycle: e('DRAFT', 'PUBLISHED', 'STOPPED'),
      version,
      currentVersion: ref('PlanVersion'),
      scheduledVersion: ref('PlanVersion'),
      displayDescription: text,
      stoppedAt: time,
      applicableChildIds: array(id),
      createdAt: time,
    },
    ['id', 'type', 'lifecycle', 'version'],
  ),
  CompletionDraft: obj(
    { id, checked: bool, actualValue: num, note: text, mediaIds: photos, version, updatedAt: time },
    ['id', 'version'],
  ),
  Submission: obj(
    {
      id,
      sequence: version,
      checked: bool,
      actualValue: num,
      note: text,
      media: array(ref('MediaAsset')),
      actorMode: text,
      childSessionSource: e('DIRECT', 'DELEGATED'),
      submittedAt: time,
      completedAt: time,
      recordedAt: time,
      reviewHistory: array(ref('Decision')),
    },
    ['id', 'sequence', 'note', 'submittedAt', 'recordedAt'],
  ),
  Decision: obj(
    {
      id,
      action: e('APPROVE', 'RETURN', 'DIRECT_COMPLETE', 'EXEMPT', 'REVOKE'),
      reason: text,
      createdAt: time,
      operatorMembershipId: id,
    },
    ['id', 'action', 'createdAt'],
  ),
  Occurrence: obj(
    {
      id,
      planId: id,
      planVersionId: id,
      familyId: id,
      childId: id,
      type: e('ROUTINE', 'CHALLENGE'),
      businessDate: date,
      startsAt: time,
      endsAt: time,
      status: e('OPEN', 'SUBMITTED', 'NEEDS_CHANGES', 'APPROVED', 'EXEMPTED', 'REVOKED'),
      displayState: text,
      supplementUntil: time,
      snapshot: obj(
        {
          title: text,
          description: text,
          metric: e('CHECK', 'COUNT', 'DURATION', 'DISTANCE'),
          targetValue: num,
          unit: text,
          awardPoints: num,
        },
        ['title', 'metric', 'awardPoints'],
      ),
      latestSubmission: ref('Submission'),
      submissions: array(ref('Submission')),
      decisions: array(ref('Decision')),
      draft: ref('CompletionDraft'),
      allowedActions: array(text),
      version,
    },
    ['id', 'planId', 'childId', 'type', 'startsAt', 'endsAt', 'status', 'snapshot', 'version'],
  ),
  Progress: obj(
    { approved: num, total: num, exempted: num, completed: num, denominator: num, percentage: num },
    [],
    true,
  ),
  Today: obj({
    businessDate: date,
    account: ref('Account'),
    routines: array(ref('Occurrence')),
    challenges: array(ref('Occurrence')),
    routineProgress: ref('Progress'),
    asOf: time,
  }),
  RewardInput: obj(
    {
      name: text,
      description: text,
      category: e('TIME', 'FOOD', 'ITEM', 'EXPERIENCE'),
      benefitDescription: text,
      timeMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
      artKey: text,
      costPoints: { type: 'integer', minimum: 1, maximum: 100000 },
      stockMode: e('FINITE', 'UNLIMITED'),
      initialStock: { type: 'integer', minimum: 0, maximum: 1000000 },
      weeklyLimit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
      childIds: ids,
    },
    ['name', 'category', 'benefitDescription', 'artKey', 'costPoints', 'stockMode', 'childIds'],
  ),
  Reward: obj(
    {
      id,
      familyId: id,
      name: text,
      description: text,
      category: e('TIME', 'FOOD', 'ITEM', 'EXPERIENCE'),
      benefitDescription: text,
      timeMinutes: num,
      artKey: text,
      costPoints: num,
      stockMode: e('FINITE', 'UNLIMITED'),
      stockAvailable: { type: ['integer', 'null'] },
      stockVersion: num,
      weeklyLimit: { type: ['integer', 'null'] },
      status: e('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'),
      version,
      childIds: array(id),
      createdAt: time,
    },
    [
      'id',
      'name',
      'category',
      'benefitDescription',
      'costPoints',
      'stockMode',
      'status',
      'version',
    ],
  ),
  RewardAvailability: obj(
    {
      rewardId: id,
      rewardVersion: version,
      costPoints: num,
      applicable: bool,
      stockAvailable: { type: ['integer', 'null'] },
      weeklyRemaining: { type: ['integer', 'null'] },
      availablePoints: num,
      canRequest: bool,
      blockingReasons: array(text),
    },
    ['rewardId', 'costPoints', 'canRequest', 'blockingReasons'],
  ),
  RedemptionOrder: obj(
    {
      id,
      familyId: id,
      childId: id,
      rewardId: id,
      status: e('PENDING_APPROVAL', 'READY', 'FULFILLED', 'REJECTED', 'CANCELED', 'EXPIRED'),
      quantity: { const: 1 },
      costPointsSnapshot: num,
      rewardSnapshot: ref('Reward'),
      requestWeekStart: date,
      approvalExpiresAt: time,
      approvedAt: time,
      fulfilledAt: time,
      canceledAt: time,
      decisionReason: text,
      arrangementNote: text,
      allowedActions: array(text),
      version,
      createdAt: time,
    },
    [
      'id',
      'childId',
      'rewardId',
      'status',
      'costPointsSnapshot',
      'rewardSnapshot',
      'requestWeekStart',
      'approvalExpiresAt',
      'version',
    ],
  ),
  Invitation: obj(
    {
      id,
      purpose: e('GUARDIAN_JOIN', 'CHILD_BIND'),
      childId: id,
      status: e('ACTIVE', 'REVOKED', 'CONSUMED', 'EXPIRED'),
      expiresAt: time,
      revokedAt: time,
      consumedAt: time,
      version,
      createdAt: time,
    },
    ['id', 'purpose', 'status', 'expiresAt', 'version'],
  ),
  Application: obj(
    {
      id,
      familyId: id,
      childId: id,
      invitationId: id,
      applicantProfile: ref('UserProfile'),
      status: e('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'),
      reason: text,
      syncProfile: bool,
      version,
      createdAt: time,
      decidedAt: time,
    },
    ['id', 'familyId', 'status', 'version', 'createdAt'],
  ),
  PrivacyRequest: obj(
    {
      id,
      type: e('EXPORT', 'DELETE', 'PIN_RECOVERY'),
      scope: e('SELF_ACCOUNT', 'FAMILY', 'PIN_SUPPORT'),
      status: text,
      requestedAt: time,
      dueAt: time,
      assignedAt: time,
      completedAt: time,
      userVisibleNote: text,
      supportContact: text,
      outcomeCode: text,
      exportExpiresAt: time,
      downloadAvailable: bool,
      receiptToken: text,
      version,
    },
    ['id', 'type', 'scope', 'status', 'requestedAt'],
  ),
  PrivacyReceipt: obj(
    {
      type: e('EXPORT', 'DELETE', 'PIN_RECOVERY'),
      scope: e('SELF_ACCOUNT', 'FAMILY', 'PIN_SUPPORT'),
      status: text,
      requestedAt: time,
      onlineStatus: text,
      backupStatus: text,
      completedAt: time,
      userVisibleNote: text,
    },
    [],
    true,
  ),
  ReadGrant: obj({ readUrl: { type: 'string', format: 'uri' }, expiresAt: time }),
  ArchiveCheck: obj(
    {
      canArchive: bool,
      blockingOccurrences: array(ref('Occurrence')),
      blockingOrders: array(ref('RedemptionOrder')),
      account: ref('Account'),
      accounts: array(ref('Account')),
      version,
    },
    ['canArchive', 'blockingOccurrences', 'blockingOrders', 'version'],
  ),
  MutationResult: obj(
    {
      order: ref('RedemptionOrder'),
      occurrence: ref('Occurrence'),
      submission: ref('Submission'),
      account: ref('Account'),
      ledgerEntry: ref('LedgerEntry'),
      expired: bool,
      redacted: bool,
      reason: text,
    },
    [],
    true,
  ),
  Growth: obj(
    {
      dateFrom: date,
      dateTo: date,
      routine: ref('Progress'),
      challengeCounts: { type: 'object', additionalProperties: num },
      points: obj({ earned: num, spent: num, reversed: num, refunded: num }, [], true),
      days: array(obj({ businessDate: date, approved: num, total: num }, [], true)),
      asOf: time,
    },
    [],
    true,
  ),
  Dashboard: obj(
    {
      routineProgress: ref('Progress'),
      challengeCounts: { type: 'object', additionalProperties: num },
      pendingReviewCount: num,
      pendingApprovalCount: num,
      readyCount: num,
      childrenSummary: array(ref('ChildProfile')),
      asOf: time,
    },
    [],
    true,
  ),
  AuditEntry: obj(
    {
      id,
      action: text,
      childId: id,
      actorMode: text,
      sourceId: id,
      details: { type: 'object', additionalProperties: true },
      createdAt: time,
    },
    ['id', 'action', 'createdAt'],
  ),
  StockEntry: obj(
    {
      id,
      rewardId: id,
      type: e('INITIAL', 'ADJUSTMENT', 'RESERVE', 'RESTORE'),
      delta: { type: 'integer' },
      availableAfter: num,
      stockVersion: num,
      reason: text,
      orderId: id,
      createdAt: time,
    },
    ['id', 'type', 'delta', 'stockVersion', 'createdAt'],
  ),
};
const partial = (name: string, extra: any = {}) =>
  obj({ ...schemas[name].properties, ...extra }, Object.keys(extra));
const submit = obj(
  { checked: bool, actualValue: num, note: text, mediaIds: photos, expectedVersion: version },
  ['mediaIds', 'expectedVersion'],
);
function requestSchema(method: string, p: string): any {
  if (method === 'GET') {
    return null;
  }
  if (p === '/auth/wechat/login') {
    return obj({ code: text, loginAttemptId: id });
  }
  if (p === '/auth/refresh') {
    return obj({ refreshToken: text, refreshAttemptId: id });
  }
  if (p === '/me/profile') {
    return obj({
      displayName: text,
      avatarMediaId: id,
      privacyVersion: text,
      expectedVersion: version,
    });
  }
  if (p === '/auth/context') {
    return obj({ contextId: id });
  }
  if (p === '/auth/pin/enroll') {
    return obj({ pin, confirmationPin: pin });
  }
  if (p.endsWith('/enroll/confirm')) {
    return obj({ enrollmentId: id, recoverySaved: { const: true } });
  }
  if (p === '/auth/pin/unlock') {
    return obj({ pin, targetContextId: id }, ['pin']);
  }
  if (p === '/auth/pin/change') {
    return obj({ oldPin: pin, newPin: pin, confirmationPin: pin });
  }
  if (p === '/auth/pin/recover') {
    return obj({
      newWechatCode: text,
      recoveryCode: text,
      newPin: pin,
      confirmationPin: pin,
      recoveryAttemptId: id,
    });
  }
  if (p === '/auth/child-mode') {
    return obj({ familyId: id, childId: id });
  }
  if (p === '/auth/child-mode/exit') {
    return obj({ pin });
  }
  if (p === '/auth/step-up') {
    return obj(
      {
        pin,
        newWechatCode: text,
        action: e(
          'OWNERSHIP_TRANSFER',
          'UNBIND_CHILD',
          'ARCHIVE_FAMILY',
          'EXPORT_SELF',
          'DELETE_SELF',
          'EXPORT_FAMILY',
          'DELETE_FAMILY',
        ),
      },
      ['action'],
    );
  }
  if (p === '/media/upload-intents') {
    return obj(
      {
        purpose: e('USER_AVATAR', 'CHILD_AVATAR', 'COMPLETION_EVIDENCE'),
        filename: text,
        mime: e('image/jpeg', 'image/png', 'image/webp'),
        sizeBytes: { type: 'integer', minimum: 1, maximum: 10485760 },
        familyId: id,
        childId: id,
        childDraftId: id,
        occurrenceId: id,
        crop: obj({ x: num, y: num, width: version, height: version }),
      },
      ['purpose', 'filename', 'mime', 'sizeBytes'],
    );
  }
  if (p === '/families') {
    return obj({ name: text });
  }
  if (/^\/families\/\{familyId\}$/.test(p)) {
    return obj({ name: text, expectedVersion: version });
  }
  if (p.endsWith('/children')) {
    return obj(
      {
        childDraftId: id,
        nickname: text,
        avatarMediaId: id,
        ageBand: schemas.ChildProfile.properties.ageBand,
      },
      ['childDraftId', 'nickname', 'avatarMediaId'],
    );
  }
  if (/\/children\/\{childId\}$/.test(p)) {
    return obj(
      {
        nickname: text,
        avatarMediaId: id,
        ageBand: schemas.ChildProfile.properties.ageBand,
        expectedVersion: version,
      },
      ['expectedVersion'],
    );
  }
  if (p.endsWith('/unbind')) {
    return obj({ expectedBindingVersion: version, reason, stepUpToken: text });
  }
  if (p.endsWith('/ownership-transfer')) {
    return obj({ newOwnerMembershipId: id, expectedVersion: version, stepUpToken: text });
  }
  if (p.endsWith('/archive')) {
    return p.includes('/children/')
      ? obj({ expectedVersion: version, retainNonzeroBalanceConfirmed: bool })
      : obj({
          expectedVersion: version,
          retainLedgersConfirmed: { const: true },
          stepUpToken: text,
        });
  }
  if (p.endsWith('/remove')) {
    return obj({ expectedVersion: version, reason });
  }
  if (p.endsWith('/leave') || p.endsWith('/withdraw') || p.endsWith('/revoke')) {
    return obj({ expectedVersion: version });
  }
  if (p.endsWith('/preview') || p === '/join-applications' || p === '/child-binding-applications') {
    return obj({ token: text });
  }
  if (p.endsWith('/decision')) {
    return obj(
      { decision: e('APPROVE', 'REJECT'), syncProfile: bool, reason, expectedVersion: version },
      ['decision', 'expectedVersion'],
    );
  }
  if (p.endsWith('/plans')) {
    return ref('PlanInput');
  }
  if (/\/plans\/\{planId\}$/.test(p) || p.endsWith('/revisions')) {
    return partial('PlanInput', { expectedVersion: version });
  }
  if (p.endsWith('/publish')) {
    return obj({ startPolicy: e('TODAY', 'TOMORROW'), expectedVersion: version }, [
      'expectedVersion',
    ]);
  }
  if (p.endsWith('/pause') || p.endsWith('/resume')) {
    return obj({ expectedVersion: version });
  }
  if (p.endsWith('/stop') || p.endsWith('/exemption')) {
    return obj({ reason, expectedVersion: version });
  }
  if (p.endsWith('/copy')) {
    return obj({ newTitle: text, expectedVersion: version });
  }
  if (p.endsWith('/display-description')) {
    return obj({ description: text, expectedVersion: version });
  }
  if (p.endsWith('/draft')) {
    return obj(
      {
        checked: bool,
        actualValue: num,
        note: text,
        mediaIds: photos,
        expectedOccurrenceVersion: version,
        expectedDraftVersion: num,
      },
      ['expectedOccurrenceVersion', 'expectedDraftVersion'],
    );
  }
  if (p.endsWith('/submissions')) {
    return submit;
  }
  if (p.endsWith('/direct-completion')) {
    return obj({ ...submit.properties, completedAt: time }, [
      'mediaIds',
      'expectedVersion',
      'completedAt',
    ]);
  }
  if (p.endsWith('/review')) {
    return obj({ decision: e('APPROVE', 'RETURN'), reason, expectedVersion: version }, [
      'decision',
      'expectedVersion',
    ]);
  }
  if (p.endsWith('/praises')) {
    return obj({ points: { type: 'integer', minimum: 1, maximum: 1000 }, reason });
  }
  if (p.endsWith('/reversal')) {
    return obj({ reason, expectedAccountVersion: num });
  }
  if (p.endsWith('/rewards')) {
    return ref('RewardInput');
  }
  if (/\/rewards\/\{rewardId\}$/.test(p)) {
    return partial('RewardInput', { expectedVersion: version });
  }
  if (p.endsWith('/status')) {
    return obj({ status: e('ACTIVE', 'INACTIVE', 'ARCHIVED'), expectedVersion: version });
  }
  if (p.endsWith('/stock-adjustments')) {
    return obj({
      delta: { type: 'integer', not: { const: 0 } },
      reason,
      expectedStockVersion: num,
    });
  }
  if (p.endsWith('/wish')) {
    return method === 'DELETE'
      ? obj({ expectedVersion: version })
      : obj({ rewardId: id, expectedVersion: version }, ['rewardId']);
  }
  if (p.endsWith('/orders')) {
    return obj({ rewardId: id, expectedRewardVersion: version, expectedCostPoints: num });
  }
  if (p.endsWith('/approve')) {
    return obj({ arrangementNote: text, expectedVersion: version }, ['expectedVersion']);
  }
  if (p.endsWith('/reject')) {
    return obj({ reason, expectedVersion: version });
  }
  if (p.endsWith('/cancel')) {
    return obj({ reason, reasonCode: text, expectedVersion: version }, ['expectedVersion']);
  }
  if (p.endsWith('/fulfill')) {
    return obj({ note: text, expectedVersion: version }, ['expectedVersion']);
  }
  if (p.endsWith('/privacy-requests')) {
    return obj({
      type: e('EXPORT', 'DELETE'),
      scope: p.startsWith('/me/') ? e('SELF_ACCOUNT') : e('FAMILY'),
      confirmation: obj(
        {
          confirmed: { const: true },
          familyName: text,
          deleteNonzeroBalancesConfirmed: bool,
          deleteOwnChildSensitiveDataConfirmed: bool,
        },
        ['confirmed'],
      ),
      stepUpToken: text,
    });
  }
  if (p === '/support/pin-recovery-requests') {
    return obj(
      { description: { type: 'string', minLength: 5, maxLength: 500 }, contactChannel: text },
      ['description'],
    );
  }
  return obj({});
}
const page = (name: string) =>
  obj(
    {
      items: array(ref(name)),
      nextCursor: { type: ['string', 'null'] },
      hasMore: bool,
      totalCount: num,
    },
    ['items', 'nextCursor', 'hasMore'],
  );
function responseSchema(method: string, p: string): any {
  if (p.includes('/media/content/') || p.includes('/privacy-downloads/')) {
    return { type: 'string', format: 'binary' };
  }
  if (p === '/health') {
    return obj({ status: e('ok'), version: text });
  }
  if (p === '/public/privacy') {
    return obj({
      policyVersion: text,
      content: text,
      supportContact: text,
      mediaRetention: obj({ unsubmittedHours: num, submittedDays: num }),
    });
  }
  if (p === '/auth/logout') {
    return obj({ loggedOut: bool });
  }
  if (p === '/auth/pin/enroll') {
    return obj({ enrollmentId: id, recoveryCode: text, expiresAt: time });
  }
  if (p === '/auth/pin/enroll/confirm') {
    return obj({ pinEnabled: bool });
  }
  if (p === '/auth/step-up') {
    return obj({ stepUpToken: text, expiresAt: time });
  }
  if (p.endsWith('/child-drafts')) {
    return obj({ childDraftId: id, expiresAt: time });
  }
  if (p.endsWith('/remove')) {
    return obj({ id, status: e('REMOVED'), version });
  }
  if (p.endsWith('/leave')) {
    return obj({ left: bool });
  }
  if (p.endsWith('/ownership-transfer') || (p.endsWith('/archive') && !p.includes('/children/'))) {
    return ref('Family');
  }
  if (p.endsWith('/revoke')) {
    return ref('Invitation');
  }
  if (p.endsWith('/preview')) {
    return obj(
      {
        purpose: e('GUARDIAN_JOIN', 'CHILD_BIND'),
        familyName: text,
        childNickname: text,
        expiresAt: time,
        canApply: bool,
        profileDisclosure: text,
      },
      ['purpose', 'familyName', 'expiresAt', 'canApply'],
    );
  }
  if (p.endsWith('/schedule-preview')) {
    return obj({
      items: array(
        obj(
          {
            childId: id,
            nickname: text,
            businessDate: date,
            planVersionId: id,
            title: text,
            metric: text,
            targetValue: num,
            awardPoints: num,
            active: bool,
            startsAt: time,
            endsAt: time,
          },
          ['childId', 'businessDate', 'planVersionId', 'title', 'active'],
        ),
      ),
      preview: { const: true },
      dateFrom: date,
      dateTo: date,
    });
  }
  if (p.endsWith('/wish')) {
    const wish = obj({ id, familyId: id, childId: id, rewardId: id, version, selectedAt: time });
    return method === 'DELETE'
      ? obj({ cleared: bool })
      : method === 'PUT'
        ? wish
        : obj({
            wish: { anyOf: [wish, { type: 'null' }] },
            rewardSummary: { anyOf: [ref('Reward'), { type: 'null' }] },
            progress: { type: 'number', minimum: 0, maximum: 1 },
            pointsGap: num,
          });
  }
  if (p.endsWith('/todos')) {
    return obj({
      items: array({ oneOf: [ref('Occurrence'), ref('RedemptionOrder')] }),
      nextCursor: { type: ['string', 'null'] },
      hasMore: bool,
      totalCount: num,
    });
  }
  if (p.startsWith('/operations/')) {
    return obj(
      {
        state: e('SUCCEEDED', 'NOT_OBSERVED'),
        result: {
          oneOf: [
            ref('MutationResult'),
            ref('FamilyContext'),
            ref('ActivityPlan'),
            ref('ChildProfile'),
            ref('Reward'),
            ref('PrivacyRequest'),
          ],
        },
        statusCode: num,
        retryWithSameKey: bool,
      },
      ['state'],
    );
  }

  if (p === '/auth/session') {
    return ref('SessionView');
  }
  if (
    [
      '/auth/wechat/login',
      '/auth/refresh',
      '/auth/context',
      '/auth/pin/unlock',
      '/auth/pin/change',
      '/auth/pin/recover',
      '/auth/child-mode',
      '/auth/child-mode/exit',
    ].includes(p)
  ) {
    return ref('SessionTokens');
  }
  if (p === '/me/profile') {
    return method === 'GET'
      ? ref('UserProfile')
      : obj({ profile: ref('UserProfile'), session: ref('SessionView') });
  }
  if (p === '/me/contexts') {
    return page('AuthorizedContext');
  }
  if (p === '/media/upload-intents') {
    return ref('UploadIntent');
  }
  if (p.includes('/media/') && !p.includes('/content/')) {
    return p.endsWith('/read-grants') ? ref('ReadGrant') : ref('MediaAsset');
  }
  if (p.includes('/privacy-receipts/')) {
    return ref('PrivacyReceipt');
  }
  if (p.endsWith('/privacy-requests') || p.endsWith('/pin-recovery-requests')) {
    return method === 'GET' ? page('PrivacyRequest') : ref('PrivacyRequest');
  }
  if (p.includes('/privacy-requests/') || p.includes('/pin-recovery-requests/')) {
    return p.endsWith('/download-grant')
      ? obj({ downloadUrl: text, expiresAt: time })
      : ref('PrivacyRequest');
  }
  if (p.endsWith('/archive-check')) {
    return ref('ArchiveCheck');
  }
  if (p.endsWith('/dashboard')) {
    return ref('Dashboard');
  }
  if (p.endsWith('/today')) {
    return ref('Today');
  }
  if (p.endsWith('/growth')) {
    return ref('Growth');
  }
  if (p.endsWith('/account')) {
    return ref('Account');
  }
  if (p.endsWith('/ledger')) {
    return page('LedgerEntry');
  }
  if (p.endsWith('/stock-ledger')) {
    return page('StockEntry');
  }
  if (p.endsWith('/audit-logs')) {
    return page('AuditEntry');
  }
  if (p.includes('/reward-availability/')) {
    return ref('RewardAvailability');
  }
  if (p.endsWith('/children')) {
    return method === 'GET' ? page('ChildProfile') : ref('ChildProfile');
  }
  if (/\/children\/\{childId\}(\/unbind|\/archive)?$/.test(p)) {
    return ref('ChildProfile');
  }
  if (p.endsWith('/guardians')) {
    return page('Guardian');
  }
  if (p.endsWith('/plans')) {
    return method === 'GET' ? page('ActivityPlan') : ref('ActivityPlan');
  }
  if (p.endsWith('/versions')) {
    return page('PlanVersion');
  }
  if (p.endsWith('/occurrences') || p.endsWith('/history')) {
    return page('Occurrence');
  }
  if (p.includes('/plans/') && !p.endsWith('/schedule-preview')) {
    return ref('ActivityPlan');
  }
  if (p.includes('/occurrences/')) {
    return method === 'GET' ? ref('Occurrence') : ref('MutationResult');
  }
  if (p.endsWith('/rewards')) {
    return method === 'GET' ? page('Reward') : ref('Reward');
  }
  if (p.includes('/rewards/')) {
    return ref('Reward');
  }
  if (p.endsWith('/orders')) {
    return method === 'GET' ? page('RedemptionOrder') : ref('MutationResult');
  }
  if (p.includes('/orders/')) {
    return method === 'GET' || p.endsWith('/fulfill')
      ? ref('RedemptionOrder')
      : ref('MutationResult');
  }
  if (p.endsWith('/praises') || p.endsWith('/reversal')) {
    return ref('MutationResult');
  }
  if (p.endsWith('/invitations') || p.endsWith('/binding-invitations')) {
    return method === 'GET'
      ? page('Invitation')
      : obj({ invitation: ref('Invitation'), purpose: text, token: text, expiresAt: time });
  }
  if (p.includes('applications')) {
    return method === 'GET' ? page('Application') : ref('Application');
  }
  if (p === '/families' || /^\/families\/\{familyId\}$/.test(p)) {
    return method === 'PATCH' ? ref('Family') : ref('FamilyContext');
  }
  throw new Error('Unmapped response: ' + method + ' ' + p);
}
const { app, services } = await buildApp();
await app.ready();
const paths: Record<string, any> = {};
const names: Record<string, string> = {
  f: 'familyId',
  c: 'childId',
  p: 'planId',
  o: 'occurrenceId',
  r: 'rewardId',
  i: 'orderId',
  a: 'applicationId',
  m: 'mediaId',
};
for (const route of services.publicRoutes as { method: string; path: string }[]) {
  if (!route.path.startsWith('/api/v1/')) {
    continue;
  }
  const p = route.path
    .slice(7)
    .replace(/:([a-zA-Z]+)/g, (_, name) => '{' + (names[name] || name) + '}');
  const method = route.method.toLowerCase();
  const body = requestSchema(route.method, p);
  const schema = responseSchema(route.method, p);
  const isPublic =
    p === '/health' ||
    p.startsWith('/public/') ||
    p.startsWith('/privacy-receipts/') ||
    p === '/auth/wechat/login' ||
    p === '/auth/refresh';
  const credentialProtocol =
    p.startsWith('/auth/') ||
    p.endsWith('/read-grants') ||
    p.endsWith('/download-grant') ||
    p.endsWith('/preview') ||
    p.startsWith('/media/uploads/');
  const parameters: any[] = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: ['token', 'grant', 'key'].includes(m[1]) ? text : id,
  }));
  if (route.method !== 'GET' && !credentialProtocol) {
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: id });
  }
  if (method === 'patch') {
    parameters.push({
      name: 'X-HTTP-Method-Override',
      in: 'header',
      required: false,
      schema: { const: 'PATCH' },
      description:
        '微信客户端以POST发送并设置该头；服务端在路由匹配前还原PATCH，仍按PATCH保存幂等记录。',
    });
  }
  if (method === 'get' && schema.type === 'object' && schema.properties?.items) {
    parameters.push(
      { name: 'cursor', in: 'query', schema: text },
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    );
  }
  if (method === 'get' && p.includes('/families/')) {
    for (const name of [
      'childId',
      'status',
      'type',
      'dateFrom',
      'dateTo',
      'businessDate',
      'category',
      'lifecycle',
      'action',
    ]) {
      parameters.push({
        name,
        in: 'query',
        required: false,
        schema:
          name === 'childId'
            ? id
            : ['dateFrom', 'dateTo', 'businessDate'].includes(name)
              ? date
              : text,
      });
    }
  }
  if (p.startsWith('/operations/')) {
    parameters.push(
      { name: 'method', in: 'query', required: true, schema: e('POST', 'PUT', 'PATCH', 'DELETE') },
      { name: 'path', in: 'query', required: true, schema: text },
    );
  }
  const binary = p.includes('/media/content/') || p.includes('/privacy-downloads/');
  const operation: any = {
    operationId: method + '_' + p.replace(/[{}]/g, '').replace(/\//g, '_'),
    summary: route.method + ' ' + p,
    security: isPublic ? [] : [{ BearerAuth: [] }],
    parameters,
    responses: {
      '200': {
        description: '操作已完成，状态与积分以服务端结果为准',
        content: binary
          ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
          : {
              'application/json': {
                schema: obj({ data: schema, requestId: id, serverTime: time }),
              },
            },
      },
      '202': { description: '媒体/隐私异步处理中，或安全回执待确认' },
      default: {
        description: '错误码与恢复行为见06技术文档§5.4',
        content: { 'application/json': { schema: ref('Error') } },
      },
    },
  };
  if (body && !p.startsWith('/media/uploads/')) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: body } } };
  }
  if (p.startsWith('/media/uploads/')) {
    operation.requestBody = {
      required: true,
      content: {
        'multipart/form-data': { schema: obj({ file: { type: 'string', format: 'binary' } }) },
      },
    };
  }
  (paths[p] ??= {})[method] = operation;
}
const document = {
  openapi: '3.1.0',
  info: {
    title: 'PointJoy 家庭版 API',
    version: '1.0.0',
    description:
      '实际注册路由生成。请求和DTO模型与当前技术文档（06）配套；所有授权与参数边界由服务端执行。GET列表支持cursor/limit及文档中所列筛选；日期采用Asia/Shanghai。',
  },
  servers: [
    { url: 'https://pointjoy.jinjiazh.com/api/v1' },
    { url: 'http://127.0.0.1:4100/api/v1' },
  ],
  components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
  paths,
};
await fs.mkdir('packages/contracts', { recursive: true });
await fs.writeFile('packages/contracts/openapi.json', JSON.stringify(document, null, 2) + '\n');
await fs.writeFile(
  'packages/contracts/README.md',
  `# API 契约\n\n[openapi.json](openapi.json) 包含 ${Object.values(paths).reduce((n: any, v: any) => n + Object.keys(v).length, 0)} 个实际注册接口及 ${Object.keys(schemas).length} 个结构模型。\n\n生成：\`npx tsx scripts/generate-contracts.ts\`。完整业务语义、枚举约束和条件必填见 [技术规格](../../docs/06-技术文档.md)。微信不直接发送PATCH，使用POST方法覆写；鉴权、版本与幂等仍使用原PATCH语义。\n`,
);
console.log('Generated API contract:', Object.keys(paths).length, 'paths');
await app.close();
