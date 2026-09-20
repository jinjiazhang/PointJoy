<script setup lang="ts">
import { ref, computed } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppIcon from '../components/AppIcon.vue';
import PointBalance from '../components/PointBalance.vue';
import StatusPill from '../components/StatusPill.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadMore from '../components/LoadMore.vue';
import { usePage } from '../composables/usePage';
import { get, getAll, mutate, childPath, familyPath } from '../services/api';
import { go } from '../services/navigation';
import {
  businessDate,
  daysAgo,
  dateTime,
  label,
  integer,
  displayOperator,
} from '../services/format';
import type {
  Child,
  Account,
  LedgerEntry,
  Occurrence,
  Order,
  AuditEntry,
  Growth,
  PageResult,
  Today,
} from '../services/types';
const props = defineProps<{ page: string; query: Record<string, string> }>();
const childPage = props.page === 'growth';
const children = ref<Child[]>([]);
const childId = ref(props.query.childId || '');
const account = ref<Account | null>(null);
const entries = ref<LedgerEntry[]>([]);
const occurrences = ref<Occurrence[]>([]);
const orders = ref<Order[]>([]);
const audits = ref<AuditEntry[]>([]);
const growth = ref<Growth | null>(null);
const tab = ref(
  props.query.record === 'true'
    ? 'record'
    : ['ledger', 'growth'].includes(props.page)
      ? 'ledger'
      : 'activities',
);
const dateFrom = ref(daysAgo(29));
const dateTo = ref(businessDate());
const recordDate = ref(businessDate());
const type = ref('');
const status = ref('');
const cursor = ref<string | null>(null);
const hasMore = ref(false);
const points = ref('5');
const reason = ref('');
const selected = ref<LedgerEntry | null>(null);
const expanded = ref('');
const titles: Record<string, string> = { ledger: '积分账本', history: '家庭记录', growth: '成长' };
const { loading, error, busy, reload, act, session } = usePage(
  props.page,
  load,
  childPage ? 'child' : 'guardian',
);
const currentChild = computed(() => childId.value || session.view?.childId || '');
async function load() {
  if (!childPage) {
    children.value = await getAll<Child>(familyPath('/children'));
    if (!childId.value && children.value.length) {
      childId.value = children.value[0].id;
    }
  }
  if (props.page === 'ledger' || props.page === 'growth') {
    if (!currentChild.value) {
      return;
    }
    account.value = await get<Account>(childPath(currentChild.value, '/account'));
    if (props.page === 'growth') {
      growth.value = await get<Growth>(childPath(currentChild.value, '/growth'), {
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
      });
    }
    if (tab.value === 'activities') {
      await loadHistory();
    } else {
      await loadLedger();
    }
  } else {
    await loadHistory();
  }
}
async function loadLedger(more = false) {
  const result = await get<PageResult<LedgerEntry>>(childPath(currentChild.value, '/ledger'), {
    type: type.value || undefined,
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
    cursor: more ? cursor.value : undefined,
  });
  entries.value = more ? [...entries.value, ...result.items] : result.items;
  cursor.value = result.nextCursor || null;
  hasMore.value = result.hasMore;
}
async function loadHistory(more = false) {
  if (tab.value === 'audit') {
    const result = await get<PageResult<AuditEntry>>(familyPath('/audit-logs'), {
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      childId: childId.value || undefined,
      cursor: more ? cursor.value : undefined,
    });
    audits.value = more ? [...audits.value, ...result.items] : result.items;
    cursor.value = result.nextCursor || null;
    hasMore.value = result.hasMore;
    return;
  }
  if (!currentChild.value) {
    return;
  }
  if (tab.value === 'orders') {
    const result = await get<PageResult<Order>>(childPath(currentChild.value, '/orders'), {
      status: status.value || undefined,
      cursor: more ? cursor.value : undefined,
    });
    orders.value = more ? [...orders.value, ...result.items] : result.items;
    cursor.value = result.nextCursor || null;
    hasMore.value = result.hasMore;
    return;
  }
  if (tab.value === 'record') {
    const result = await get<Today>(childPath(currentChild.value, '/today'), {
      businessDate: recordDate.value,
    });
    occurrences.value = [...result.routines, ...result.challenges];
    hasMore.value = false;
    return;
  }
  const result = await get<PageResult<Occurrence>>(childPath(currentChild.value, '/history'), {
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
    type: type.value || undefined,
    status: status.value || undefined,
    cursor: more ? cursor.value : undefined,
  });
  occurrences.value = more ? [...occurrences.value, ...result.items] : result.items;
  cursor.value = result.nextCursor || null;
  hasMore.value = result.hasMore;
}
async function refreshRecords() {
  cursor.value = null;
  await load();
}
async function praise() {
  await act(async () => {
    if (!currentChild.value) {
      throw new Error('请选择孩子');
    }
    if (!integer(points.value, 1, 1000) || !reason.value.trim()) {
      throw new Error('请填写1—1,000整数积分和具体表扬原因');
    }
    const result = await mutate<{ account: Account }>(
      'POST',
      childPath(currentChild.value, '/praises'),
      { points: Number(points.value), reason: reason.value.trim() },
      '手动表扬孩子',
    );
    account.value = result.account;
    reason.value = '';
    await loadLedger();
  }, '表扬积分已到账');
}
async function reverse() {
  await act(async () => {
    if (!selected.value || !account.value) {
      return;
    }
    if (!reason.value.trim()) {
      throw new Error('请说明这次记录为什么需要纠正');
    }
    if (account.value.availablePoints < selected.value.availableDelta) {
      throw new Error('可用积分不足，不能使用预留积分或制造负余额');
    }
    await mutate(
      'POST',
      familyPath(`/ledger/${selected.value.id}/reversal`),
      { reason: reason.value.trim(), expectedAccountVersion: account.value.version },
      '完整撤销错误发奖',
    );
    selected.value = null;
    reason.value = '';
    await load();
  }, '原记录已完整撤销，历史保留');
}
function more() {
  return props.page === 'ledger' || (props.page === 'growth' && tab.value === 'ledger')
    ? loadLedger(true)
    : loadHistory(true);
}
const ledgerTab = computed(
  () => props.page === 'ledger' || (props.page === 'growth' && tab.value === 'ledger'),
);
const auditName = (action: string) =>
  (
    ({
      FAMILY_CREATED: '创建家庭',
      CHILD_CREATED: '添加孩子',
      PLAN_CREATED: '创建计划',
      PLAN_PUBLISHED: '发布计划',
      OCCURRENCE_SUBMITTED: '提交完成',
      OCCURRENCE_APPROVED: '通过完成',
      ORDER_CREATED: '申请奖励',
      ORDER_APPROVED: '批准兑换',
      ORDER_FULFILLED: '实际兑现',
      ORDER_CANCELED: '取消兑换',
      PRAISE_GRANTED: '手动表扬',
    }) as Record<string, string>
  )[action] || label(action);
