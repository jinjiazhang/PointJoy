<script setup lang="ts">
import {ref} from 'vue'
import {onLoad,onShow,onPullDownRefresh} from '@dcloudio/uni-app'
import Screen from '../../features/FamilyScreen.vue'
const params=ref<Record<string,string>>({});const ready=ref(false)
onLoad(options=>{params.value=Object.fromEntries(Object.entries(options||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));ready.value=true})
onShow(()=>uni.$emit('page:visible','child'))
onPullDownRefresh(()=>uni.$emit('page:visible','child'))
</script>
<template><Screen v-if="ready" page="child" :query="params"/></template>
