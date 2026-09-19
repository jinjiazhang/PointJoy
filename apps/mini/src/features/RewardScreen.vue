<script setup lang="ts">
import {ref,computed} from 'vue'
import AppShell from '../components/AppShell.vue'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import StatusPill from '../components/StatusPill.vue'
import PointBalance from '../components/PointBalance.vue'
import LoadMore from '../components/LoadMore.vue'
import {usePage} from '../composables/usePage'
import {get,getAll,mutate,familyPath,childPath} from '../services/api'
import {go} from '../services/navigation'
import {label,dateTime,integer} from '../services/format'
import type {Reward,Availability,Account,Order,Wish,Child,PageResult} from '../services/types'
const props=defineProps<{page:string;query:Record<string,string>}>()
const isChildPage=['wishes','childReward','orders','childOrder'].includes(props.page)
const rewards=ref<Reward[]>([]),orders=ref<Order[]>([]),reward=ref<Reward|null>(null),order=ref<Order|null>(null),account=ref<Account|null>(null),availability=ref<Availability|null>(null),wish=ref<Wish|null>(null),children=ref<Child[]>([]),childId=ref(props.query.childId||''),tab=ref(props.query.tab||'catalog'),status=ref(''),category=ref(''),cursor=ref<string|null>(null),hasMore=ref(false),orderCursor=ref<string|null>(null),ordersMore=ref(false),confirmRequest=ref(false),action=ref(''),reason=ref(''),childReason=ref('CHANGED_MIND'),note=ref(''),delivered=ref(false),stockDelta=ref(''),stockReason=ref('')
const form=ref({name:'',description:'',category:'TIME',benefitDescription:'',timeMinutes:'20',artKey:'game',costPoints:'30',stockMode:'UNLIMITED',initialStock:'0',weeklyLimit:'',childIds:[] as string[]})
const categories=['TIME','FOOD','ITEM','EXPERIENCE'];const artKeys=['game','icecream','fries','gift','book','outing'];const artNames=['游戏','冰淇淋','薯条','礼物','图书','共同出游'];const childReasons=['我改变主意了','以后再兑换','我想取消'];const childReasonCodes=['CHANGED_MIND','WAIT_FOR_LATER','OTHER']
const titles:Record<string,string>={rewards:'奖励',rewardEdit:props.query.id?'编辑奖励':'添加奖励',reward:'奖励详情',order:'兑换详情',wishes:'心愿',childReward:'奖励详情',orders:'我的兑换',childOrder:'兑换详情'}
const {loading,error,busy,reload,act,session}=usePage(props.page,load,isChildPage?'child':'guardian')
const selectedChild=computed(()=>childId.value||session.view?.childId||'')
const activeOrder=computed(()=>order.value?.allowedActions.includes('CANCEL'))
const rewardIcon=(r?:Partial<Reward>|null)=>['game','icecream','fries','book','outing'].includes(r?.artKey||'')?r!.artKey!:r?.category==='EXPERIENCE'?'outing':'gift'
const artColor=(r?:Partial<Reward>|null)=>r?.artKey==='icecream'?'rose':r?.artKey==='fries'?'peach':r?.artKey==='book'||r?.category==='EXPERIENCE'?'mint':r?.artKey==='game'||r?.category==='TIME'?'blue':'lavender'
const iconTone=(r?:Partial<Reward>|null)=>artColor(r)==='mint'?'green':artColor(r)==='peach'?'orange':'blue'
const wishPercent=computed(()=>Math.min(100,Math.max(0,(wish.value?.progress||0)<=1?(wish.value?.progress||0)*100:wish.value?.progress||0)))
const stockExpanded=ref(false)
const orderHeading=computed(()=>({PENDING_APPROVAL:'等待家长的回应',READY:'这份心愿，获准啦',FULFILLED:'美好已经兑现',CANCELED:'这次申请已取消',REJECTED:'下次再一起商量',EXPIRED:'这次申请已到期'} as Record<string,string>)[order.value?.status||'']||'兑换进展')
const orderMessage=computed(()=>order.value?.status==='PENDING_APPROVAL'?`已为你预留 ${order.value.costPointsSnapshot} 积分，批准后才会花掉。`:order.value?.status==='READY'?'和家长一起安排一个合适的时间。':order.value?.status==='FULFILLED'?'这份约定已完整提供，不能取消或退款。':'积分释放或退款结果，请以最新账本为准。')
async function load(){
 if(!isChildPage){children.value=await getAll<Child>(familyPath('/children'),{status:'ACTIVE'});if(!childId.value&&children.value.length===1)childId.value=children.value[0].id}
 if(props.page==='rewards'){await loadRewards();if(tab.value==='orders')await loadOrders();return}
 if(props.page==='wishes'){[account.value,wish.value]=await Promise.all([get<Account>(childPath(undefined,'/account')),get<Wish>(childPath(undefined,'/wish'))]);await Promise.all([loadRewards(),loadOrders()]);return}
 if(props.page==='orders'){await loadOrders();return}
 if(['order','childOrder'].includes(props.page)){order.value=await get<Order>(familyPath(`/orders/${props.query.id}`));account.value=await get<Account>(childPath(order.value.childId,'/account'));return}
 if(props.query.id){reward.value=await get<Reward>(familyPath(`/rewards/${props.query.id}`));if(props.page==='rewardEdit'){const r=reward.value;form.value={name:r.name,description:r.description||'',category:r.category,benefitDescription:r.benefitDescription,timeMinutes:String(r.timeMinutes||20),artKey:r.artKey||'gift',costPoints:String(r.costPoints),stockMode:r.stockMode,initialStock:String(r.stockAvailable||0),weeklyLimit:r.weeklyLimit?String(r.weeklyLimit):'',childIds:r.childIds||[]}}else if(selectedChild.value)await loadAvailability()}
}
async function loadRewards(more=false){const result=await get<PageResult<Reward>>(familyPath('/rewards'),{status:isChildPage?undefined:status.value||undefined,category:category.value||undefined,childId:isChildPage?session.view?.childId:childId.value||undefined,cursor:more?cursor.value:undefined});rewards.value=more?[...rewards.value,...result.items]:result.items;cursor.value=result.nextCursor||null;hasMore.value=result.hasMore}
async function loadOrders(more=false){const result=await get<PageResult<Order>>(isChildPage?childPath(undefined,'/orders'):familyPath('/orders'),{status:status.value||undefined,childId:!isChildPage?childId.value||undefined:undefined,cursor:more?orderCursor.value:undefined});orders.value=more?[...orders.value,...result.items]:result.items;orderCursor.value=result.nextCursor||null;ordersMore.value=result.hasMore}
async function loadAvailability(){if(!reward.value||!selectedChild.value)return;[availability.value,account.value]=await Promise.all([get<Availability>(childPath(selectedChild.value,`/reward-availability/${reward.value.id}`)),get<Account>(childPath(selectedChild.value,'/account'))])}
function toggleChild(id:string){form.value.childIds=form.value.childIds.includes(id)?form.value.childIds.filter(x=>x!==id):[...form.value.childIds,id]}
async function saveReward(publish=false){await act(async()=>{const f=form.value;if([...f.name.trim()].length<2||[...f.name.trim()].length>40)throw new Error('奖励名称需2—40字');if(!f.benefitDescription.trim()||[...f.benefitDescription.trim()].length>200)throw new Error('请用1—200字说清楚一份奖励是什么');if(!integer(f.costPoints,1,100000))throw new Error('奖励积分需为1—100,000的整数');if(f.category==='TIME'&&!integer(f.timeMinutes,1,1440))throw new Error('时间奖励需为1—1,440整分钟');if(f.weeklyLimit!==''&&!integer(f.weeklyLimit,1,100))throw new Error('每周次数需为1—100的整数，或留空表示不限');if(!f.childIds.length)throw new Error('至少选择一名适用孩子');if(f.stockMode==='FINITE'&&!integer(f.initialStock,0,1000000))throw new Error('初始库存需为0—1,000,000的整数');const body={name:f.name.trim(),description:f.description.trim(),category:f.category,benefitDescription:f.benefitDescription.trim(),...(f.category==='TIME'?{timeMinutes:Number(f.timeMinutes)}:{timeMinutes:null}),artKey:f.artKey,costPoints:Number(f.costPoints),stockMode:f.stockMode,weeklyLimit:f.weeklyLimit===''?null:Number(f.weeklyLimit),childIds:f.childIds,...(!reward.value?(f.stockMode==='FINITE'?{initialStock:Number(f.initialStock)}:{}):{expectedVersion:reward.value.version})};let saved=await mutate<Reward>(reward.value?'PATCH':'POST',reward.value?familyPath(`/rewards/${reward.value.id}`):familyPath('/rewards'),body,'保存奖励');if(publish)saved=await mutate<Reward>('POST',familyPath(`/rewards/${saved.id}/status`),{status:'ACTIVE',expectedVersion:saved.version},'上架奖励');go('reward',{id:saved.id},true)},publish?'奖励已上架':'奖励已保存')}
async function changeStatus(next:string){await act(async()=>{const accepted=await new Promise<boolean>(resolve=>uni.showModal({title:next==='ARCHIVED'?'归档奖励':'更新奖励状态',content:'这只影响新的兑换申请，已有订单仍按原约定批准、兑现或取消。',success:r=>resolve(r.confirm)}));if(!accepted)return;reward.value=await mutate<Reward>('POST',familyPath(`/rewards/${reward.value!.id}/status`),{status:next,expectedVersion:reward.value!.version},'更新奖励状态')})}
async function adjustStock(){await act(async()=>{if(!integer(stockDelta.value,-1000000,1000000)||Number(stockDelta.value)===0||!stockReason.value.trim())throw new Error('请输入非零整数库存变化和原因');await mutate('POST',familyPath(`/rewards/${reward.value!.id}/stock-adjustments`),{delta:Number(stockDelta.value),reason:stockReason.value.trim(),expectedStockVersion:reward.value!.stockVersion},'调整奖励库存');stockDelta.value='';stockReason.value='';await load()},'库存已更新')}
async function setWish(){await act(async()=>{if(!selectedChild.value)throw new Error('请先选择孩子');const current=await get<Wish>(childPath(selectedChild.value,'/wish'));await mutate('PUT',childPath(selectedChild.value,'/wish'),{rewardId:reward.value!.id,...(current.wish?{expectedVersion:current.wish.version}:{})},'设置当前心愿');uni.showToast({title:'已设为当前心愿，不预留积分',icon:'none'})})}
async function clearWish(){await act(async()=>{if(!wish.value?.wish)return;await mutate('DELETE',childPath(undefined,'/wish'),{expectedVersion:wish.value.wish.version},'清除心愿目标');wish.value=await get<Wish>(childPath(undefined,'/wish'))})}
async function beginRequest(){await act(async()=>{if(!selectedChild.value)throw new Error('请选择受益孩子');await loadAvailability();if(!availability.value?.canRequest)throw new Error((availability.value?.blockingReasons||[]).map(reasonLabel).join('；')||'暂时不能申请');confirmRequest.value=true})}
async function submitRequest(){await act(async()=>{if(!availability.value||!reward.value)return;const result=await mutate<{order:Order;account:Account}>('POST',childPath(selectedChild.value,'/orders'),{rewardId:reward.value.id,expectedRewardVersion:availability.value.rewardVersion,expectedCostPoints:availability.value.costPoints},'申请兑换奖励');confirmRequest.value=false;account.value=result.account;go(isChildPage?'childOrder':'order',{id:result.order.id},true)},'申请已提交，积分已预留')}
function reasonLabel(code:string){return ({ACCOUNT_FROZEN:'积分记录正在核对，请稍后联系家庭负责人处理',INSUFFICIENT_POINTS:'可用积分不足',OUT_OF_STOCK:'这份奖励暂时没有库存',WEEKLY_LIMIT_REACHED:'本周申请次数已用完',REWARD_UNAVAILABLE:'奖励暂未上架',NOT_APPLICABLE:'这份奖励没有安排给当前孩子'} as Record<string,string>)[code]||code}
function beginAction(next:string){error.value='';action.value=next;reason.value='';note.value='';delivered.value=false}
async function orderAction(){await act(async()=>{const o=order.value!;if(['cancel','reject'].includes(action.value)&&!isChildPage&&!reason.value.trim())throw new Error('请填写原因');if(action.value==='fulfill'&&!delivered.value)throw new Error('请确认已经实际提供完整奖励');const body={expectedVersion:o.version,...(action.value==='approve'?{arrangementNote:note.value.trim()}:action.value==='fulfill'?{note:note.value.trim()}:isChildPage?{reasonCode:childReason.value}:{reason:reason.value.trim()})};await mutate('POST',familyPath(`/orders/${o.id}/${action.value}`),body,({approve:'批准兑换',reject:'拒绝兑换',cancel:'取消未兑现订单',fulfill:'确认已实际兑现'} as Record<string,string>)[action.value]);action.value='';await load()},'订单已更新')}
const filters=computed(()=>props.page==='orders'||tab.value==='orders'?['','PENDING_APPROVAL','READY','FULFILLED','CANCELED','REJECTED','EXPIRED']:['','ACTIVE','INACTIVE','DRAFT','ARCHIVED'])
</script>
<template>
  <AppShell :title="titles[page]" :tab="page==='rewards'?'rewards':page==='wishes'?'wishes':''" :back="!['rewards','wishes'].includes(page)" :loading="loading" :error="error" @retry="reload">
    <view class="rw-page">
      <template v-if="page==='rewardEdit'&&!session.isFamilyReadOnly">
        <view class="rw-editor-preview">
          <view class="rw-preview-art" :class="'rw-art-'+artColor({artKey:form.artKey})"><AppIcon :name="rewardIcon({artKey:form.artKey})" size="76rpx" :tone="iconTone({artKey:form.artKey})"/></view>
          <view class="rw-flex"><text class="rw-overline">一份值得期待的奖励</text><text class="rw-preview-title">{{form.name||'给努力一个小惊喜'}}</text><text class="rw-preview-points">{{form.costPoints||'0'}}<text class="rw-point-unit"> 积分 / 份</text></text></view>
        </view>
        <view class="rw-panel">
          <text class="rw-section-title">这份奖励</text>
          <view class="field"><text class="field-label">名称</text><input class="input" v-model="form.name" maxlength="40" placeholder="例如：一起游戏20分钟"/></view>
          <view class="field"><text class="field-label">类别</text><picker :range="categories.map(label)" :value="categories.indexOf(form.category)" @change="form.category=categories[Number($event.detail.value)]"><view class="select-control rw-select"><text>{{label(form.category)}}</text><AppIcon name="chevron" size="26rpx" tone="muted"/></view></picker></view>
          <view class="field"><text class="field-label">具体包含什么</text><textarea class="textarea" v-model="form.benefitDescription" maxlength="200" placeholder="写下数量、内容和兑现的方式，和孩子约定清楚。"/></view>
          <view v-if="form.category==='TIME'" class="field"><text class="field-label">每份时长</text><view class="rw-input-unit"><input class="rw-plain-input" type="number" v-model="form.timeMinutes"/><text class="rw-unit-label">分钟</text></view><text class="rw-help">这是家庭时间约定，一次完整使用。</text></view>
          <view class="field"><text class="field-label">更多说明<text class="rw-optional">选填</text></text><textarea class="textarea" v-model="form.description" maxlength="500" placeholder="例如：周末完成后，一起选个合适的时间。"/></view>
          <view class="field"><text class="field-label">奖励图案</text><view class="rw-art-options"><button v-for="(key,index) in artKeys" :key="key" class="rw-art-option" :class="{'rw-art-option-selected':form.artKey===key}" @tap="form.artKey=key"><view class="rw-art-option-icon" :class="'rw-art-'+artColor({artKey:key})"><AppIcon :name="key" size="40rpx" :tone="iconTone({artKey:key})"/></view><text class="rw-art-option-label">{{artNames[index]}}</text></button></view></view>
        </view>
        <view class="rw-panel">
          <text class="rw-section-title">兑换约定</text>
          <view class="field"><text class="field-label">每份需要多少积分</text><view class="rw-input-unit"><input class="rw-plain-input" type="number" v-model="form.costPoints"/><text class="rw-unit-label">积分</text></view></view>
          <view class="field"><text class="field-label">适用孩子</text><view class="rw-child-options"><button v-for="c in children" :key="c.id" class="rw-child-chip" :class="{'rw-child-chip-selected':form.childIds.includes(c.id)}" @tap="toggleChild(c.id)"><AppIcon v-if="form.childIds.includes(c.id)" name="check" size="25rpx" tone="blue"/><text>{{c.nickname}}</text></button></view><text v-if="!children.length" class="rw-help">先在家庭中添加孩子，再为孩子安排奖励。</text></view>
          <view class="field"><text class="field-label">库存方式</text><view class="rw-segments"><button class="rw-segment" :disabled="!!reward&&reward.status!=='DRAFT'" :class="{'rw-segment-active':form.stockMode==='UNLIMITED'}" @tap="form.stockMode='UNLIMITED'">不限量</button><button class="rw-segment" :disabled="!!reward&&reward.status!=='DRAFT'" :class="{'rw-segment-active':form.stockMode==='FINITE'}" @tap="form.stockMode='FINITE'">有限份数</button></view><text class="rw-help">发布后保留库存方式，份数可在奖励详情中调整。</text></view>
          <view v-if="form.stockMode==='FINITE'&&!reward" class="field"><text class="field-label">初始份数</text><view class="rw-input-unit"><input class="rw-plain-input" v-model="form.initialStock" type="number"/><text class="rw-unit-label">份</text></view></view>
          <view class="field"><text class="field-label">每个孩子每周最多兑换<text class="rw-optional">选填</text></text><input class="input" v-model="form.weeklyLimit" type="number" placeholder="留空不限次数，或填写1—100"/><text class="rw-help">每周一重新计算，已有申请保留原申请周的次数。</text></view>
        </view>
        <view class="rw-soft-note"><AppIcon name="shield" size="32rpx" tone="muted"/><text class="rw-soft-note-copy">修改价格和内容后，已经申请的订单仍按原约定兑现。</text></view>
        <view class="rw-button-stack"><button class="primary rw-action-button" :class="{'is-disabled':busy}" :loading="busy" :disabled="busy" @tap="saveReward(true)">保存并上架</button><button class="rw-light-button" :disabled="busy" @tap="saveReward(false)">保存{{reward?'修改':'为草稿'}}</button></view>
      </template>

      <template v-else-if="['rewards','wishes','orders'].includes(page)">
        <template v-if="page==='wishes'">
          <PointBalance :account="account"/>
          <view v-if="wish?.rewardSummary" class="rw-wish-card">
            <view class="rw-wish-top"><view class="rw-inline"><AppIcon name="heart" size="28rpx" tone="blue"/><text class="rw-overline rw-blue-text">当前心愿</text></view><button class="rw-subtle-button" :disabled="busy" @tap="clearWish">换一个</button></view>
            <view class="rw-wish-main" @tap="go('childReward',{id:wish.rewardSummary.id})"><view class="rw-flex"><text class="rw-wish-title">{{wish.rewardSummary.name}}</text><text class="rw-wish-description">{{wish.rewardSummary.status!=='ACTIVE'?'这份奖励暂时不能兑换':wish.pointsGap>0?`再攒 ${wish.pointsGap} 积分，就更近一步`:'想要的积分，已经攒够了'}}</text></view><view class="rw-wish-art" :class="'rw-art-'+artColor(wish.rewardSummary)"><AppIcon :name="rewardIcon(wish.rewardSummary)" size="68rpx" :tone="iconTone(wish.rewardSummary)"/></view></view>
            <view class="rw-progress-track"><view class="rw-progress-fill" :style="{width:wishPercent+'%'}"/></view>
            <view class="rw-wish-footer"><text class="rw-progress-label"><text class="rw-progress-current">{{account?.availablePoints??0}}</text> / {{wish.rewardSummary.costPoints}} 积分</text><button class="rw-link-button" @tap="go('childReward',{id:wish.rewardSummary.id})"><text>看看心愿</text><AppIcon name="chevron" size="24rpx" tone="blue"/></button></view>
          </view>
          <view v-else class="rw-wish-empty"><view class="rw-wish-empty-icon"><AppIcon name="heart" size="48rpx" tone="blue"/></view><text class="rw-section-title">下一份期待是什么？</text><text class="rw-help rw-center-text">从下面选一个喜欢的奖励，设为心愿，慢慢靠近它。</text></view>
          <view class="rw-section-head"><text class="rw-section-title">我的兑换</text><button class="rw-link-button" @tap="go('orders')"><text>查看全部</text><AppIcon name="chevron" size="24rpx" tone="blue"/></button></view>
          <view v-if="orders.length" class="rw-recent-panel"><view v-for="o in orders.slice(0,3)" :key="o.id" class="rw-recent-row" @tap="go('childOrder',{id:o.id})"><view class="rw-small-art" :class="'rw-art-'+artColor(o.rewardSnapshot)"><AppIcon :name="rewardIcon(o.rewardSnapshot)" size="36rpx" :tone="iconTone(o.rewardSnapshot)"/></view><view class="rw-flex"><text class="rw-row-title">{{o.rewardSnapshot.name}}</text><text class="rw-meta">{{o.costPointsSnapshot}} 积分 / 份</text></view><StatusPill :status="o.status"/><AppIcon name="chevron" size="23rpx" tone="muted"/></view></view>
          <view v-else class="rw-recent-empty"><AppIcon name="clock" size="34rpx" tone="muted"/><text>申请之后，在这里等家长的回应。</text></view>
          <view class="rw-section-head"><view><text class="rw-section-title">发现小奖励</text><text class="rw-section-subtitle">每一点努力，都值得期待。</text></view><AppIcon name="sparkle" size="34rpx" tone="blue"/></view>
        </template>

        <view v-if="page==='rewards'" class="rw-catalog-top"><view class="rw-segments rw-flex"><button class="rw-segment" :class="{'rw-segment-active':tab==='catalog'}" @tap="tab='catalog';status='';act(()=>loadRewards())">奖励库</button><button class="rw-segment" :class="{'rw-segment-active':tab==='orders'}" @tap="tab='orders';status='';act(()=>loadOrders())">兑换订单</button></view><button v-if="!session.isFamilyReadOnly" class="rw-add-button" aria-label="添加奖励" @tap="go('rewardEdit')"><AppIcon name="plus" size="38rpx" tone="white"/></button></view>
        <view v-if="!isChildPage&&children.length" class="rw-filter-heading"><text class="rw-helper-title">{{tab==='orders'?'查看兑换进展':'把喜欢的事，变成小小奖励'}}</text><picker :range="['全部孩子',...children.map(c=>c.nickname)]" :value="children.findIndex(c=>c.id===childId)+1" @change="childId=children[Number($event.detail.value)-1]?.id||'';act(()=>tab==='orders'?loadOrders():loadRewards())"><view class="rw-child-filter"><text>{{children.find(c=>c.id===childId)?.nickname||'全部孩子'}}</text><AppIcon name="chevron" size="22rpx" tone="muted"/></view></picker></view>
        <scroll-view v-if="page!=='wishes'" class="rw-filter-scroll" scroll-x><view class="rw-filter-items"><button v-for="s in filters" :key="s||'all'" class="rw-filter-chip" :class="{'rw-filter-chip-active':status===s}" @tap="status=s;act(()=>page==='orders'||tab==='orders'?loadOrders():loadRewards())">{{s?label(s):'全部'}}</button></view></scroll-view>

        <template v-if="page==='orders'||page==='rewards'&&tab==='orders'">
          <view class="rw-orders-list"><view v-for="o in orders" :key="o.id" class="rw-order-card" @tap="go(isChildPage?'childOrder':'order',{id:o.id})"><view class="rw-order-card-top"><view class="rw-medium-art" :class="'rw-art-'+artColor(o.rewardSnapshot)"><AppIcon :name="rewardIcon(o.rewardSnapshot)" size="48rpx" :tone="iconTone(o.rewardSnapshot)"/></view><view class="rw-flex"><text class="rw-row-title">{{o.rewardSnapshot.name}}</text><text class="rw-meta">{{o.child?.nickname||o.childNickname||'我的奖励'}} · 一份</text></view><AppIcon name="chevron" size="26rpx" tone="muted"/></view><view class="rw-order-card-bottom"><StatusPill :status="o.status"/><text class="rw-order-cost">{{o.costPointsSnapshot}}<text class="rw-point-unit"> 积分</text></text></view><text class="rw-order-date">{{dateTime(o.createdAt)}} 申请</text></view></view>
          <EmptyState v-if="!orders.length&&!loading" title="还没有兑换记录" description="申请一份喜欢的奖励，就能在这里看见它的进展。"/>
          <LoadMore :has-more="ordersMore" :loading="busy" @more="act(()=>loadOrders(true))"/>
        </template>
        <template v-else>
          <scroll-view class="rw-filter-scroll rw-categories-scroll" scroll-x><view class="rw-filter-items"><button class="rw-category-chip" :class="{'rw-category-chip-active':!category}" @tap="category='';act(()=>loadRewards())">全部奖励</button><button v-for="c in categories" :key="c" class="rw-category-chip" :class="{'rw-category-chip-active':category===c}" @tap="category=c;act(()=>loadRewards())">{{label(c)}}</button></view></scroll-view>
          <view class="rw-reward-grid"><view v-for="r in rewards" :key="r.id" class="rw-reward-card" @tap="go(isChildPage?'childReward':'reward',{id:r.id})"><view class="rw-card-art" :class="'rw-art-'+artColor(r)"><view class="rw-art-orbit"/><AppIcon :name="rewardIcon(r)" size="72rpx" :tone="iconTone(r)"/><text class="rw-category-tag">{{label(r.category)}}</text></view><view class="rw-reward-card-content"><text class="rw-reward-name">{{r.name}}</text><text class="rw-reward-price">{{r.costPoints}}<text class="rw-point-unit"> 积分</text></text><view class="rw-reward-card-footer"><text class="rw-meta">{{r.stockMode==='UNLIMITED'?'不限份数':`剩余 ${r.stockAvailable??0} 份`}}</text><AppIcon v-if="isChildPage" name="chevron" size="24rpx" tone="muted"/></view><view v-if="!isChildPage" class="rw-card-status"><StatusPill :status="r.status"/></view></view></view></view>
          <EmptyState v-if="!rewards.length&&!loading" title="这里还没有奖励" :description="isChildPage?'和家长商量一下，添加一份喜欢的小奖励吧。':'从一次游戏、一份小食，或一段共同的时光开始。'"/>
          <button v-if="!isChildPage&&!rewards.length&&!loading&&!session.isFamilyReadOnly" class="rw-light-button" @tap="go('rewardEdit')">添加第一份奖励</button>
          <LoadMore :has-more="hasMore" :loading="busy" @more="act(()=>loadRewards(true))"/>
        </template>
      </template>

      <template v-else-if="['reward','childReward'].includes(page)&&reward">
        <view class="rw-detail-hero"><view class="rw-detail-art" :class="'rw-art-'+artColor(reward)"><view class="rw-detail-orbit"/><AppIcon :name="rewardIcon(reward)" size="100rpx" :tone="iconTone(reward)"/></view><text class="rw-detail-category">{{label(reward.category)}}</text><text class="rw-detail-title">{{reward.name}}</text><text class="rw-detail-price">{{reward.costPoints}}<text class="rw-detail-unit"> 积分 / 份</text></text><view v-if="!isChildPage" class="rw-detail-status"><StatusPill :status="reward.status"/></view></view>
        <view class="rw-panel"><text class="rw-section-title">这份小美好</text><text class="rw-description">{{reward.benefitDescription}}</text><text v-if="reward.description" class="rw-description rw-muted-text">{{reward.description}}</text><view v-if="reward.category==='TIME'" class="rw-inline-note"><AppIcon name="clock" size="30rpx" tone="blue"/><text>一次 {{reward.timeMinutes}} 分钟，按约定完整提供。</text></view></view>
        <view v-if="!isChildPage" class="rw-panel rw-child-selection"><text class="rw-section-title">为谁申请</text><picker :range="children.map(c=>c.nickname)" :value="Math.max(0,children.findIndex(c=>c.id===childId))" @change="childId=children[Number($event.detail.value)]?.id;act(loadAvailability)"><view class="select-control rw-select"><text>{{children.find(c=>c.id===childId)?.nickname||'选择一个孩子'}}</text><AppIcon name="chevron" size="26rpx" tone="muted"/></view></picker></view>
        <PointBalance v-if="account" :account="account"/>
        <view class="rw-panel rw-facts"><view class="rw-fact-row"><text class="rw-fact-label">可兑换份数</text><text class="rw-fact-value">{{reward.stockMode==='UNLIMITED'?'不限量':`${availability?.stockAvailable??reward.stockAvailable??0} 份`}}</text></view><view class="rw-fact-row"><text class="rw-fact-label">每周约定</text><text class="rw-fact-value">{{reward.weeklyLimit?`每人最多 ${reward.weeklyLimit} 次`:'不限次数'}}</text></view><view v-if="availability?.weeklyRemaining!=null" class="rw-fact-row"><text class="rw-fact-label">本周还可申请</text><text class="rw-fact-value">{{availability.weeklyRemaining}} 次</text></view></view>
        <view v-if="availability&&!availability.canRequest" class="rw-alert"><AppIcon name="clock" size="32rpx" tone="orange"/><text class="rw-soft-note-copy">{{availability.blockingReasons.map(reasonLabel).join('；')}}</text></view>
        <view v-if="!session.isFamilyReadOnly" class="rw-button-stack"><button class="primary rw-action-button" :class="{'is-disabled':busy||!selectedChild||!!availability&&!availability.canRequest}" :disabled="busy||!selectedChild||!!availability&&!availability.canRequest" @tap="beginRequest">{{isChildPage?'申请这份奖励':'为孩子申请兑换'}}</button><button v-if="selectedChild" class="rw-light-button rw-icon-button" :disabled="busy" @tap="setWish"><AppIcon name="heart" size="30rpx" tone="blue"/><text>设为当前心愿</text></button><text class="rw-bottom-hint">设为心愿不预留积分，申请后由家长确认。</text></view>
        <template v-if="!session.isFamilyReadOnly&&!isChildPage&&reward.status!=='ARCHIVED'">
          <view class="rw-section-head rw-management-heading"><text class="rw-section-title">管理奖励</text><text class="rw-meta">只影响新的兑换申请</text></view>
          <view class="rw-management-panel"><button class="rw-management-row" @tap="go('rewardEdit',{id:reward.id})"><text>编辑奖励内容</text><AppIcon name="chevron" size="26rpx" tone="muted"/></button><button class="rw-management-row" @tap="changeStatus(reward.status==='ACTIVE'?'INACTIVE':'ACTIVE')"><text>{{reward.status==='ACTIVE'?'下架，暂停新申请':'上架奖励'}}</text><AppIcon name="chevron" size="26rpx" tone="muted"/></button><button v-if="reward.stockMode==='FINITE'" class="rw-management-row" @tap="stockExpanded=!stockExpanded"><text>调整库存</text><view class="rw-inline"><text class="rw-meta">当前 {{reward.stockAvailable??0}} 份</text><AppIcon name="plus" size="26rpx" tone="blue"/></view></button><button class="rw-management-row rw-danger-text" @tap="changeStatus('ARCHIVED')"><text>归档奖励</text><AppIcon name="chevron" size="26rpx" tone="muted"/></button></view>
          <view v-if="stockExpanded&&reward.stockMode==='FINITE'" class="rw-panel"><text class="rw-section-title">调整库存份数</text><view class="field"><text class="field-label">增加或减少</text><input class="input" v-model="stockDelta" type="text" placeholder="例如 3 或 -1，不能为 0"/></view><view class="field"><text class="field-label">调整原因</text><input class="input" v-model="stockReason" maxlength="200" placeholder="例如：新准备了三份"/></view><button class="primary rw-action-button" :class="{'is-disabled':busy}" :disabled="busy" @tap="adjustStock">确认调整</button></view>
        </template>
      </template>

      <template v-else-if="['order','childOrder'].includes(page)&&order">
        <view class="rw-order-hero"><view class="rw-order-state-icon" :class="order.status==='FULFILLED'||order.status==='READY'?'rw-art-mint':'rw-art-blue'"><AppIcon :name="order.status==='PENDING_APPROVAL'?'clock':order.status==='FULFILLED'?'gift':order.status==='READY'?'check':'arrow'" size="54rpx" :tone="order.status==='FULFILLED'||order.status==='READY'?'green':'blue'"/></view><text class="rw-order-heading">{{orderHeading}}</text><text class="rw-order-message">{{orderMessage}}</text><StatusPill :status="order.status"/></view>
        <view class="rw-panel"><view class="rw-order-card-top"><view class="rw-medium-art" :class="'rw-art-'+artColor(order.rewardSnapshot)"><AppIcon :name="rewardIcon(order.rewardSnapshot)" size="48rpx" :tone="iconTone(order.rewardSnapshot)"/></view><view class="rw-flex"><text class="rw-row-title">{{order.rewardSnapshot.name}}</text><text class="rw-meta">{{order.child?.nickname||order.childNickname||children.find(c=>c.id===order?.childId)?.nickname||(isChildPage?'我的兑换':'孩子的兑换')}} · 一份奖励</text></view></view><text class="rw-description">{{order.rewardSnapshot.benefitDescription}}</text><view class="rw-order-snapshot-price"><text class="rw-fact-label">本次约定积分</text><text class="rw-order-cost">{{order.costPointsSnapshot}}<text class="rw-point-unit"> 积分</text></text></view></view>
        <PointBalance :account="account"/>
        <view class="rw-panel"><text class="rw-section-title">兑换进展</text><view class="rw-timeline"><view class="rw-timeline-item"><view class="rw-timeline-icon"><AppIcon name="check" size="24rpx" tone="blue"/></view><view class="rw-flex"><text class="rw-timeline-title">已提交申请</text><text class="rw-meta">{{dateTime(order.createdAt)}}</text><text v-if="order.status==='PENDING_APPROVAL'" class="rw-timeline-note">等待家长在 {{dateTime(order.approvalExpiresAt)}} 前确认</text></view></view><view v-if="order.approvedAt" class="rw-timeline-item"><view class="rw-timeline-icon"><AppIcon name="check" size="24rpx" tone="blue"/></view><view class="rw-flex"><text class="rw-timeline-title">家长已批准</text><text class="rw-meta">{{dateTime(order.approvedAt)}}</text><text v-if="order.arrangementNote" class="rw-timeline-note">{{order.arrangementNote}}</text></view></view><view v-if="order.fulfilledAt" class="rw-timeline-item"><view class="rw-timeline-icon rw-art-mint"><AppIcon name="gift" size="25rpx" tone="green"/></view><view class="rw-flex"><text class="rw-timeline-title">奖励已经兑现</text><text class="rw-meta">{{dateTime(order.fulfilledAt)}}</text><text v-if="order.fulfillmentNote" class="rw-timeline-note">{{order.fulfillmentNote}}</text></view></view><view v-if="order.canceledAt||order.decisionReason" class="rw-timeline-item"><view class="rw-timeline-icon"><AppIcon name="arrow" size="24rpx" tone="muted"/></view><view class="rw-flex"><text class="rw-timeline-title">{{label(order.status)}}</text><text v-if="order.canceledAt" class="rw-meta">{{dateTime(order.canceledAt)}}</text><text v-if="order.decisionReason" class="rw-timeline-note">{{order.decisionReason}}</text></view></view></view><text class="rw-week-note">兑换次数计入 {{order.requestWeekStart}} 开始的这一周。</text></view>
        <view v-if="!session.isFamilyReadOnly" class="rw-button-stack"><template v-if="!isChildPage&&order.allowedActions.includes('APPROVE')"><button class="primary rw-action-button" @tap="beginAction('approve')">批准兑换 · {{order.costPointsSnapshot}} 积分</button><button class="rw-light-button" @tap="beginAction('reject')">暂不同意</button></template><button v-if="!isChildPage&&order.allowedActions.includes('FULFILL')" class="primary rw-action-button" @tap="beginAction('fulfill')">确认已经兑现</button><button v-if="activeOrder" class="rw-light-button" @tap="beginAction('cancel')">{{order.status==='READY'?'取消并退还积分':'取消这次申请'}}</button></view>
      </template>
    </view>

    <view v-if="confirmRequest&&reward&&availability&&account" class="rw-sheet-shade" @tap="!busy&&(confirmRequest=false)"><view class="rw-sheet" @tap.stop><view class="rw-sheet-handle"/><scroll-view class="rw-sheet-scroll" scroll-y><view class="rw-sheet-heading"><view class="rw-small-art" :class="'rw-art-'+artColor(reward)"><AppIcon :name="rewardIcon(reward)" size="36rpx" :tone="iconTone(reward)"/></view><view class="rw-flex"><text class="rw-sheet-title">确认这份约定</text><text class="rw-meta">{{reward.name}} · 一份</text></view></view><view class="rw-confirm-price"><text class="rw-confirm-number">{{availability.costPoints}}</text><text class="rw-detail-unit">积分，先为你预留</text></view><view class="rw-sheet-facts"><view class="rw-fact-row"><text class="rw-fact-label">申请后可用</text><text class="rw-fact-value">{{account.availablePoints-availability.costPoints}} 积分</text></view><view class="rw-fact-row"><text class="rw-fact-label">申请后预留</text><text class="rw-fact-value">{{account.heldPoints+availability.costPoints}} 积分</text></view></view><view class="rw-soft-note"><AppIcon name="clock" size="30rpx" tone="blue"/><text class="rw-soft-note-copy">家长批准后才花掉积分。72 小时未批准，预留会自动释放。家长代申请也需要批准。</text></view></scroll-view><view class="rw-sheet-actions"><view v-if="error" class="notice error" role="alert">{{error}}</view><button class="primary rw-action-button" :class="{'is-disabled':busy}" :loading="busy" :disabled="busy" @tap="submitRequest">确认申请</button><button class="rw-sheet-cancel" :disabled="busy" @tap="confirmRequest=false">再想一想</button></view></view></view>

    <view v-if="action&&order" class="rw-sheet-shade" @tap="!busy&&(action='')"><view class="rw-sheet" @tap.stop><view class="rw-sheet-handle"/><scroll-view class="rw-sheet-scroll" scroll-y><text class="rw-sheet-title">{{action==='approve'?'批准这份小期待':action==='fulfill'?'这份奖励已经兑现':action==='reject'?'暂不同意这次申请':'取消这次兑换'}}</text><text class="rw-sheet-description">{{action==='approve'?'批准后，预留积分会正式花掉。接下来和孩子约好兑现的时间。':action==='fulfill'?'请在实际提供完整奖励之后确认，确认后不能取消或退款。':`将按原价返还 ${order.costPointsSnapshot} 积分，并恢复有限库存和原申请周的次数。`}}</text><view v-if="action==='fulfill'" class="rw-delivered-check" @tap="delivered=!delivered"><checkbox :checked="delivered" color="#007AFF"/><text class="rw-soft-note-copy">已经给了孩子约定的完整奖励</text></view><view v-if="['approve','fulfill'].includes(action)" class="field"><text class="field-label">{{action==='approve'?'安排说明':'兑现说明'}}<text class="rw-optional">选填</text></text><textarea class="textarea" v-model="note" maxlength="200" :placeholder="action==='approve'?'例如：周六午饭后，一起安排。':'记录一下这次美好的兑现。'"/></view><view v-else-if="isChildPage" class="field"><text class="field-label">取消的原因</text><picker :range="childReasons" :value="childReasonCodes.indexOf(childReason)" @change="childReason=childReasonCodes[Number($event.detail.value)]"><view class="select-control rw-select"><text>{{childReasons[childReasonCodes.indexOf(childReason)]}}</text><AppIcon name="chevron" size="26rpx" tone="muted"/></view></picker></view><view v-else class="field"><text class="field-label">告诉孩子原因</text><textarea class="textarea" v-model="reason" maxlength="200" placeholder="温柔说明这次安排，也可以约定下一次。"/></view></scroll-view><view class="rw-sheet-actions"><view v-if="error" class="notice error" role="alert">{{error}}</view><button class="primary rw-action-button" :class="{'is-disabled':busy}" :loading="busy" :disabled="busy" @tap="orderAction">{{action==='approve'?'确认批准':action==='fulfill'?'确认已经兑现':action==='reject'?'确认暂不批准':'确认取消'}}</button><button class="rw-sheet-cancel" :disabled="busy" @tap="action=''">返回</button></view></view></view>
  </AppShell>