</script>
<template>
  <AppShell
    :title="titles[page]"
    :tab="childPage ? 'growth' : ''"
    :back="!childPage"
    :loading="loading"
    :error="error"
    @retry="reload"
  >
    <view class="records-ui">
      <view v-if="!childPage" class="records-child-filter"
        ><view class="records-icon-tile"><AppIcon name="user" size="36rpx" tone="blue" /></view
        ><view class="grow"
          ><text class="records-filter-label">正在查看</text
          ><picker
            :range="children.map((c) => c.nickname)"
            :value="
              Math.max(
                0,
                children.findIndex((c) => c.id === childId),
              )
            "
            @change="
              childId = children[Number($event.detail.value)]?.id;
              act(refreshRecords);
            "
            ><view class="records-child-picker"
              ><text>{{ children.find((c) => c.id === childId)?.nickname || '请先添加孩子' }}</text
              ><AppIcon name="chevron" size="28rpx" tone="muted" /></view></picker></view
      ></view>
      <PointBalance v-if="page !== 'history'" :account="account" />
      <view v-if="page === 'growth' && growth" class="records-growth">
        <view class="records-growth-heading"
          ><view class="records-title-with-icon"
            ><AppIcon name="chart" size="34rpx" tone="blue" /><text class="section-title"
              >这一段的成长</text
            ></view
          ><text class="caption">{{ dateFrom }} — {{ dateTo }}</text></view
        >
        <view class="records-stat-grid"
          ><view class="records-stat"
            ><text class="records-stat-value records-positive">{{
              growth.points?.earned ?? '—'
            }}</text
            ><text class="records-stat-label">赚取积分</text></view
          ><view class="records-stat records-stat-divider"
            ><text class="records-stat-value">{{ growth.points?.spent ?? '—' }}</text
            ><text class="records-stat-label">兑换支出</text></view
          ></view
        >
        <text class="records-footnote">赚取不包含退款或预留释放；日常和挑战分别统计。</text>
      </view>
      <scroll-view v-if="page !== 'ledger'" scroll-x class="records-tabs-scroll"
        ><view class="tabs records-tabs"
          ><button
            v-if="childPage"
            :class="{ active: tab === 'ledger' }"
            @tap="
              tab = 'ledger';
              type = '';
              status = '';
              act(refreshRecords);
            "
          >
            积分明细</button
          ><button
            :class="{ active: tab === 'activities' }"
            @tap="
              tab = 'activities';
              type = '';
              status = '';
              act(refreshRecords);
            "
          >
            完成记录</button
          ><button
            v-if="!childPage"
            :class="{ active: tab === 'record' }"
            @tap="
              tab = 'record';
              act(refreshRecords);
            "
          >
            代录补记</button
          ><button
            v-if="!childPage"
            :class="{ active: tab === 'orders' }"
            @tap="
              tab = 'orders';
              status = '';
              act(refreshRecords);
            "
          >
            兑换</button
          ><button
            v-if="!childPage"
            :class="{ active: tab === 'audit' }"
            @tap="
              tab = 'audit';
              act(refreshRecords);
            "
          >
            操作记录
          </button></view
        ></scroll-view
      >

      <view v-if="tab === 'record'" class="records-date-card"
        ><view class="records-title-with-icon"
          ><AppIcon name="calendar" size="32rpx" tone="blue" /><text class="field-label"
            >真实发生日期</text
          ></view
        ><picker
          mode="date"
          :start="daysAgo(7)"
          :end="businessDate()"
          :value="recordDate"
          @change="
            recordDate = $event.detail.value;
            act(refreshRecords);
          "
          ><view class="select-control records-single-date"
            ><text>{{ recordDate }}</text
            ><AppIcon name="chevron" size="26rpx" tone="muted" /></view></picker
        ><text class="records-footnote"
          >日常支持今天和过去 7 个业务日，共 8 个日期；只能补真实存在的适用实例。</text
        ></view
      >
      <view v-else class="records-date-range"
        ><AppIcon name="calendar" size="30rpx" tone="muted" /><picker
          class="records-date-picker"
          mode="date"
          :value="dateFrom"
          :end="dateTo"
          @change="
            dateFrom = $event.detail.value;
            act(refreshRecords);
          "
          ><view class="records-date-value"
            ><text class="records-date-label">从</text><text>{{ dateFrom }}</text></view
          ></picker
        ><text class="records-date-dash">—</text
        ><picker
          class="records-date-picker"
          mode="date"
          :value="dateTo"
          :start="dateFrom"
          :end="businessDate()"
          @change="
            dateTo = $event.detail.value;
            act(refreshRecords);
          "
          ><view class="records-date-value"
            ><text class="records-date-label">至</text><text>{{ dateTo }}</text></view
          ></picker
        ></view
      >

      <template v-if="ledgerTab">
        <view class="chip-row records-filter-chips"
          ><button
            v-for="t in [
              '',
              'ACTIVITY_AWARD',
              'PRAISE',
              'ORDER_HOLD',
              'ORDER_CAPTURE',
              'ORDER_RELEASE',
              'ORDER_REFUND',
              'AWARD_REVERSAL',
            ]"
            :key="t || 'all'"
            class="chip"
            :class="{ active: type === t }"
            @tap="
              type = t;
              act(() => loadLedger());
            "
          >
            {{ t ? label(t) : '全部' }}
          </button></view
        >
        <view class="records-list">
          <view
            v-for="entry in entries"
            :key="entry.id"
            class="records-ledger-card"
            @tap="expanded = expanded === entry.id ? '' : entry.id"
          >
            <view class="records-ledger-row"
              ><view
                class="records-entry-icon"
                :class="{ 'records-entry-positive': entry.availableDelta > 0 }"
                ><AppIcon
                  :name="
                    entry.type === 'PRAISE'
                      ? 'heart'
                      : entry.availableDelta > 0
                        ? 'plus'
                        : 'history'
                  "
                  size="34rpx"
                  :tone="entry.availableDelta > 0 ? 'blue' : 'muted'" /></view
              ><view class="grow"
                ><text class="records-entry-title">{{ label(entry.type) }}</text
                ><text class="records-entry-reason">{{
                  entry.reason || '查看关联记录'
                }}</text></view
              ><view class="records-amount-group"
                ><text
                  class="records-amount"
                  :class="{ 'records-positive': entry.availableDelta > 0 }"
                  >{{ entry.availableDelta > 0 ? '+' : '' }}{{ entry.availableDelta }}</text
                ><text class="records-amount-label">可用积分</text></view
              ></view
            >
            <view class="records-ledger-meta"
              ><text>{{ dateTime(entry.createdAt) }}</text
              ><view class="records-held-line"
                ><text>预留 {{ entry.heldDelta > 0 ? '+' : '' }}{{ entry.heldDelta }}</text
                ><AppIcon
                  :name="expanded === entry.id ? 'arrow' : 'chevron'"
                  size="24rpx"
                  tone="muted" /></view
            ></view>
            <template v-if="expanded === entry.id">
              <view class="records-detail"
                ><view class="summary-row"
                  ><text class="summary-label">变动后可用 / 预留</text
                  ><text class="summary-value"
                    >{{ entry.availableAfter }} / {{ entry.heldAfter }}</text
                  ></view
                ><view class="summary-row"
                  ><text class="summary-label">操作人</text
                  ><text class="summary-value">{{
                    displayOperator(entry.operatorSummary)
                  }}</text></view
                ><view class="summary-row"
                  ><text class="summary-label">账户版本</text
                  ><text class="summary-value">{{ entry.accountVersion }}</text></view
                ></view
              >
              <text v-if="entry.reversalOfId" class="caption section"
                >更正原记录 {{ entry.reversalOfId }}</text
              >
              <button
                v-if="
                  !session.isFamilyReadOnly &&
                  !childPage &&
                  ['ACTIVITY_AWARD', 'PRAISE'].includes(entry.type) &&
                  !entry.reversed &&
                  entry.availableDelta > 0
                "
                class="danger-button full section"
                @tap.stop="
                  selected = entry;
                  reason = '';
                "
              >
                纠正这次记录（完整撤销）
              </button>
            </template>
          </view>
        </view>
        <EmptyState
          v-if="!entries.length && !loading"
          title="这段时间没有积分记录"
          description="每一次入账、预留和兑换都会在这里说明。"
        />
        <LoadMore :has-more="hasMore" :loading="busy" @more="act(more)" />

        <view
          v-if="
            !session.isFamilyReadOnly &&
            !childPage &&
            children.find((c) => c.id === childId)?.status === 'ACTIVE'
          "
          class="records-panel records-praise-panel"
          ><view class="records-title-with-icon"
            ><view class="records-icon-tile records-icon-warm"
              ><AppIcon name="heart" size="34rpx" tone="orange" /></view
            ><view
              ><text class="section-title">值得被看见的小进步</text
              ><text class="caption">给一次具体的表扬</text></view
            ></view
          ><view class="field"
            ><text class="field-label">增加积分</text
            ><input class="input records-points-input" v-model="points" type="number" /></view
          ><view class="field"
            ><text class="field-label">表扬原因（必填）</text
            ><textarea
              class="textarea"
              v-model="reason"
              maxlength="200"
              placeholder="说清楚值得肯定的具体行为"
            /></view
          ><button
            :class="{ 'is-disabled': busy || !!account?.grantBlockedByCap || !!account?.frozen }"
            class="primary full"
            :disabled="busy || !!account?.grantBlockedByCap || !!account?.frozen"
            :loading="busy"
            @tap="praise"
          >
            确认表扬并加分</button
          ><text v-if="account?.grantBlockedByCap" class="field-error"
            >当前总持有达到新发分上限，暂不能继续发分。</text
          ></view
        >
        <view v-if="selected" class="records-panel records-correction-panel"
          ><view class="records-title-with-icon"
            ><AppIcon name="shield" size="36rpx" tone="orange" /><text class="section-title"
              >完整撤销 {{ selected.availableDelta }} 积分</text
            ></view
          ><view class="notice warning section"
            >仅用于纠正错误记录，不是惩罚。原记录不会被删除，同一笔只能撤销一次。</view
          ><text class="body-copy"
            >当前可用 {{ account?.availablePoints }} 积分，申请预留不参与撤销。</text
          ><textarea
            v-model="reason"
            class="textarea section"
            maxlength="200"
            placeholder="请说明纠正原因"
          /><button
            :class="{
              'is-disabled': busy || (account?.availablePoints ?? 0) < selected.availableDelta,
            }"
            class="danger-button full section"
            :loading="busy"
            :disabled="busy || (account?.availablePoints ?? 0) < selected.availableDelta"
            @tap="reverse"
          >
            确认完整撤销</button
          ><text
            v-if="(account?.availablePoints ?? 0) < selected.availableDelta"
            class="field-error"
            >可用积分不足，无法撤销。</text
          ><button
            class="text-button full"
            @tap="
              selected = null;
              reason = '';
            "
          >
            不修改这条记录
          </button></view
        >
      </template>

      <template v-else-if="tab === 'activities' || tab === 'record'">
        <view v-if="tab === 'activities'" class="records-filters"
          ><view class="chip-row records-filter-chips"
            ><button
              v-for="t in ['', 'ROUTINE', 'CHALLENGE']"
              :key="t || 'all'"
              class="chip"
              :class="{ active: type === t }"
              @tap="
                type = t;
                act(() => loadHistory());
              "
            >
              {{ t ? label(t) : '全部类型' }}
            </button></view
          ><view class="chip-row records-filter-chips"
            ><button
              v-for="s in [
                '',
                'OPEN',
                'SUBMITTED',
                'NEEDS_CHANGES',
                'APPROVED',
                'EXEMPTED',
                'REVOKED',
              ]"
              :key="s || 'all'"
              class="chip"
              :class="{ active: status === s }"
              @tap="
                status = s;
                act(() => loadHistory());
              "
            >
              {{ s ? label(s) : '全部状态' }}
            </button></view
          ></view
        >
        <view class="records-list"
          ><view
            v-for="o in occurrences"
            :key="o.id"
            class="records-event-card"
            @tap="go(childPage ? 'activity' : 'occurrence', { id: o.id })"
            ><view class="row between"
              ><view class="records-event-kind"
                ><AppIcon
                  :name="o.type === 'ROUTINE' ? 'calendar' : 'star'"
                  size="28rpx"
                  tone="blue"
                /><text>{{ label(o.type) }}</text></view
              ><StatusPill :status="o.displayState || o.status" /></view
            ><text class="records-event-title">{{ o.snapshot.title }}</text
            ><view class="row between records-event-meta"
              ><text class="caption">{{ o.businessDate || dateTime(o.startsAt) }}</text
              ><text class="records-award"
                >{{ o.snapshot.awardPoints }} <text class="records-award-unit">积分</text></text
              ></view
            ><text v-if="o.supplementUntil" class="records-deadline"
              >补充截止 {{ dateTime(o.supplementUntil) }}</text
            ><view class="records-event-footer"
              ><text>{{ tab === 'record' ? '查看并记录完成' : '查看详情' }}</text
              ><AppIcon name="chevron" size="26rpx" tone="blue" /></view></view
        ></view>
        <EmptyState
          v-if="!occurrences.length && !loading"
          :title="tab === 'record' ? '这一天没有适用任务' : '这段时间没有完成记录'"
          description="未曾安排的事项不会算成漏做，也不会产生补记奖励。"
        />
        <LoadMore :has-more="hasMore" :loading="busy" @more="act(more)" />
      </template>

      <template v-else-if="tab === 'orders'">
        <view class="chip-row records-filter-chips"
          ><button
            v-for="s in [
              '',
              'PENDING_APPROVAL',
              'READY',
              'FULFILLED',
              'CANCELED',
              'REJECTED',
              'EXPIRED',
            ]"
            :key="s || 'all'"
            class="chip"
            :class="{ active: status === s }"
            @tap="
              status = s;
              act(() => loadHistory());
            "
          >
            {{ s ? label(s) : '全部' }}
          </button></view
        >
        <view class="records-list"
          ><view
            v-for="o in orders"
            :key="o.id"
            class="records-event-card"
            @tap="go('order', { id: o.id })"
            ><view class="row between"
              ><view class="records-event-kind"
                ><AppIcon name="star" size="28rpx" tone="orange" /><text>奖励兑换</text></view
              ><StatusPill :status="o.status" /></view
            ><text class="records-event-title">{{ o.rewardSnapshot.name }}</text
            ><view class="row between records-event-meta"
              ><text class="caption">申请于 {{ dateTime(o.createdAt) }}</text
              ><text class="records-award"
                >{{ o.costPointsSnapshot }} <text class="records-award-unit">积分</text></text
              ></view
            ><view class="records-event-footer"
              ><text>查看兑换详情</text
              ><AppIcon name="chevron" size="26rpx" tone="blue" /></view></view
        ></view>
        <EmptyState
          v-if="!orders.length && !loading"
          title="没有兑换记录"
          description="每一份申请和兑现都会留下记录。"
        />
        <LoadMore :has-more="hasMore" :loading="busy" @more="act(more)" />
      </template>

      <template v-else-if="tab === 'audit'">
        <view class="records-audit-list"
          ><view v-for="a in audits" :key="a.id" class="records-audit-card"
            ><view class="records-audit-icon"
              ><AppIcon name="history" size="30rpx" tone="muted" /></view
            ><view class="grow"
              ><text class="records-entry-title">{{ auditName(a.action) }}</text
              ><text class="records-entry-reason">{{
                a.operatorName || displayOperator(a.operatorSummary)
              }}</text
              ><text class="caption">{{ dateTime(a.createdAt) }}</text
              ><text v-if="a.reason || a.details?.reason" class="records-audit-reason">{{
                a.reason || a.details?.reason
              }}</text
              ><view v-if="a.targetId || a.sourceId || a.requestId" class="records-audit-reference"
                ><text v-if="a.targetId || a.sourceId">关联记录 {{ a.targetId || a.sourceId }}</text
                ><text v-if="a.requestId">请求号 {{ a.requestId }}</text></view
              ></view
            ></view
          ></view
        >
        <EmptyState
          v-if="!audits.length && !loading"
          title="这段时间没有操作记录"
          description="家长的业务操作会在这里留痕。"
        />
        <LoadMore :has-more="hasMore" :loading="busy" @more="act(more)" />
      </template>
      <button
        v-if="childPage && !session.isDelegated"
        class="records-account-link"
        @tap="go('account')"
      >
        <AppIcon name="shield" size="30rpx" tone="muted" /><text>我的账号与隐私</text
        ><AppIcon name="chevron" size="26rpx" tone="muted" />
      </button>
    </view>
  </AppShell>
