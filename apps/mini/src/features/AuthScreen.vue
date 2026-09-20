<script setup lang="ts">
import { ref, computed } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppIcon from '../components/AppIcon.vue';
import MediaUploader from '../components/MediaUploader.vue';

import EmptyState from '../components/EmptyState.vue';
import StatusPill from '../components/StatusPill.vue';
import { usePage } from '../composables/usePage';
import {
  get,
  mutate,
  authPost,
  currentPending,
  recoverOperation,
  type PendingOperation,
} from '../services/api';
import {
  savedReceipts,
  saveReceipt,
  readReceipt,
  type ReceiptView,
} from '../services/privacy-receipts';
import { uuid, updateSession } from '../services/vault';
import { go } from '../services/navigation';
import { dateTime, label } from '../services/format';
import type {
  Profile,
  UploadItem,
  Context,
  Tokens,
  SessionView,
  Application,
  PageResult,
  PrivacyRequest,
  FamilyContext,
} from '../services/types';
const props = defineProps<{ page: string; query: Record<string, string> }>();
const restoring = ref(props.page === 'login');
const privacy = ref<{ policyVersion: string; content: string; supportContact?: string } | null>(
  null,
);
const consent = ref(false);
const name = ref('');
const avatar = ref<UploadItem[]>([]);
const profile = ref<Profile | null>(null);
const contexts = ref<Context[]>([]);
const familyName = ref('');
const token = ref('');
const purpose = ref('GUARDIAN_JOIN');
const preview = ref<{
  purpose: string;
  familyName: string;
  childNickname?: string;
  expiresAt: string;
  canApply: boolean;
} | null>(null);
const applications = ref<Application[]>([]);
const pin = ref('');
const newPin = ref('');
const confirmPin = ref('');
const recoveryCode = ref('');
const enrollmentId = ref('');
const recoverySaved = ref(false);
const localCode = ref('');
const pinMode = ref('');
const pending = ref<PendingOperation[]>([]);
const supportDescription = ref('');
const supportRequest = ref<PrivacyRequest | null>(null);
const privacyRequests = ref<PrivacyRequest[]>([]);
const requestType = ref('EXPORT');
const requestScope = ref('SELF_ACCOUNT');
const confirmation = ref('');

