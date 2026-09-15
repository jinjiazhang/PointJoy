<script setup lang="ts">
defineProps<{name:string,size?:number,light?:boolean}>();
</script>
<template><image :src="'/static/icons/'+name+'.svg'" :style="{width:(size||20)+'px',height:(size||20)+'px',filter:light?'brightness(0) invert(1)':'none'}" mode="aspectFit" /></template>