</template>

<style lang="scss">
.records-ui {
  color: #1c1c1e;
}
.records-child-filter {
  display: flex;
  align-items: center;
  gap: 22rpx;
  padding: 26rpx 28rpx;
  margin-bottom: 26rpx;
  background: #fff;
  border-radius: 34rpx;
}
.records-icon-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 68rpx;
  height: 68rpx;
  border-radius: 22rpx;
  background: #edf5ff;
}
.records-icon-warm {
  background: #fff5e8;
}
.records-filter-label {
  display: block;
  color: #8e8e93;
  font-size: 22rpx;
  line-height: 1.5;
}
.records-child-picker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  padding-top: 4rpx;
  font-size: 31rpx;
  font-weight: 600;
  line-height: 1.5;
}
.records-growth {
  margin: 22rpx 0 28rpx;
  padding: 30rpx;
  border-radius: 38rpx;
  background: #fff;
}
.records-growth-heading {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}
.records-title-with-icon {
  display: flex;
  align-items: center;
  gap: 14rpx;
}
.records-stat-grid {
  display: flex;
  align-items: center;
  margin: 32rpx 0 26rpx;
}
.records-stat {
  flex: 1;
  padding: 0 12rpx;
}
.records-stat-divider {
  padding-left: 36rpx;
  border-left: 1rpx solid #ededf1;
}
.records-stat-value {
  display: block;
  font-size: 56rpx;
  font-weight: 680;
  letter-spacing: -2rpx;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.records-stat-label {
  display: block;
  margin-top: 12rpx;
  font-size: 24rpx;
  color: #8e8e93;
}
.records-positive {
  color: #007aff;
}
.records-footnote {
  display: block;
  color: #8e8e93;
  font-size: 22rpx;
  line-height: 1.65;
}
.records-tabs-scroll {
  margin: 22rpx 0;
  white-space: nowrap;
}
.records-tabs {
  display: inline-flex;
  min-width: 100%;
  flex-wrap: nowrap;
  gap: 4rpx;
  margin: 0;
  padding: 8rpx;
  box-sizing: border-box;
}
.records-tabs button {
  flex: 1 0 auto;
  min-width: 112rpx;
  padding: 16rpx 12rpx;
  font-size: 23rpx;
  line-height: 1.4;
  white-space: nowrap;
}
.records-date-card {
  margin: 22rpx 0;
  padding: 28rpx;
  border-radius: 34rpx;
  background: #fff;
}
.records-date-card .field-label {
  margin-bottom: 0;
}
.records-single-date {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 20rpx 0 14rpx;
}
.records-date-range {
  display: flex;
  align-items: center;
  gap: 14rpx;
  margin: 22rpx 0;
  padding: 22rpx;
  border-radius: 28rpx;
  background: #fff;
}
.records-date-picker {
  flex: 1;
  min-width: 0;
}
.records-date-value {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  font-size: 24rpx;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.records-date-label {
  color: #8e8e93;
  font-size: 21rpx;
  font-weight: 400;
}
.records-date-dash {
  color: #c7c7cc;
  font-size: 22rpx;
}
.records-filter-chips {
  gap: 12rpx;
  margin: 18rpx 0;
}
.records-filter-chips .chip {
  min-height: 58rpx;
  padding: 12rpx 20rpx;
  font-size: 23rpx;
  font-weight: 500;
}
.records-filters {
  margin-bottom: 24rpx;
}
.records-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}
.records-ledger-card {
  padding: 28rpx;
  background: #fff;
  border-radius: 34rpx;
  border: 1rpx solid rgba(28, 28, 30, 0.03);
}
.records-ledger-row {
  display: flex;
  align-items: center;
  gap: 18rpx;
}
.records-entry-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 68rpx;
  height: 68rpx;
  border-radius: 23rpx;
  background: #f2f3f7;
}
.records-entry-positive {
  background: #edf5ff;
}
.records-entry-title {
  display: block;
  font-size: 29rpx;
  font-weight: 600;
  line-height: 1.45;
}
.records-entry-reason {
  display: block;
  margin-top: 5rpx;
  color: #8e8e93;
  font-size: 23rpx;
  line-height: 1.6;
  overflow-wrap: break-word;
}
.records-amount-group {
  flex-shrink: 0;
  max-width: 45%;
  text-align: right;
}
.records-amount {
  display: block;
  font-size: 35rpx;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -1rpx;
  font-variant-numeric: tabular-nums;
}
.records-amount-label {
  display: block;
  margin-top: 3rpx;
  font-size: 21rpx;
  color: #8e8e93;
}
.records-ledger-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  padding-top: 22rpx;
  margin-top: 22rpx;
  border-top: 1rpx solid #f1f1f4;
  color: #8e8e93;
  font-size: 21rpx;
  line-height: 1.5;
}
.records-held-line {
  display: flex;
  align-items: center;
  gap: 8rpx;
}
.records-detail {
  margin-top: 22rpx;
  padding: 8rpx 22rpx;
  border-radius: 24rpx;
  background: #f7f8fb;
}
.records-panel {
  padding: 30rpx;
  margin: 30rpx 0;
  background: #fff;
  border: 1rpx solid rgba(28, 28, 30, 0.035);
  border-radius: 36rpx;
}
.records-praise-panel .caption {
  margin-top: 6rpx;
}
.records-points-input {
  font-variant-numeric: tabular-nums;
}
.records-correction-panel {
  border-color: #f0dfc3;
}
.records-event-card {
  padding: 28rpx;
  background: #fff;
  border-radius: 34rpx;
  border: 1rpx solid rgba(28, 28, 30, 0.03);
}
.records-event-kind {
  display: flex;
  align-items: center;
  gap: 9rpx;
  font-size: 23rpx;
  color: #8e8e93;
  line-height: 1.4;
}
.records-event-title {
  display: block;
  margin: 20rpx 0 14rpx;
  font-size: 32rpx;
  font-weight: 620;
  line-height: 1.45;
}
.records-event-meta {
  gap: 16rpx;
}
.records-award {
  flex-shrink: 0;
  font-size: 30rpx;
  font-weight: 620;
  color: #1c1c1e;
  line-height: 1.4;
}
.records-award-unit {
  color: #8e8e93;
  font-size: 22rpx;
  font-weight: 400;
}
.records-deadline {
  display: block;
  margin-top: 14rpx;
  color: #986126;
  font-size: 23rpx;
  line-height: 1.5;
}
.records-event-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-top: 24rpx;
  padding-top: 20rpx;
  border-top: 1rpx solid #f0f0f3;
  color: #007aff;
  font-size: 25rpx;
  line-height: 1.5;
}
.records-audit-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}
.records-audit-card {
  display: flex;
  align-items: flex-start;
  gap: 20rpx;
  padding: 28rpx;
  background: #fff;
  border-radius: 34rpx;
}
.records-audit-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 58rpx;
  height: 58rpx;
  border-radius: 19rpx;
  background: #f2f3f7;
}
.records-audit-card .caption {
  margin-top: 6rpx;
}
.records-audit-reason {
  display: block;
  margin-top: 20rpx;
  font-size: 26rpx;
  line-height: 1.65;
  color: #636366;
}
.records-audit-reference {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  margin-top: 20rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #f0f0f3;
  color: #8e8e93;
  font-size: 20rpx;
  line-height: 1.65;
  word-break: break-all;
}
.records-account-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  width: 100%;
  margin-top: 34rpx;
  padding: 26rpx;
  border-radius: 30rpx;
  background: #fff;
  color: #636366;
  font-size: 25rpx;
  line-height: 1.5;
}
</style>
