<script setup lang="ts">
import {computed} from 'vue'
const props=withDefaults(defineProps<{name?:string;tone?:string;size?:string;label?:string}>(),{name:'sparkle',tone:'ink',size:'40rpx',label:''})
const source=computed(()=>`/static/icons/${props.name}-${props.tone}.png`)
</script>
<template><image class="app-icon" :src="source" :style="{width:size,height:size}" mode="aspectFit" :aria-label="label"/></template>