const receiptViews = ref<ReceiptView[]>([]);
const receiptError = ref('');
const nicknameError = ref('');
const wechatPrivacyNeeded = ref(false);
const wechatPrivacyName = ref('小程序隐私保护指引');
async function loadWechatPrivacy() {
  // #ifdef MP-WEIXIN
  if (typeof uni.getPrivacySetting === 'function') {
    await new Promise<void>((resolve, reject) =>
      uni.getPrivacySetting({
        success: (r) => {
          wechatPrivacyNeeded.value = r.needAuthorization;
          wechatPrivacyName.value = r.privacyContractName || '小程序隐私保护指引';
          resolve();
        },
        fail: () => reject(new Error('暂时无法查询微信隐私授权，请重试')),
      }),
    );
  }
  // #endif
}
function openWechatPrivacy() {
  // #ifdef MP-WEIXIN
  uni.openPrivacyContract({
    fail: () => uni.showToast({ title: '暂时无法打开隐私指引，请重试', icon: 'none' }),
  });
  // #endif
}
function syncNickname(event: unknown) {
  const detail = (event as { detail?: { value?: unknown } })?.detail;
  if (typeof detail?.value === 'string') {
    name.value = detail.value;
  }
}
function reviewNickname(event: { detail?: { pass?: boolean; timeout?: boolean } }) {
  if (event.detail?.timeout) {
    name.value = '';
    nicknameError.value = '微信昵称检查超时，请重新填写后重试';
  } else if (event.detail?.pass === false) {
    name.value = '';
    nicknameError.value = '昵称未通过微信检查，请重新填写';
  } else if (event.detail?.pass === true) {
    nicknameError.value = '';
  }
}
async function submitProfile(event: unknown) {
  const nickname = (event as { detail?: { value?: { nickname?: unknown } } })?.detail?.value
    ?.nickname;
  if (typeof nickname === 'string') {
    name.value = nickname;
  }
  await saveProfile();
}
async function loadReceipts() {
  receiptError.value = '';
  const results = await Promise.allSettled(savedReceipts().map(readReceipt));
  receiptViews.value = results
    .filter((r): r is PromiseFulfilledResult<ReceiptView> => r.status === 'fulfilled')
    .map((r) => r.value);
  if (results.some((r) => r.status === 'rejected')) {
    receiptError.value = '部分回执暂时无法查询，请稍后重试。保存的回执仍保留在本设备。';
  }
}
let localAuth = false;
// #ifdef H5
localAuth = import.meta.env.DEV && import.meta.env.VITE_LOCAL_AUTH === 'true';
// #endif
const title = computed(
  () =>
    ({
      login: '给努力一点回应',
      profile: '完善资料',
      contexts: '我的家庭',
      invite: '接受家庭邀请',
      pin: '请家长验证',
      recovery: '确认操作',
      account: '我的账号',
      privacy: '隐私与数据',
    })[props.page] || '积乐圈',
);
const { loading, error, busy, reload, act, session } = usePage(props.page, load, 'public');
async function load() {
  if (props.page === 'login') {
    restoring.value = true;
    if (await session.resume()) {
      return;
    }
    restoring.value = false;
    privacy.value = await get('/public/privacy');
    return;
  }
  if (['privacy', 'profile', 'account'].includes(props.page)) {
    privacy.value = await get('/public/privacy');
  }
  if (props.page === 'privacy') {
    await loadReceipts();
  }
  await session.bootstrap();
  if (props.page === 'privacy' && !session.view) {
    return;
  }
  if (!session.view) {
    go('login', {}, true);
    return;
  }
  if (props.page === 'pin') {
    pinMode.value = props.query.purpose || 'unlock';
    if (session.view.mode === 'LOCKED') {
      const support = await get<PageResult<PrivacyRequest>>('/support/pin-recovery-requests');
      supportRequest.value = support.items[0] || null;
    }
    return;
  }
  if (['profile', 'account'].includes(props.page)) {
    if (session.isDelegated) {
      go('today', {}, true);
      return;
    }
    profile.value = await get<Profile>('/me/profile');
    name.value = profile.value.displayName || '';
    if (profile.value.avatarMediaId) {
      avatar.value = [
        {
          localId: profile.value.avatarMediaId,
          mediaId: profile.value.avatarMediaId,
          status: 'READY',
          progress: 100,
        },
      ];
    }
    await loadWechatPrivacy();
    return;
  }
  if (!(await session.guard(props.page === 'recovery' ? 'authenticated' : 'account'))) {
    return;
  }
  if (props.page === 'contexts') {
    contexts.value = await session.loadContexts();
    await loadApplications();
  }
  if (props.page === 'invite') {
    token.value = props.query.token || token.value;
    purpose.value = props.query.purpose || 'GUARDIAN_JOIN';
    if (token.value) {
      await previewInvite();
    }
  }
  if (props.page === 'recovery') {
    pending.value = currentPending();
  }
  if (props.page === 'privacy') {
    const result = await get<PageResult<PrivacyRequest>>('/me/privacy-requests');
    privacyRequests.value = result.items;
    requestScope.value = props.query.scope || 'SELF_ACCOUNT';
  }
}
async function login() {
  await act(async () => {
    if (!consent.value) {
      throw new Error('请先阅读并同意隐私说明');
    }
    if (localAuth && !localCode.value.trim()) {
      throw new Error('请输入本地联调账号code');
    }
    await session.login(localAuth ? localCode.value.trim() : undefined);
  });
}
async function saveProfile() {
  await act(async () => {
    if (nicknameError.value) {
      throw new Error(nicknameError.value);
    }
    if (!name.value.trim() || [...name.value.trim()].length > 24) {
      throw new Error('昵称需为1—24字');
    }
    if (
      avatar.value.length !== 1 ||
      avatar.value[0].status !== 'READY' ||
      !avatar.value[0].mediaId
    ) {
      throw new Error('请先选择头像并等待自动保存完成');
    }
    const result = await mutate<{ profile: Profile; session: SessionView }>(
      'PUT',
      '/me/profile',
      {
        displayName: name.value.trim(),
        avatarMediaId: avatar.value[0].mediaId,
        privacyVersion: privacy.value?.policyVersion,
        expectedVersion: profile.value?.version || 1,
      },
      '保存头像与昵称',
    );
    profile.value = result.profile;
    updateSession(result.session);
    if (props.page === 'profile') {
      await session.land();
    } else {
      uni.showToast({ title: '资料已保存', icon: 'none' });
    }
  });
}
async function createFamily() {
  await act(async () => {
    const n = familyName.value.trim();
    if ([...n].length < 2 || [...n].length > 30) {
      throw new Error('家庭名称需为2—30字');
    }
    const created = await mutate<FamilyContext>('POST', '/families', { name: n }, '创建家庭');
    await session.loadContexts();
    const context = session.contexts.find((c) => c.family.id === created.family.id);
    if (context) {
      await session.selectContext(context.contextId);
    } else {
      await session.land();
    }
  });
}
async function loadApplications() {
  const [a, b] = await Promise.all([
    get<PageResult<Application>>('/me/join-applications'),
    get<PageResult<Application>>('/me/child-binding-applications'),
  ]);
  applications.value = [
    ...a.items.map((i) => ({ ...i, purpose: 'GUARDIAN_JOIN' })),
    ...b.items.map((i) => ({ ...i, purpose: 'CHILD_BIND' })),
  ];
}
async function previewInvite() {
  preview.value = await authPost(
    purpose.value === 'CHILD_BIND' ? '/child-bindings/preview' : '/invitations/preview',
    { token: token.value.trim() },
  );
}
async function applyInvite() {
  await act(async () => {
    if (!preview.value?.canApply) {
      throw new Error('邀请当前不可申请，请向负责人取得新邀请');
    }
    await mutate(
      'POST',
      purpose.value === 'CHILD_BIND' ? '/child-binding-applications' : '/join-applications',
      { token: token.value.trim() },
      purpose.value === 'CHILD_BIND' ? '申请绑定孩子账号' : '申请成为共同家长',
    );
    go('contexts', {}, true);
  }, '申请已提交，等待负责人核对');
}
async function withdraw(app: Application) {
  await act(async () => {
    await mutate(
      'POST',
      `/${app.purpose === 'CHILD_BIND' ? 'child-binding-applications' : 'join-applications'}/${app.id}/withdraw`,
      { expectedVersion: app.version },
      '撤回申请',
    );
    await loadApplications();
  }, '已撤回');
}
async function prepareRecovery() {
  await act(async () => {
    session.requireSettled();
    await session.login(await freshCode());
    go('pin', { purpose: 'recover' }, true);
  });
}
function copyRecovery() {
  uni.setClipboardData({ data: recoveryCode.value });
}
async function pinSubmit() {
  await act(async () => {
    if (pinMode.value === 'enroll') {
      if (!/^\d{6}$/.test(newPin.value) || newPin.value !== confirmPin.value) {
        throw new Error('请设置并重复输入相同的6位数字密码');
      }
      const result = await authPost<{ enrollmentId: string; recoveryCode: string }>(
        '/auth/pin/enroll',
        { pin: newPin.value, confirmationPin: confirmPin.value },
      );
      enrollmentId.value = result.enrollmentId;
      recoveryCode.value = result.recoveryCode;
      return;
    }
    if (pinMode.value === 'recover') {
      if (session.isDelegated) {
        throw new Error('请先重新微信登录，再用恢复码重设家长密码');
      }
      if (!recoveryCode.value.trim()) {
        throw new Error('请输入之前妥善保存的恢复码');
      }
      if (!/^\d{6}$/.test(newPin.value) || newPin.value !== confirmPin.value) {
        throw new Error('两次新密码必须为相同6位数字');
      }
      const wxCode = await freshCode();
      const result = await authPost<Tokens & { recoveryCode: string }>('/auth/pin/recover', {
        newWechatCode: wxCode,
        recoveryCode: recoveryCode.value.trim(),
        newPin: newPin.value,
        confirmationPin: confirmPin.value,
        recoveryAttemptId: uuid(),
      });
      session.accept(result);
      recoveryCode.value = result.recoveryCode;
      pinMode.value = 'recovered';
      return;
    }
    if (pinMode.value === 'change') {
      const result = await authPost<Tokens>('/auth/pin/change', {
        oldPin: pin.value,
        newPin: newPin.value,
        confirmationPin: confirmPin.value,
      });
      session.accept(result);
      pinMode.value = 'unlock';
      pin.value = '';
      return;
    }
    if (!/^\d{6}$/.test(pin.value)) {
      throw new Error('请输入6位数字家长密码');
    }
    const tokens = await authPost<Tokens>(
      pinMode.value === 'exit' ? '/auth/child-mode/exit' : '/auth/pin/unlock',
      pinMode.value === 'exit'
        ? { pin: pin.value }
        : { pin: pin.value, targetContextId: props.query.contextId || undefined },
    );
    session.accept(tokens);
    pin.value = '';
    if (props.query.contextId) {
      await session.selectContext(props.query.contextId);
    } else {
      await session.land();
    }
  });
}
async function enrollConfirm() {
  await act(async () => {
    if (!recoverySaved.value) {
      throw new Error('请先妥善保存恢复码并确认');
    }
    await authPost('/auth/pin/enroll/confirm', {
      enrollmentId: enrollmentId.value,
      recoverySaved: true,
    });
    recoveryCode.value = '';
    if (props.query.childId) {
      await session.enterChild(props.query.childId);
    } else {
      await session.land();
    }
  });
}
async function freshCode() {
  // #ifdef H5
  if (localAuth) {
    if (!localCode.value.trim()) {
      throw new Error('本地联调需填写本次验证的微信code');
    }
    return localCode.value.trim();
  }
  // #endif
  const result = await new Promise<UniApp.LoginRes>((resolve, reject) =>
    uni.login({ provider: 'weixin', success: resolve, fail: reject }),
  );
  return result.code;
}
async function support() {
  await act(async () => {
    if (!supportDescription.value.trim()) {
      throw new Error('请描述需要帮助的情况，不要填写孩子证件或恢复码');
    }
    supportRequest.value = await authPost('/support/pin-recovery-requests', {
      description: supportDescription.value.trim(),
    });
  }, '支持申请已提交');
}
async function recover(op: PendingOperation) {
  await act(async () => {
    const result = (await recoverOperation(op)) as
      (PrivacyRequest & { receiptToken?: string }) | undefined;
    if (op.path.endsWith('/privacy-requests') && result?.receiptToken) {
      saveReceipt({
        requestId: result.id,
        receiptToken: result.receiptToken,
        type: result.type,
        scope: result.scope,
      });
    }
    pending.value = currentPending();
    await session.bootstrap();
  }, '操作已确认，请返回查看最新记录');
}
async function requestPrivacy() {
  await act(async () => {
    const scope = requestScope.value;
    const action = requestType.value + '_' + (scope === 'FAMILY' ? 'FAMILY' : 'SELF');
    const expected = scope === 'FAMILY' ? session.family?.family.name : '本人账号';
    if (confirmation.value.trim() !== expected) {
      throw new Error('请准确填写确认文字，确认你理解申请范围');
    }
    const step = await authPost<{ stepUpToken: string }>('/auth/step-up', {
      action,
      ...(pin.value ? { pin: pin.value } : { newWechatCode: await freshCode() }),
    });
    const path =
      scope === 'FAMILY'
        ? `/families/${session.view?.familyId}/privacy-requests`
        : '/me/privacy-requests';
    const receipt = await mutate<PrivacyRequest & { receiptToken?: string }>(
      'POST',
      path,
      {
        type: requestType.value,
        scope,
        confirmation: {
          confirmed: true,
          ...(requestType.value === 'DELETE'
            ? scope === 'FAMILY'
              ? { familyName: confirmation.value.trim(), deleteNonzeroBalancesConfirmed: true }
              : { deleteOwnChildSensitiveDataConfirmed: true }
            : {}),
        },
        stepUpToken: step.stepUpToken,
      },
      requestType.value === 'EXPORT' ? '申请数据导出' : '申请数据删除',
    );
    if (receipt.receiptToken) {
      saveReceipt({
        requestId: receipt.id,
        receiptToken: receipt.receiptToken,
        type: receipt.type,
        scope: receipt.scope,
      });
    }
    confirmation.value = '';
    pin.value = '';
    await load();
  }, '申请已提交，处理结果会显示在这里');
}
async function download(req: PrivacyRequest) {
  await act(async () => {
    const grant = await authPost<{ downloadUrl: string }>(
      '/privacy-requests/' + req.id + '/download-grant',
      {},
    );
    const result = await new Promise<UniApp.DownloadSuccessData>((resolve, reject) =>
      uni.downloadFile({ url: grant.downloadUrl, success: resolve, fail: reject }),
    );
    if (result.statusCode !== 200) {
      throw new Error('下载失败，请重新申请下载链接');
    }
    // #ifdef MP-WEIXIN
    await new Promise<void>((resolve, reject) =>
      uni.shareFileMessage({
        filePath: result.tempFilePath,
        fileName: '积乐圈数据导出.zip',
        success: () => resolve(),
        fail: reject,
      }),
    );
    // #endif
    // #ifdef H5
    uni.openDocument({ filePath: result.tempFilePath, showMenu: true });
    // #endif
  });
}
// Native nickname recommendations may only update on blur/form submit.
const canProfileSave = computed(
  () =>
    !loading.value &&
    !wechatPrivacyNeeded.value &&
    avatar.value.length === 1 &&
    avatar.value[0].status === 'READY',
);
</script>
<template>
  <AppShell
    :title="page === 'login' ? (restoring ? '积乐圈' : '微信登录') : title"
    :public-page="['login', 'profile', 'pin'].includes(page)"
    :back="
      !['login', 'profile', 'contexts', 'pin'].includes(page) ||
      (page === 'contexts' && (session.isGuardian || session.isChild))
    "
    :loading="loading"
    :error="error"
    @retry="reload"
  >
    <template v-if="page === 'login' && restoring"
      ><text v-if="!error" class="caption">正在回到你的家庭…</text></template
    >
    <template v-else-if="page === 'login'">
      <view class="welcome-screen"
        ><view class="welcome-art"
          ><view class="welcome-halo halo-one" /><view class="welcome-halo halo-two" /><view
            class="welcome-orb"
            ><view class="welcome-symbol"
              ><AppIcon name="sparkle" tone="blue" size="100rpx" /></view></view
          ><view class="welcome-floating welcome-complete"
            ><view class="welcome-mini-icon"
              ><AppIcon name="check" tone="green" size="30rpx" /></view
            ><text>完成一个小目标</text></view
          ><view class="welcome-floating welcome-wish"
            ><view class="welcome-mini-icon wish-icon"
              ><AppIcon name="gift" tone="blue" size="32rpx" /></view
            ><text>离心愿近一点</text></view
          ></view
        >
        <text class="welcome-eyebrow">给努力一点回应</text
        ><text class="welcome-title">小小努力，{{ '\n' }}大大期待。</text
        ><text class="welcome-copy"
          >一起约定日常，记录每一点成长。{{ '\n' }}把孩子的努力，变成可以期待的奖励。</text
        >
        <view class="welcome-bottom"
          ><view class="welcome-consent" @tap="consent = !consent"
            ><checkbox :checked="consent" color="#007AFF" /><text>我已阅读并同意</text
            ><button class="welcome-privacy" @tap.stop="go('privacy')">隐私说明</button></view
          >
          <!-- #ifdef H5 --><view v-if="localAuth" class="field"
            ><text class="field-label">本地联调微信 code</text
            ><input
              class="input"
              v-model="localCode"
              placeholder="由本地API提供的测试身份code" /></view
          ><!-- #endif -->
          <button
            class="primary full welcome-login"
            :class="{ 'is-disabled': busy }"
            :loading="busy"
            :disabled="busy"
            @tap="login"
          >
            <AppIcon v-if="!busy" name="wechat" tone="white" size="40rpx" /><text
              >微信登录</text
            ></button
          ><view class="welcome-trust"
            ><AppIcon name="lock" tone="muted" size="25rpx" /><text
              >只属于你们的家庭空间</text
            ></view
          ></view
        ></view
      >
    </template>
    <template v-else-if="page === 'profile' || page === 'account'"
      ><text class="profile-intro"
        >选择喜欢的头像，填写家里熟悉的称呼。{{ '\n' }}不需要真人照片，也不需要实名。</text
      ><!-- #ifdef MP-WEIXIN -->
      <view v-if="wechatPrivacyNeeded" class="notice"
        ><text>使用微信头像和昵称前，请阅读并同意小程序隐私保护指引。</text
        ><button class="text-button" @tap="openWechatPrivacy">{{ wechatPrivacyName }}</button
        ><button
          id="profile-privacy-agree"
          class="primary full"
          open-type="agreePrivacyAuthorization"
          :disabled="busy"
          @agreeprivacyauthorization="act(loadWechatPrivacy)"
        >
          同意并使用头像昵称
        </button></view
      >
      <!-- #endif -->
      <form class="profile-card" @submit="submitProfile">
        <MediaUploader
          v-model="avatar"
          :scope="{ purpose: 'USER_AVATAR' }"
          :max="1"
          avatar
          wechat-avatar
          :disabled="busy || loading || wechatPrivacyNeeded"
        /><view class="field"
          ><text class="field-label">昵称（必填）</text>
          <!-- #ifdef MP-WEIXIN -->
          <input
            class="input"
            v-model="name"
            name="nickname"
            maxlength="24"
            placeholder="点此选择微信昵称，也可手动填写"
            type="nickname"
            :disabled="busy || loading || wechatPrivacyNeeded"
            @input="nicknameError = ''"
            @blur="syncNickname"
            @nicknamereview="reviewNickname"
          />
          <text class="caption"
            >点击输入框，在键盘上方选择微信昵称；也可以填写家里熟悉的称呼。</text
          >
          <!-- #endif -->
          <!-- #ifndef MP-WEIXIN -->
          <input
            class="input"
            v-model="name"
            name="nickname"
            maxlength="24"
            placeholder="例如：妈妈、朵朵"
            :disabled="busy"
            @input="nicknameError = ''"
            @blur="syncNickname"
          />
          <!-- #endif -->
          <text v-if="nicknameError" class="field-error">{{ nicknameError }}</text></view
        ><button
          :class="{ 'is-disabled': busy || !canProfileSave }"
          class="primary full"
          form-type="submit"
          :disabled="busy || !canProfileSave"
          :loading="busy"
        >
          {{ page === 'profile' ? '保存并继续' : '保存资料' }}
        </button>
      </form>
      <template v-if="page === 'account'"
        ><view class="button-stack"
          ><button class="secondary" @tap="go('contexts')">我已加入的家庭</button
          ><button class="secondary" @tap="go('privacy')">个人隐私与数据申请</button
          ><button class="secondary" @tap="act(() => session.logout())">
            退出当前微信登录
          </button></view
        ></template
      ></template
    >
    <template v-else-if="page === 'contexts'"
      ><view
        v-for="ctx in contexts"
        :key="ctx.contextId"
        class="card context-card"
        @tap="act(() => session.selectContext(ctx.contextId))"
        ><view class="row between"
          ><view class="context-icon"><AppIcon name="family" tone="blue" size="46rpx" /></view
          ><view class="grow"
            ><text class="card-title">{{ ctx.family.name }}</text
            ><text class="caption"
              >{{ label(ctx.relation) }}{{ ctx.child ? ' · ' + ctx.child.nickname : '' }}</text
            ></view
          ><AppIcon
            :name="ctx.requiresPin && ctx.relation !== 'CHILD' ? 'lock' : 'chevron'"
            tone="muted"
            size="32rpx" /></view></view
      ><EmptyState
        v-if="!loading && !contexts.length"
        title="先建立一个家庭约定"
        description="可以创建家庭，或接受负责人发来的邀请。"
      /><view class="card section"
        ><text class="section-title">创建新的家庭</text
        ><view class="field"
          ><text class="field-label">家庭名称</text
          ><input
            v-model="familyName"
            class="input"
            maxlength="30"
            placeholder="例如：向日葵之家" /></view
        ><button
          :class="{ 'is-disabled': busy }"
          class="primary"
          :loading="busy"
          :disabled="busy"
          @tap="createFamily"
        >
          创建家庭
        </button></view
      ><view class="button-row"
        ><button class="secondary" @tap="go('invite', { purpose: 'GUARDIAN_JOIN' })">
          我收到家长邀请</button
        ><button class="secondary" @tap="go('invite', { purpose: 'CHILD_BIND' })">
          我收到孩子绑定邀请
        </button></view
      ><view v-if="applications.length" class="section"
        ><text class="section-title">我的申请</text
        ><view v-for="a in applications" :key="a.id" class="card"
          ><view class="row between"
            ><text>{{ a.familyName || '家庭申请' }}</text
            ><StatusPill :status="a.status" /></view
          ><text class="caption"
            >{{ a.purpose === 'CHILD_BIND' ? '孩子账号绑定' : '加入共同家长' }} ·
            {{ dateTime(a.createdAt) }}</text
          ><text v-if="a.reason" class="body-copy">{{ a.reason }}</text
          ><button
            v-if="['PENDING', 'PENDING_APPROVAL'].includes(a.status)"
            class="text-button"
            @tap="withdraw(a)"
          >
            撤回申请
          </button></view
        ></view
      ><button class="text-button full section" @tap="act(() => session.logout())">
        退出当前微信登录
      </button></template
    >
    <template v-else-if="page === 'invite'"
      ><view class="notice"
        >{{
          purpose === 'CHILD_BIND'
            ? '将自己的微信账号申请绑定到负责人指定的孩子档案。'
            : '申请成为共同家长后，可管理家庭计划、审核和奖励。'
        }}
        你的头像昵称将展示给负责人核对。</view
      ><view class="field"
        ><text class="field-label">邀请内容</text
        ><textarea class="textarea" v-model="token" placeholder="粘贴负责人发来的邀请令牌" /></view
      ><button
        :class="{ 'is-disabled': busy }"
        class="secondary full"
        :disabled="busy"
        @tap="act(previewInvite)"
      >
        核对邀请</button
      ><view v-if="preview" class="card section"
        ><text class="section-title">{{ preview.familyName }}</text
        ><text v-if="preview.childNickname" class="body-copy"
          >目标孩子：{{ preview.childNickname }}</text
        ><text class="caption">有效至 {{ dateTime(preview.expiresAt) }}</text
        ><button
          :class="{ 'is-disabled': busy || !preview.canApply }"
          class="primary full section"
          :disabled="busy || !preview.canApply"
          :loading="busy"
          @tap="applyInvite"
        >
          {{ purpose === 'CHILD_BIND' ? '申请绑定我的账号' : '申请成为共同家长' }}</button
        ><text v-if="!preview.canApply" class="field-error"
          >此邀请已失效或暂不可使用，请联系负责人。</text
        ></view
      ></template
    >
    <template v-else-if="page === 'pin'"
      ><view class="notice">{{
        pinMode === 'exit'
          ? '这是家长共用设备，验证后才能回到家长内容。'
          : '家长密码保护家庭的管理权限。微信登录不能代替家长密码。'
      }}</view
      ><template v-if="enrollmentId || pinMode === 'recovered'"
        ><text class="section-title">妥善保存你的恢复码</text
        ><text class="caption section"
          >恢复码只显示一次。忘记密码时需要它，不能仅靠微信登录重置。请保存到孩子无法访问的安全位置。</text
        ><view class="code-box section">{{ recoveryCode }}</view
        ><button class="secondary full section" @tap="copyRecovery">复制恢复码</button
        ><view class="check-row" @tap="recoverySaved = !recoverySaved"
          ><checkbox :checked="recoverySaved" color="#007AFF" /><text
            >我已经妥善保存恢复码</text
          ></view
        ><button
          :class="{ 'is-disabled': busy || !recoverySaved }"
          v-if="enrollmentId"
          class="primary full"
          :disabled="busy || !recoverySaved"
          @tap="enrollConfirm"
        >
          确认保存并继续</button
        ><button
          :class="{ 'is-disabled': !recoverySaved }"
          v-else
          class="primary full"
          :disabled="!recoverySaved"
          @tap="
            recoveryCode = '';
            pinMode = 'unlock';
          "
        >
          已保存，验证新密码
        </button></template
      ><template v-else
        ><view v-if="['unlock', 'exit', 'change'].includes(pinMode)" class="field"
          ><text class="field-label">{{ pinMode === 'change' ? '原家长密码' : '6位家长密码' }}</text
          ><input
            v-model="pin"
            class="input pin-input"
            password
            type="number"
            maxlength="6"
            placeholder="••••••" /></view
        ><view v-if="pinMode === 'recover'" class="field"
          ><text class="field-label">之前保存的恢复码</text
          ><textarea v-model="recoveryCode" class="textarea" placeholder="输入一次性恢复码" /></view
        ><template v-if="['enroll', 'change', 'recover'].includes(pinMode)"
          ><view class="field"
            ><text class="field-label">新的6位数字密码</text
            ><input
              v-model="newPin"
              password
              type="number"
              class="input pin-input"
              maxlength="6" /></view
          ><view class="field"
            ><text class="field-label">再次输入新密码</text
            ><input
              v-model="confirmPin"
              password
              type="number"
              class="input pin-input"
              maxlength="6" /></view></template
        ><!-- #ifdef H5 --><view v-if="localAuth && pinMode === 'recover'" class="field"
          ><text class="field-label">本地新微信验证 code</text
          ><input class="input" v-model="localCode" /></view
        ><!-- #endif --><button
          :class="{ 'is-disabled': busy }"
          class="primary full"
          :loading="busy"
          :disabled="busy"
          @tap="pinSubmit"
        >
          {{
            pinMode === 'enroll'
              ? '设置家长密码'
              : pinMode === 'recover'
                ? '验证恢复码并重设'
                : '验证并继续'
          }}</button
        ><button
          v-if="['unlock', 'exit'].includes(pinMode)"
          class="text-button full section"
          @tap="
            pinMode = 'recover';
            pin = '';
          "
        >
          忘记密码，使用恢复码</button
        ><view v-if="pinMode === 'recover' && session.isDelegated" class="notice section"
          >请先重新微信登录，进入锁定页面后再使用恢复码。重新登录不会直接获得家长权限。<button
            class="secondary full section"
            @tap="prepareRecovery"
          >
            重新微信登录后恢复
          </button></view
        ><view v-if="pinMode === 'recover' && session.view?.mode === 'LOCKED'" class="section"
          ><text class="section-title">恢复码也找不到了</text
          ><text class="caption"
            >不会自动解锁。支持人员会说明是否能在充分验证后处理，请勿提交孩子证件、学校或恢复码。</text
          ><textarea
            class="textarea section"
            v-model="supportDescription"
            maxlength="500"
            placeholder="描述需要帮助的情况"
          /><button
            :class="{ 'is-disabled': busy }"
            class="secondary full section"
            :disabled="busy"
            @tap="support"
          >
            提交支持申请</button
          ><view v-if="supportRequest" class="notice section"
            >申请 {{ supportRequest.id }} · {{ label(supportRequest.status) }}</view
          ></view
        ></template
      ><button
        v-if="session.isDelegated"
        class="text-button full section"
        @tap="go('today', {}, true)"
      >
        返回孩子页面
      </button></template
    >
    <template v-else-if="page === 'recovery'"
      ><view class="notice"
        >这里记录发送后尚未确认的操作。查询会沿用原操作，不会再次创建兑换或重复发分。</view
      ><view v-for="op in pending" :key="op.key" class="card"
        ><text class="card-title">{{ op.label }}</text
        ><text class="caption">{{ dateTime(op.createdAt) }}</text
        ><text class="caption">操作号 {{ op.key }}</text
        ><button
          :class="{ 'is-disabled': busy }"
          class="primary full section"
          :loading="busy"
          :disabled="busy"
          @tap="recover(op)"
        >
          查询这次操作
        </button></view
      ><EmptyState
        v-if="!pending.length"
        title="没有待确认的操作"
        description="返回业务页面查看最新状态和余额。"
      /><button class="secondary full section" @tap="go(session.homeRoute(), {}, true)">
        回到首页
      </button></template
    >
    <template v-else-if="page === 'privacy'"
      ><view v-if="receiptViews.length || receiptError" class="section"
        ><text class="section-title">本设备已保存的申请回执</text
        ><text class="caption section"
          >即使退出登录或账号已删除，也可查看最少处理状态。回执保存在本设备，不包含家庭内容；更换设备前请保留申请编号。</text
        ><text v-if="receiptError" class="field-error">{{ receiptError }}</text
        ><view v-for="r in receiptViews" :key="r.requestId" class="card section"
          ><view class="row between"
            ><text
              >{{ r.type === 'DELETE' ? '删除' : '导出' }} ·
              {{ r.scope === 'FAMILY' ? '家庭' : '本人账号' }}</text
            ><StatusPill :status="r.status" /></view
          ><text class="caption">申请编号 {{ r.requestId }}</text
          ><text class="body-copy">{{ r.userVisibleNote }}</text
          ><text v-if="r.onlineCompletedAt" class="caption"
            >在线数据处理完成 {{ dateTime(r.onlineCompletedAt) }}</text
          ><text v-if="r.type === 'DELETE'" class="caption">{{
            r.backupStatus === 'COMPLETED'
              ? '备份轮换清理已完成'
              : r.backupStatus === 'PENDING'
                ? '在线处理已完成，备份仍等待最长35天轮换清理'
                : '备份清理尚未开始'
          }}</text
          ><text v-if="r.backupPurgeDueAt" class="caption"
            >备份计划完成 {{ dateTime(r.backupPurgeDueAt) }}</text
          ><text v-if="r.backupCompletedAt" class="caption"
            >备份实际完成 {{ dateTime(r.backupCompletedAt) }}</text
          ><text v-if="r.supportContact" class="caption"
            >支持渠道 {{ r.supportContact }}</text
          ></view
        ><button class="secondary full" @tap="act(loadReceipts)">刷新保存的回执</button></view
      ><view class="card"
        ><text class="section-title">隐私说明</text
        ><text class="caption">版本 {{ privacy?.policyVersion }}</text
        ><text class="body-copy" style="white-space: pre-wrap">{{ privacy?.content }}</text
        ><text v-if="privacy?.supportContact" class="caption section"
          >支持渠道：{{ privacy.supportContact }}</text
        ></view
      ><template
        v-if="
          session.view &&
          session.canAccount &&
          session.view.mode !== 'PROFILE_ONLY' &&
          session.view.mode !== 'LOCKED'
        "
        ><view class="card"
          ><text class="section-title">数据处理申请</text
          ><view class="tabs"
            ><button :class="{ active: requestType === 'EXPORT' }" @tap="requestType = 'EXPORT'">
              导出数据</button
            ><button :class="{ active: requestType === 'DELETE' }" @tap="requestType = 'DELETE'">
              删除数据
            </button></view
          ><view class="chip-row"
            ><button
              class="chip"
              :class="{ active: requestScope === 'SELF_ACCOUNT' }"
              @tap="requestScope = 'SELF_ACCOUNT'"
            >
              仅本人账号</button
            ><button
              v-if="session.isOwner"
              class="chip"
              :class="{ active: requestScope === 'FAMILY' }"
              @tap="requestScope = 'FAMILY'"
            >
              本家庭全量
            </button></view
          ><view class="notice warning">{{
            requestType === 'DELETE'
              ? '删除与归档不同。负责人删除个人账号前，必须转让相关家庭或先完成相应家庭在线数据删除。家庭删除须先归档，并删除包括非零积分在内的全部记录。删除本人账号会清理本人孩子的敏感文字和照片，共同账务去标识化保留。'
              : '导出通常24小时内生成，最多3个自然日；下载文件保留7天。个人申请不包含其他孩子的私有资料。'
          }}</view
          ><view class="field"
            ><text class="field-label">确认申请范围</text
            ><input
              class="input"
              v-model="confirmation"
              :placeholder="
                requestScope === 'FAMILY' ? '输入家庭名称确认' : '输入“本人账号”确认'
              " /></view
          ><view class="field"
            ><text class="field-label">家长密码（如已设置）</text
            ><input v-model="pin" class="input" password type="number" maxlength="6" /></view
          ><!-- #ifdef H5 --><view v-if="localAuth" class="field"
            ><text class="field-label">无PIN账号的本地微信验证code</text
            ><input class="input" v-model="localCode" /></view
          ><!-- #endif --><button
            :class="[
              requestType === 'DELETE' ? 'danger-button full' : 'primary full',
              { 'is-disabled': busy },
            ]"
            :loading="busy"
            :disabled="busy"
            @tap="requestPrivacy"
          >
            提交{{ requestType === 'DELETE' ? '删除' : '导出' }}申请
          </button></view
        ><text class="section-title section">申请进度</text
        ><view v-for="r in privacyRequests" :key="r.id" class="card section"
          ><view class="row between"
            ><text
              >{{ r.type === 'EXPORT' ? '数据导出' : '数据删除' }} ·
              {{ r.scope === 'FAMILY' ? '家庭' : '个人' }}</text
            ><StatusPill :status="r.status" /></view
          ><text class="caption"
            >提交 {{ dateTime(r.requestedAt) }}{{ '\n' }}预计处理 {{ dateTime(r.dueAt) }}</text
          ><text v-if="r.userVisibleNote" class="body-copy">{{ r.userVisibleNote }}</text
          ><button v-if="r.downloadAvailable" class="secondary full section" @tap="download(r)">
            下载并保存导出文件
          </button></view
        ></template
      ></template
    >
  </AppShell>
