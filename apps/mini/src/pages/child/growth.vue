<script setup lang="ts">
import {ref} from 'vue'
import {onLoad,onShow,onPullDownRefresh} from '@dcloudio/uni-app'
import Screen from '../../features/RecordsScreen.vue'
const params=ref<Record<string,string>>({});const ready=ref(false)
onLoad(options=>{params.value=Object.fromEntries(Object.entries(options||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));ready.value=true})
onShow(()=>uni.$emit('page:visible','growth'))
onPullDownRefresh(()=>uni.$emit('page:visible','growth'))
</script>
<template><Screen v-if="ready" page="growth" :query="params"/></template>
