<script setup lang="ts">
defineProps<{ hasMore?: boolean; loading?: boolean }>();
defineEmits<{ more: [] }>();
</script>
<template>
  <view v-if="hasMore" class="load-more"
    ><button
      :class="{ 'is-disabled': loading }"
      class="secondary"
      :loading="loading"
      :disabled="loading"
      @tap="$emit('more')"
    >
      加载更多
    </button></view
  >
</template>
