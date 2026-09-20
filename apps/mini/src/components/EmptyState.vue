<script setup lang="ts">
import AppIcon from './AppIcon.vue';
withDefaults(defineProps<{ title?: string; description?: string }>(), {
  title: '这里还没有记录',
  description: '每一件小事，都可以慢慢积攒。',
});
</script>
<template>
  <view class="empty-state"
    ><view class="empty-art"><AppIcon name="leaf" tone="green" size="68rpx" /></view
    ><text class="empty-title">{{ title }}</text
    ><text class="muted">{{ description }}</text
    ><slot
  /></view>
</template>
