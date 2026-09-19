<script setup lang="ts">
defineProps<{hasMore?:boolean;loading?:boolean}>();defineEmits<{more:[]}>();
</script>
<template><view class="load-more"><button :class="{'is-disabled':(loading)}" v-if="hasMore" class="secondary" :loading="loading" :disabled="loading" @tap="$emit('more')">加载更多</button><text v-else class="caption">已经到底了</text></view></template>
