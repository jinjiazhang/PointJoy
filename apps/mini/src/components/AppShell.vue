<script setup lang="ts">
import {computed,ref,onMounted,onUnmounted} from 'vue'
import {currentPending} from '../services/api'
import {useSession} from '../stores/session'
import {go,back as navigateBack,type RouteName} from '../services/navigation'
import AppIcon from './AppIcon.vue'
const props=withDefaults(defineProps<{title?:string;subtitle?:string;back?:boolean;tab?:string;loading?:boolean;error?:string;busy?:boolean;publicPage?:boolean}>(),{title:'',subtitle:'',back:false,tab:'',loading:false,error:'',busy:false,publicPage:false})
defineEmits<{retry:[]}>();const session=useSession()
const pendingCount=ref(currentPending().length);const refreshPending=()=>{pendingCount.value=currentPending().length}
onMounted(()=>{uni.$on('operations:changed',refreshPending);uni.$on('auth:changed',refreshPending)})
onUnmounted(()=>{uni.$off('operations:changed',refreshPending);uni.$off('auth:changed',refreshPending)})
const navMetrics={height:48,status:0,right:18}
// #ifdef MP-WEIXIN
navMetrics.status=24
try{const info=uni.getSystemInfoSync(),capsule=uni.getMenuButtonBoundingClientRect();navMetrics.status=info.statusBarHeight||24;if(!capsule.width||capsule.bottom<=navMetrics.status)throw new Error('Capsule metrics unavailable');navMetrics.height=capsule.bottom+8;navMetrics.right=Math.max(100,info.windowWidth-capsule.left+12)}catch{navMetrics.height=navMetrics.status+44;navMetrics.right=108}
// #endif
const tabs=computed(()=>session.isChild?[['today','今天','sun'],['wishes','心愿','heart'],['growth','成长','chart']]:[['home','首页','home'],['plans','计划','list'],['rewards','奖励','gift'],['family','家庭','family']])
const familyLabel=computed(()=>session.isGuardian?session.family?.family.name||'我的家庭':session.isDelegated?'家长入口':'我的账号')
const familyActionLabel=computed(()=>session.isGuardian?`${familyLabel.value}，切换家庭`:familyLabel.value)
function topAction(){if(session.isDelegated)go('pin',{purpose:'exit'});else if(session.isChild)go('account');else go('contexts')}
function switchTab(route:string){if(route!==props.tab)go(route as RouteName,{},true)}
</script>
<template>
 <view class="app-shell" :class="{'has-tabs':tab,'child-ui':session.isChild,'public-shell':publicPage}">
  <view class="ambient ambient-blue"/><view class="ambient ambient-mint"/>
  <view class="system-bar" :style="{height:navMetrics.height+'px',paddingTop:navMetrics.status+'px',paddingRight:navMetrics.right+'px'}">
   <button v-if="back" class="nav-back" aria-label="返回上一页" @tap="navigateBack(session.isChild?'today':session.isGuardian?'home':'contexts')"><AppIcon name="arrow" size="38rpx"/></button>
   <button v-else-if="tab&&!publicPage" class="nav-family" :aria-label="familyActionLabel" @tap="topAction"><text class="nav-family-name">{{familyLabel}}</text><view class="nav-family-chevron"><AppIcon name="chevron" tone="muted" size="24rpx"/></view></button>
   <text v-if="title" class="nav-title">{{title}}</text>
  </view>
  <view class="page-body">
   <text v-if="subtitle" class="page-subtitle">{{subtitle}}</text>
   <view v-if="session.isFamilyReadOnly" class="notice read-only-banner"><AppIcon name="archive" tone="muted" size="32rpx"/><text>家庭已归档，业务记录只读。</text></view>
   <view v-if="loading" class="loading-box"><view class="skeleton"/><view class="skeleton short"/><text class="caption">正在更新…</text></view>
   <view v-if="error" class="notice error" role="alert"><text>{{error}}</text><button class="text-button" @tap="$emit('retry')">重新尝试</button></view>
   <view v-if="pendingCount" class="notice warning"><text>{{pendingCount}}次操作等待确认</text><button class="text-button" @tap="go('recovery')">查看进度</button></view>
   <slot/>
  </view>
  <view v-if="tab" class="tab-bar"><view class="bottom-nav"><button v-for="item in tabs" :key="item[0]" class="nav-item" :class="{active:tab===item[0]}" :aria-label="item[1]" @tap="switchTab(item[0])"><view class="nav-icon-wrap"><AppIcon :name="item[2]" :tone="tab===item[0]?'blue':'muted'" size="43rpx"/></view><text>{{item[1]}}</text></button></view></view>
 </view>
</template>
