<script setup lang="ts">
import type {Account} from '../services/types';defineProps<{account?:Account|null}>();
</script>
<template><view class="balance-card"><view><text class="caption">可用积分</text><text class="balance-value">{{account?.availablePoints??'—'}}</text></view><view><text class="caption">申请预留</text><text class="hold-value">{{account?.heldPoints??'—'}} <text class="caption">积分</text></text></view><text class="balance-note">预留还没有花掉，只是在等家长同意。</text><text v-if="account?.frozen" class="field-error section">积分记录正在核对，请稍后联系家庭负责人处理。历史记录仍可查看。</text></view></template>
