export type SessionMode = 'PROFILE_ONLY' | 'LOCKED' | 'ACCOUNT' | 'GUARDIAN' | 'CHILD';
export interface SessionView {
  sessionId: string;
  mode: SessionMode;
  childSessionSource?: 'DIRECT' | 'DELEGATED';
  familyId?: string;
  childId?: string;
  expiresAt?: string;
  capabilities: string[];
  actorScopeKey: string;
  accountScopeKey: string;
  profileRequired?: boolean;
  pinRequired?: boolean;
  pinEnabled?: boolean;
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session: SessionView;
}
export interface Profile {
  id: string;
  displayName: string;
  avatarMediaId: string | null;
  profileCompletedAt: string | null;
  version: number;
}
export interface PageResult<T> {
  items: T[];
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount?: number;
}
export interface Family {
  id: string;
  name: string;
  status: string;
  version: number;
}
export interface Context {
  contextId: string;
  family: Family;
  relation: 'OWNER' | 'GUARDIAN' | 'CHILD';
  child?: Child;
  requiresPin: boolean;
}
export interface Account {
  childId: string;
  familyId: string;
  availablePoints: number;
  heldPoints: number;
  totalHeldPoints: number;
  version: number;
  frozen?: boolean;
  freezeReason?: string | null;
  grantBlockedByCap?: boolean;
}
export interface Child {
  id: string;
  familyId: string;
  nickname: string;
  avatarMediaId: string;
  ageBand?: string | null;
  status: string;
  bindingState?: string;
  bindingVersion: number;
  version: number;
  account?: Account;
  boundUser?: Profile;
}
export interface Guardian {
  id: string;
  membershipId?: string;
  displayName?: string;
  user?: Profile;
  role: string;
  version: number;
  createdAt?: string;
}
export interface FamilyContext {
  family: Family;
  membership: Guardian;
  childrenSummary: Child[];
  capabilities: string[];
}
export type Metric = 'CHECK' | 'COUNT' | 'DURATION' | 'DISTANCE';
export interface PlanInput {
  type: 'ROUTINE' | 'CHALLENGE';
  title: string;
  description?: string;
  metric: Metric;
  targetValue?: number;
  unit?: string;
  awardPoints: number;
  childIds: string[];
  weekdays?: number[];
  startsAt?: string;
  endsAt?: string;
}
export interface PlanVersion extends PlanInput {
  id?: string;
  revision: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  active: boolean;
}
export interface Plan {
  id: string;
  type: 'ROUTINE' | 'CHALLENGE';
  lifecycle: string;
  currentVersion?: PlanVersion;
  scheduledVersion?: PlanVersion;
  draftVersion?: PlanVersion;
  displayDescription?: string;
  stoppedAt?: string;
  version: number;
  applicableChildIds: string[];
  title?: string;
}
export interface MediaAsset {
  id: string;
  purpose: string;
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'DELETED';
  width?: number;
  height?: number;
  mime?: string;
  sizeBytes?: number;
  retentionUntil?: string;
  failureCode?: string;
}
export interface ReviewEvent {
  submissionId?: string;
  action?: string;
  id?: string;
  decision?: string;
  reason?: string;
  createdAt?: string;
  reviewedAt?: string;
  operatorSummary?: string | { displayName?: string };
  actor?: { displayName?: string };
}
export interface Submission {
  id: string;
  sequence: number;
  checked?: boolean;
  actualValue?: number;
  note: string;
  media: MediaAsset[];
  actorMode: string;
  childSessionSource?: string;
  submittedAt: string;
  completedAt?: string;
  recordedAt?: string;
  reviewHistory: ReviewEvent[];
}
export interface Draft {
  id?: string;
  version: number;
  checked?: boolean;
  actualValue?: number;
  note?: string;
  mediaIds?: string[];
  media?: MediaAsset[];
  updatedAt?: string;
}
export interface Occurrence {
  id: string;
  planId: string;
  childId: string;
  type: 'ROUTINE' | 'CHALLENGE';
  businessDate?: string;
  startsAt: string;
  endsAt: string;
  status: string;
  displayState: string;
  supplementUntil?: string;
  snapshot: {
    title: string;
    description?: string;
    metric: Metric;
    targetValue?: number;
    unit?: string;
    awardPoints: number;
  };
  latestSubmission?: Submission;
  submissions?: Submission[];
  reviewHistory?: ReviewEvent[];
  draft?: Draft;
  allowedActions: string[];
  version: number;
  child?: Child;
  childNickname?: string;
  ledgerEntryId?: string;
}
export interface Progress {
  approvedCount?: number;
  expectedCount?: number;
  exemptedCount?: number;
  rate?: number | null;
  approved?: number;
  required?: number;
  numerator?: number;
  denominator?: number;
  exempted?: number;
}
export interface Dashboard {
  routineProgress: Progress;
  challengeCounts: Record<string, number>;
  pendingReviewCount: number;
  pendingApprovalCount: number;
  readyCount: number;
  childrenSummary: Array<
    Child & { routineProgress?: Progress; pendingReviewCount?: number; availablePoints?: number }
  >;
  asOf: string;
}
export interface Today {
  businessDate: string;
  account: Account;
  routines: Occurrence[];
  challenges: Occurrence[];
  routineProgress: Progress;
  asOf: string;
}
export interface Reward {
  id: string;
  name: string;
  description?: string;
  category: 'TIME' | 'FOOD' | 'ITEM' | 'EXPERIENCE';
  benefitDescription: string;
  timeMinutes?: number | null;
  artKey: string;
  costPoints: number;
  stockMode: 'FINITE' | 'UNLIMITED';
  stockAvailable?: number | null;
  stockVersion: number;
  weeklyLimit?: number | null;
  status: string;
  version: number;
  childIds?: string[];
}
export interface Availability {
  rewardId: string;
  rewardVersion: number;
  costPoints: number;
  applicable: boolean;
  stockAvailable?: number;
  weeklyRemaining?: number;
  availablePoints: number;
  canRequest: boolean;
  blockingReasons: string[];
}
export interface Order {
  id: string;
  childId: string;
  rewardId: string;
  status: string;
  quantity: 1;
  costPointsSnapshot: number;
  rewardSnapshot: Partial<Reward>;
  requestWeekStart: string;
  approvalExpiresAt: string;
  createdAt?: string;
  approvedAt?: string;
  fulfilledAt?: string;
  canceledAt?: string;
  decisionReason?: string;
  arrangementNote?: string;
  fulfillmentNote?: string;
  allowedActions: string[];
  version: number;
  child?: Child;
  childNickname?: string;
  timeline?: ReviewEvent[];
}
export interface LedgerEntry {
  id: string;
  type: string;
  availableDelta: number;
  heldDelta: number;
  availableAfter: number;
  heldAfter: number;
  accountVersion: number;
  sourceType: string;
  sourceId: string;
  operatorSummary: string | { displayName?: string; name?: string };
  reason?: string;
  reversalOfId?: string;
  reversed?: boolean;
  createdAt: string;
}
export interface Wish {
  wish?: { id?: string; rewardId: string; version: number };
  rewardSummary?: Reward;
  progress: number;
  pointsGap: number;
}
export interface Application {
  id: string;
  status: string;
  version: number;
  createdAt?: string;
  reason?: string;
  applicant?: Profile;
  applicantProfile?: Profile;
  child?: Child;
  childNickname?: string;
  familyName?: string;
  purpose?: string;
}
export interface Invitation {
  id: string;
  status: string;
  version: number;
  expiresAt: string;
  purpose?: string;
  createdAt?: string;
  childId?: string;
}
export interface ArchiveCheck {
  canArchive: boolean;
  blockingOccurrences: Occurrence[];
  blockingOrders: Order[];
  account?: Account;
  version: number;
  accounts?: Account[];
}
export interface PrivacyRequest {
  id: string;
  type: string;
  scope: string;
  status: string;
  requestedAt: string;
  dueAt: string;
  userVisibleNote?: string;
  completedAt?: string;
  downloadAvailable?: boolean;
  exportExpiresAt?: string;
}
export interface AuditEntry {
  operatorName?: string;
  sourceId?: string;
  details?: { reason?: string };
  id: string;
  action: string;
  childId?: string;
  operatorSummary?: string | { displayName?: string };
  reason?: string;
  createdAt: string;
  requestId?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}
export interface Growth {
  points?: {
    earned: number;
    spent: number;
    reversed: number;
    refunded: number;
    netEarned: number;
    netSpent: number;
  };
  routineProgress?: Progress;
  challengeCounts?: Record<string, number>;
  earnedPoints?: number;
  spentPoints?: number;
  netEarnedPoints?: number;
  netSpentPoints?: number;
  [key: string]: unknown;
}
export interface UploadItem {
  localId: string;
  localPath?: string;
  name?: string;
  mime?: string;
  mediaId?: string;
  status: 'SELECTED' | 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'DELETED';
  progress: number;
  error?: string;
  asset?: MediaAsset;
}
export interface UploadIntent {
  mediaId: string;
  uploadUrl: string;
  uploadMethod: 'POST' | 'PUT';
  formFieldName?: string;
  formData?: Record<string, string>;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}
