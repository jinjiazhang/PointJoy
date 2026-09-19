<script setup lang="ts">
import {ref,watch} from 'vue'
import {mediaUrl} from '../services/media'
const props=withDefaults(defineProps<{mediaId?:string|null;alt?:string;avatar?:boolean;size?:string}>(),{alt:'图片',avatar:false,size:'80rpx'})
const url=ref(''),error=ref('');let generation=0
async function load(force=false){const n=++generation;if(!props.mediaId){url.value='';return}try{const result=await mediaUrl(props.mediaId,force);if(n===generation){url.value=result;error.value=''}}catch{if(n===generation){url.value='';error.value='图片暂不可用'}}}
function imageFailed(){url.value='';error.value='图片暂不可用'}
watch(()=>props.mediaId,()=>load(),{immediate:true})
</script>
<template><view class="private-image" :class="{avatar}" :style="{width:size,height:size}"><image v-if="url" :src="url" mode="aspectFill" :aria-label="alt" @error="imageFailed"/><text v-else class="image-placeholder">{{error?'重试':'◇'}}</text><button v-if="error" class="image-retry" @tap="load(true)" :aria-label="error+'，重试'"/></view></template>