</template>

<style lang="scss">
.welcome-screen {
  padding: 4rpx 6rpx 0;
  text-align: center;
}
.welcome-art {
  position: relative;
  width: 100%;
  height: 370rpx;
  margin: 0 auto 26rpx;
}
.welcome-halo {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(173, 192, 233, 0.24);
}
.halo-one {
  width: 310rpx;
  height: 310rpx;
}
.halo-two {
  width: 430rpx;
  height: 430rpx;
  border-color: rgba(173, 192, 233, 0.12);
}
.welcome-orb {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) rotate(-9deg);
  width: 240rpx;
  height: 240rpx;
  border-radius: 78rpx;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.96), #d7e7ff 58%, #cbdafb);
  border: 3rpx solid rgba(255, 255, 255, 0.96);
  box-shadow:
    0 30rpx 70rpx rgba(67, 106, 180, 0.17),
    inset 0 -9rpx 30rpx rgba(101, 145, 229, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-symbol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 162rpx;
  height: 162rpx;
  border-radius: 52rpx;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.22));
  border: 2rpx solid rgba(255, 255, 255, 0.9);
  transform: rotate(9deg);
  box-shadow: 0 6rpx 24rpx rgba(57, 102, 175, 0.06);
}
.welcome-floating {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12rpx;
  padding: 17rpx 23rpx;
  border-radius: 27rpx;
  background: rgba(255, 255, 255, 0.92);
  border: 2rpx solid white;
  box-shadow: 0 14rpx 34rpx rgba(49, 77, 124, 0.08);
  font-size: 25rpx;
  color: #4b5a71;
  font-weight: 500;
}
.welcome-complete {
  left: 0;
  top: 38rpx;
  transform: rotate(-5deg);
}
.welcome-wish {
  right: 0;
  bottom: 25rpx;
  transform: rotate(5deg);
}
.welcome-mini-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48rpx;
  height: 48rpx;
  background: #e6f4eb;
  border-radius: 16rpx;
}
.wish-icon {
  background: #e8f0ff;
}
.welcome-eyebrow {
  display: block;
  color: #557caf;
  font-size: 25rpx;
  letter-spacing: 3rpx;
  margin: 22rpx 0;
}
.welcome-title {
  display: block;
  font-size: 70rpx;
  font-weight: 700;
  letter-spacing: -2rpx;
  line-height: 1.25;
  color: #1d2d49;
}
.welcome-copy {
  display: block;
  font-size: 27rpx;
  line-height: 1.9;
  color: #748095;
  margin-top: 24rpx;
}
.welcome-bottom {
  margin-top: 42rpx;
}
.welcome-consent {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  font-size: 24rpx;
  min-height: 78rpx;
  color: #778194;
}
.welcome-consent checkbox {
  transform: scale(0.8);
}
.welcome-privacy {
  background: transparent;
  line-height: 1.45;
  padding: 15rpx 4rpx;
  min-height: 70rpx;
  font-size: 24rpx;
  color: #006ce8;
}
.welcome-login {
  border-radius: 32rpx;
  min-height: 102rpx;
}
.welcome-trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  font-size: 23rpx;
  color: #8a93a2;
  margin-top: 24rpx;
}
.profile-intro {
  display: block;
  font-size: 27rpx;
  line-height: 1.8;
  color: #6c788d;
  margin-bottom: 26rpx;
}
.profile-card {
  padding: 28rpx;
  background: #fff;
  border: 1px solid white;
  border-radius: 38rpx;
  box-shadow: 0 12rpx 34rpx rgba(39, 61, 101, 0.04);
}
.profile-card .media-upload {
  margin-top: 0;
}
.profile-card .input {
  background: #f5f7fb;
  border-color: #edf0f6;
}
.profile-card .field-label {
  color: #59667c;
}
.context-card {
  padding: 28rpx;
}
.context-icon {
  width: 86rpx;
  height: 86rpx;
  border-radius: 27rpx;
  background: #edf3ff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
@media (max-width: 340px) {
  .welcome-art {
    height: 320rpx;
  }
  .welcome-title {
    font-size: 62rpx;
  }
  .welcome-floating {
    font-size: 23rpx;
    padding: 14rpx 17rpx;
  }
  .welcome-orb {
    width: 210rpx;
    height: 210rpx;
  }
  .welcome-bottom {
    margin-top: 28rpx;
  }
  .welcome-halo.halo-two {
    width: 370rpx;
    height: 370rpx;
  }
}
</style>
