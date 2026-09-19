<script setup lang="ts">
withDefaults(defineProps<{title?:string;description?:string}>(),{title:'这里还没有记录',description:'每一件小事，都可以慢慢积攒。'});
</script>
<template><view class="empty-state"><text class="empty-sprout">♧</text><text class="section-title">{{title}}</text><text class="muted">{{description}}</text><slot/></view></template>