</template>

<style lang="scss">
.rw-page { padding-bottom: 24rpx; }
.rw-flex { flex: 1; min-width: 0; }
.rw-inline { display: flex; align-items: center; gap: 12rpx; }
.rw-panel { background: #fff; border: 1rpx solid rgba(32, 47, 70, .035); border-radius: 36rpx; padding: 32rpx; margin-bottom: 24rpx; box-shadow: 0 8rpx 28rpx rgba(31, 49, 83, .025); }
.rw-section-title { display: block; font-size: 32rpx; line-height: 1.45; font-weight: 650; letter-spacing: -.5rpx; color: #1c1c1e; }
.rw-section-subtitle { display: block; font-size: 24rpx; color: #8a8d97; margin-top: 8rpx; }
.rw-section-head { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; margin: 36rpx 4rpx 22rpx; }
.rw-overline { font-size: 23rpx; font-weight: 550; color: #8a8d97; }
.rw-help { display: block; color: #8a8d97; font-size: 24rpx; line-height: 1.65; margin-top: 14rpx; }
.rw-meta { display: block; color: #8a8d97; font-size: 23rpx; line-height: 1.6; }
.rw-blue-text { color: #007aff; }
.rw-muted-text { color: #7f8390; }
.rw-center-text { text-align: center; }
.rw-optional { margin-left: 14rpx; color: #a0a3ad; font-size: 23rpx; font-weight: 400; }
.rw-select { display: flex; align-items: center; justify-content: space-between; gap: 14rpx; }
.rw-editor-preview { display: flex; align-items: center; gap: 26rpx; padding: 12rpx 8rpx 36rpx; }
.rw-preview-art { width: 136rpx; height: 136rpx; border-radius: 38rpx; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.rw-preview-title { display: block; font-size: 31rpx; font-weight: 650; color: #1c1c1e; line-height: 1.4; margin-top: 12rpx; }
.rw-preview-points { display: block; font-size: 32rpx; font-weight: 650; color: #007aff; margin-top: 10rpx; }
.rw-point-unit { font-size: 22rpx; font-weight: 450; color: #8b8e98; }
.rw-input-unit { display: flex; align-items: center; gap: 18rpx; min-height: 98rpx; border-radius: 24rpx; background: #f5f6fa; padding: 0 26rpx; }
.rw-plain-input { flex: 1; min-width: 0; font-size: 32rpx; font-weight: 550; color: #1c1c1e; height: 94rpx; }
.rw-unit-label { font-size: 26rpx; color: #8a8d97; }
.rw-art-options { display: flex; flex-wrap: wrap; gap: 12rpx; }
.rw-art-option { width: 30%; margin: 0; padding: 14rpx 6rpx; background: #fafbfe; border-radius: 24rpx; border: 2rpx solid transparent; line-height: 1.3; }
.rw-art-option-selected { background: #f1f7ff; border-color: #95c4ff; }
.rw-art-option-icon { width: 72rpx; height: 72rpx; border-radius: 23rpx; margin: 0 auto 10rpx; display: flex; align-items: center; justify-content: center; }
.rw-art-option-label { font-size: 23rpx; color: #646873; }
.rw-child-options { display: flex; flex-wrap: wrap; gap: 14rpx; }
.rw-child-chip { display: flex; align-items: center; justify-content: center; gap: 10rpx; margin: 0; padding: 18rpx 26rpx; border-radius: 22rpx; font-size: 27rpx; line-height: 1.4; color: #666b76; background: #f5f6fa; }
.rw-child-chip-selected { background: #eaf3ff; color: #007aff; }
.rw-segments { display: flex; align-items: center; padding: 8rpx; gap: 6rpx; background: #e9ecf2; border-radius: 27rpx; }
.rw-segment { flex: 1; margin: 0; background: transparent; color: #818590; border-radius: 20rpx; padding: 17rpx 10rpx; line-height: 1.35; font-size: 27rpx; font-weight: 550; }
.rw-segment-active { background: #fff; color: #1c1c1e; box-shadow: 0 3rpx 12rpx rgba(44, 56, 78, .065); }
.rw-soft-note { display: flex; align-items: flex-start; gap: 14rpx; padding: 20rpx 10rpx; }
.rw-soft-note-copy { flex: 1; min-width: 0; color: #818590; font-size: 24rpx; line-height: 1.75; }
.rw-button-stack { display: flex; flex-direction: column; gap: 16rpx; margin: 28rpx 0; }
.rw-action-button { width: 100%; margin: 0; min-height: 98rpx; border-radius: 28rpx; font-size: 29rpx; font-weight: 600; }
.rw-light-button { width: 100%; min-height: 94rpx; margin: 0; border-radius: 28rpx; background: #eaf2ff; color: #007aff; font-size: 28rpx; font-weight: 550; padding: 25rpx 22rpx; line-height: 1.5; }
.rw-icon-button { display: flex; align-items: center; justify-content: center; gap: 14rpx; }
.rw-wish-card { margin: 24rpx 0 8rpx; padding: 28rpx 32rpx 32rpx; border: 1rpx solid #e5effe; border-radius: 40rpx; background: linear-gradient(125deg, #fff 35%, #edf5ff 100%); box-shadow: 0 10rpx 32rpx rgba(42, 85, 137, .04); }
.rw-wish-top { display: flex; align-items: center; justify-content: space-between; }
.rw-subtle-button { background: transparent; margin: 0; padding: 4rpx 0 4rpx 18rpx; line-height: 1.5; color: #9a9da6; font-size: 23rpx; }
.rw-wish-main { display: flex; align-items: center; gap: 20rpx; padding: 22rpx 0 28rpx; }
.rw-wish-title { display: block; font-size: 38rpx; font-weight: 650; line-height: 1.35; letter-spacing: -.8rpx; color: #1c1c1e; }
.rw-wish-description { display: block; color: #818b9a; font-size: 24rpx; line-height: 1.6; margin-top: 14rpx; }
.rw-wish-art { width: 116rpx; height: 116rpx; border-radius: 34rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.rw-progress-track { background: #e4eaf3; height: 12rpx; border-radius: 20rpx; overflow: hidden; }
.rw-progress-fill { height: 12rpx; background: linear-gradient(90deg, #6db3ff, #007aff); border-radius: 20rpx; }
.rw-wish-footer { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; margin-top: 20rpx; }
.rw-progress-label { font-size: 23rpx; color: #8b94a3; }
.rw-progress-current { font-size: 29rpx; color: #007aff; font-weight: 650; }
.rw-link-button { display: flex; align-items: center; gap: 7rpx; margin: 0; background: transparent; color: #007aff; padding: 8rpx 0; line-height: 1.4; font-size: 24rpx; font-weight: 550; }
.rw-wish-empty { padding: 34rpx 34rpx 38rpx; margin-top: 24rpx; border-radius: 36rpx; background: #fff; text-align: center; }
.rw-wish-empty-icon { display: flex; align-items: center; justify-content: center; width: 94rpx; height: 94rpx; margin: 0 auto 22rpx; background: #edf5ff; border-radius: 30rpx; }
.rw-recent-panel { background: #fff; border-radius: 32rpx; padding: 6rpx 26rpx; }
.rw-recent-row { display: flex; align-items: center; gap: 18rpx; padding: 22rpx 0; }
.rw-small-art { width: 76rpx; height: 76rpx; border-radius: 24rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.rw-row-title { display: block; font-size: 29rpx; color: #1c1c1e; font-weight: 600; line-height: 1.45; margin-bottom: 6rpx; }
.rw-recent-empty { display: flex; align-items: center; gap: 14rpx; background: #fff; border-radius: 28rpx; color: #9095a0; font-size: 25rpx; line-height: 1.7; padding: 28rpx; }
.rw-catalog-top { display: flex; align-items: center; gap: 20rpx; margin-bottom: 28rpx; }
.rw-add-button { width: 84rpx; height: 84rpx; flex-shrink: 0; border-radius: 27rpx; padding: 0; margin: 0; display: flex; align-items: center; justify-content: center; background: #007aff; box-shadow: 0 8rpx 20rpx rgba(0, 122, 255, .17); }
.rw-filter-heading { display: flex; justify-content: space-between; gap: 14rpx; align-items: center; margin: 0 3rpx 22rpx; }
.rw-helper-title { color: #8b8f9b; font-size: 23rpx; flex: 1; line-height: 1.6; }
.rw-child-filter { display: flex; align-items: center; gap: 8rpx; padding: 10rpx 13rpx; border-radius: 17rpx; color: #777c89; background: #eceff5; font-size: 22rpx; }
.rw-filter-scroll { width: 100%; white-space: nowrap; margin-bottom: 22rpx; }
.rw-filter-items { display: inline-flex; align-items: center; gap: 12rpx; padding: 2rpx 0; }
.rw-filter-chip { display: inline-flex; align-items: center; margin: 0; padding: 13rpx 25rpx; font-size: 24rpx; line-height: 1.5; border-radius: 22rpx; background: #fff; color: #9195a1; }
.rw-filter-chip-active { color: #007aff; background: #e6f0ff; font-weight: 550; }
.rw-category-chip { display: inline-flex; align-items: center; margin: 0; padding: 15rpx 27rpx; border-radius: 22rpx; background: transparent; color: #858b98; font-size: 25rpx; line-height: 1.45; }
.rw-category-chip-active { background: #fff; color: #1c1c1e; font-weight: 600; box-shadow: 0 3rpx 12rpx rgba(48, 66, 93, .025); }
.rw-categories-scroll { margin-top: 0; margin-bottom: 22rpx; }
.rw-reward-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22rpx; }
.rw-reward-card { background: #fff; border-radius: 34rpx; padding: 14rpx; min-width: 0; border: 1rpx solid rgba(32, 47, 70, .025); box-shadow: 0 6rpx 22rpx rgba(40, 56, 88, .025); overflow: hidden; }
.rw-card-art { height: 174rpx; border-radius: 26rpx; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
.rw-art-orbit { position: absolute; width: 122rpx; height: 122rpx; border-radius: 50%; background: rgba(255, 255, 255, .43); }
.rw-category-tag { position: absolute; top: 11rpx; right: 11rpx; color: #8992a4; font-size: 17rpx; padding: 5rpx 11rpx; border-radius: 11rpx; background: rgba(255, 255, 255, .58); }
.rw-reward-card-content { padding: 22rpx 10rpx 10rpx; }
.rw-reward-name { display: block; font-size: 29rpx; font-weight: 600; color: #1c1c1e; line-height: 1.42; min-height: 42rpx; overflow-wrap: anywhere; }
.rw-reward-price { display: block; font-size: 36rpx; color: #007aff; font-weight: 650; line-height: 1.3; margin-top: 16rpx; letter-spacing: -.6rpx; }
.rw-reward-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8rpx; margin-top: 14rpx; }
.rw-card-status { margin-top: 16rpx; }
.rw-art-blue { background: linear-gradient(145deg, #f0f7ff, #dfebff); }
.rw-art-mint { background: linear-gradient(145deg, #effaf5, #dff1e8); }
.rw-art-rose { background: linear-gradient(145deg, #fff4f3, #fbe9ed); }
.rw-art-peach { background: linear-gradient(145deg, #fff7e9, #ffebd4); }
.rw-art-lavender { background: linear-gradient(145deg, #f5f2ff, #eae5fb); }
.rw-orders-list { display: flex; flex-direction: column; gap: 20rpx; }
.rw-order-card { padding: 28rpx; background: #fff; border-radius: 34rpx; box-shadow: 0 6rpx 22rpx rgba(40, 56, 88, .025); }
.rw-order-card-top { display: flex; align-items: center; gap: 22rpx; }
.rw-medium-art { width: 102rpx; height: 102rpx; border-radius: 29rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.rw-order-card-bottom { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; padding-top: 24rpx; margin-top: 24rpx; border-top: 1rpx solid #f1f3f8; }
.rw-order-cost { color: #1c1c1e; font-size: 32rpx; font-weight: 650; }
.rw-order-date { display: block; font-size: 21rpx; color: #a0a4ad; margin-top: 17rpx; }
.rw-detail-hero { display: flex; flex-direction: column; align-items: center; padding: 8rpx 18rpx 44rpx; }
.rw-detail-art { width: 204rpx; height: 204rpx; border-radius: 61rpx; display: flex; align-items: center; justify-content: center; position: relative; margin-bottom: 26rpx; }
.rw-detail-orbit { position: absolute; width: 146rpx; height: 146rpx; border-radius: 50%; background: rgba(255, 255, 255, .42); }
.rw-detail-category { color: #9298a5; font-size: 23rpx; margin-bottom: 12rpx; }
.rw-detail-title { font-size: 44rpx; color: #1c1c1e; font-weight: 700; line-height: 1.35; text-align: center; letter-spacing: -1rpx; }
.rw-detail-price { color: #007aff; font-size: 48rpx; font-weight: 650; margin-top: 18rpx; letter-spacing: -1rpx; }
.rw-detail-unit { color: #8d94a1; font-size: 24rpx; font-weight: 400; letter-spacing: 0; }
.rw-detail-status { margin-top: 22rpx; }
.rw-description { display: block; color: #565d6a; font-size: 28rpx; line-height: 1.85; margin-top: 18rpx; white-space: pre-wrap; }
.rw-inline-note { display: flex; align-items: center; gap: 12rpx; color: #75849a; font-size: 23rpx; line-height: 1.6; margin-top: 26rpx; padding-top: 24rpx; border-top: 1rpx solid #f0f2f6; }
.rw-child-selection { display: flex; flex-direction: column; gap: 22rpx; }
.rw-facts { padding-top: 12rpx; padding-bottom: 12rpx; }
.rw-fact-row { display: flex; align-items: center; justify-content: space-between; gap: 22rpx; padding: 18rpx 0; }
.rw-fact-label { color: #9297a2; font-size: 25rpx; }
.rw-fact-value { color: #424957; font-weight: 550; font-size: 26rpx; text-align: right; }
.rw-alert { display: flex; align-items: flex-start; gap: 14rpx; padding: 23rpx 26rpx; background: #fff4e7; border-radius: 25rpx; margin-bottom: 22rpx; }
.rw-bottom-hint { color: #9a9fab; font-size: 22rpx; line-height: 1.7; text-align: center; margin-top: 0; }
.rw-management-heading { margin-top: 46rpx; }
.rw-management-panel { padding: 8rpx 28rpx; background: #fff; border-radius: 32rpx; margin-bottom: 24rpx; }
.rw-management-row { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; width: 100%; padding: 24rpx 0; margin: 0; background: transparent; font-size: 27rpx; line-height: 1.55; color: #4c5565; text-align: left; }
.rw-danger-text { color: #d86467; }
.rw-order-hero { display: flex; flex-direction: column; align-items: center; padding: 4rpx 24rpx 38rpx; }
.rw-order-state-icon { display: flex; align-items: center; justify-content: center; width: 114rpx; height: 114rpx; border-radius: 36rpx; margin-bottom: 26rpx; }
.rw-order-heading { font-size: 39rpx; font-weight: 650; color: #1c1c1e; line-height: 1.4; text-align: center; letter-spacing: -.8rpx; }
.rw-order-message { color: #959ba6; font-size: 25rpx; line-height: 1.75; text-align: center; padding: 15rpx 8rpx 24rpx; }
.rw-order-snapshot-price { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; padding-top: 25rpx; margin-top: 25rpx; border-top: 1rpx solid #f0f2f6; }
.rw-timeline { padding-top: 16rpx; }
.rw-timeline-item { display: flex; align-items: flex-start; gap: 20rpx; padding: 20rpx 0; }
.rw-timeline-icon { width: 42rpx; height: 42rpx; background: #edf4ff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 50%; }
.rw-timeline-title { display: block; color: #4c5360; font-size: 27rpx; font-weight: 550; margin-bottom: 7rpx; line-height: 1.5; }
.rw-timeline-note { display: block; font-size: 24rpx; line-height: 1.75; color: #8e95a2; margin-top: 10rpx; white-space: pre-wrap; }
.rw-week-note { display: block; border-top: 1rpx solid #f0f2f6; padding-top: 22rpx; margin-top: 8rpx; color: #a0a5af; font-size: 22rpx; line-height: 1.6; }
.rw-sheet-shade { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000; display: flex; align-items: flex-end; background: rgba(20, 30, 49, .26); }
.rw-sheet { width: 100%; box-sizing: border-box; border-radius: 44rpx 44rpx 0 0; background: rgba(255, 255, 255, .96); backdrop-filter: blur(32rpx); padding: 20rpx 36rpx calc(26rpx + env(safe-area-inset-bottom)); box-shadow: 0 -12rpx 60rpx rgba(22, 38, 61, .1); }
.rw-sheet-handle { width: 68rpx; height: 8rpx; background: #d6dae1; border-radius: 10rpx; margin: 0 auto 32rpx; }
.rw-sheet-scroll { height: 52vh; max-height: 740rpx; }
.rw-sheet-heading { display: flex; align-items: center; gap: 20rpx; }
.rw-sheet-title { display: block; color: #1c1c1e; font-weight: 650; font-size: 36rpx; line-height: 1.4; letter-spacing: -.6rpx; }
.rw-sheet-description { display: block; color: #8b929f; font-size: 26rpx; line-height: 1.8; margin: 20rpx 0 26rpx; }
.rw-confirm-price { display: flex; align-items: baseline; justify-content: center; gap: 14rpx; padding: 38rpx 0 30rpx; }
.rw-confirm-number { font-size: 72rpx; font-weight: 650; color: #007aff; line-height: 1.1; letter-spacing: -2rpx; }
.rw-sheet-facts { background: #f4f6fa; border-radius: 28rpx; padding: 9rpx 26rpx; margin-bottom: 10rpx; }
.rw-sheet-actions { display: flex; flex-direction: column; gap: 6rpx; margin-top: 22rpx; }
.rw-sheet-cancel { background: transparent; color: #8d94a1; font-size: 27rpx; padding: 19rpx 0; line-height: 1.5; margin: 0; }
.rw-delivered-check { display: flex; align-items: center; gap: 14rpx; padding: 22rpx; background: #edf5ff; border-radius: 26rpx; margin: 24rpx 0; }
</style>
