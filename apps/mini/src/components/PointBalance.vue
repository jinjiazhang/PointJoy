<script setup lang="ts">
import type { Account } from '../services/types';
import AppIcon from './AppIcon.vue';
defineProps<{ account?: Account | null }>();
</script>
<template>
  <view class="balance-card"
    ><view class="balance-main"
      ><view class="balance-label"
        ><AppIcon name="sparkle" tone="blue" size="30rpx" /><text>可用积分</text></view
      ><view class="balance-number-row"
        ><text class="balance-value">{{ account?.availablePoints ?? '—' }}</text
        ><text class="balance-unit">可使用</text></view
      ></view
    ><view class="balance-reserved"
      ><AppIcon name="clock" tone="muted" size="30rpx" /><text class="hold-value">{{
        account?.heldPoints ?? '—'
      }}</text
      ><text class="caption">申请预留</text></view
    ><text class="balance-note">每一份努力，都离心愿更近一点。</text
    ><text v-if="account?.frozen" class="field-error"
      >积分记录正在核对，请联系家庭负责人。历史记录仍可查看。</text
    ></view
  >
</template>
