<script setup lang="ts">
import {ref,computed,watch} from 'vue'
import AppShell from '../components/AppShell.vue'
import AppIcon from '../components/AppIcon.vue'
import PrivateImage from '../components/PrivateImage.vue'
import PointBalance from '../components/PointBalance.vue'
import MediaUploader from '../components/MediaUploader.vue'
import StatusPill from '../components/StatusPill.vue'
import EmptyState from '../components/EmptyState.vue'
import LoadMore from '../components/LoadMore.vue'
import {usePage} from '../composables/usePage'
import {get,getAll,mutate,familyPath,childPath} from '../services/api'
import {go} from '../services/navigation'
import {label,dateTime,businessDate,daysAgo,toUtc,now,unit,integer,displayOperator} from '../services/format'
import {previewMedia} from '../services/media'
import type {Dashboard,Today,Plan,PlanInput,PlanVersion,Occurrence,Child,Order,PageResult,UploadItem,Submission,Progress} from '../services/types'
const props=defineProps<{page:string;query:Record<string,string>}>();const childPage=['today','activity'].includes(props.page)
const dashboard=ref<Dashboard|null>(null),today=ref<Today|null>(null),plans=ref<Plan[]>([]),plan=ref<Plan|null>(null),occurrences=ref<Occurrence[]>([]),occurrence=ref<Occurrence|null>(null),versions=ref<PlanVersion[]>([]),children=ref<Child[]>([]),todos=ref<Array<Occurrence|Order>>([]),type=ref('ROUTINE'),todoType=ref(props.query.type||'REVIEW'),status=ref(''),childId=ref(props.query.childId||''),date=ref(props.query.date||businessDate()),cursor=ref<string|null>(null),hasMore=ref(false),note=ref(''),count=ref(''),checked=ref(false),photos=ref<UploadItem[]>([]),reason=ref(''),action=ref(''),saved=ref(false),completedDate=ref(businessDate()),completedTime=ref('18:00'),draftVersion=ref(0),startPolicy=ref('TOMORROW'),copyTitle=ref(''),displayDescription=ref('')
const form=ref({type:'ROUTINE' as 'ROUTINE'|'CHALLENGE',title:'',description:'',metric:'CHECK',targetValue:'',unit:'REP',awardPoints:'5',childIds:[] as string[],weekdays:[1,2,3,4,5,6,7],startDate:businessDate(),startTime:'08:00',endDate:daysAgo(-1),endTime:'20:00'})
const metrics=['CHECK','COUNT','DURATION','DISTANCE'];const weekdays=['周一','周二','周三','周四','周五','周六','周日'];const titles:Record<string,string>={home:'家庭概览',todos:'家庭待办',plans:'活动计划',planEdit:props.query.id?'编辑计划':'新建计划',plan:'计划详情',occurrence:'完成记录',today:'今天',activity:'记录我的完成'}
const {loading,error,busy,reload,act,session}=usePage(props.page,load,childPage?'child':'guardian')
let hydratingDraft=false
function localDraftKey(){return occurrence.value&&session.view?'pointjoy.completion-input.'+session.view.actorScopeKey+'.'+occurrence.value.id:''}
function persistLocalDraft(){const k=localDraftKey();if(!k||hydratingDraft||!['OPEN','NEEDS_CHANGES'].includes(occurrence.value!.status))return;uni.setStorageSync(k,{version:occurrence.value!.version,count:count.value,checked:checked.value,note:note.value,updatedAt:Date.now()});saved.value=false}
watch([count,checked,note],persistLocalDraft,{flush:'sync'})
function restoreLocalDraft(){const k=localDraftKey();if(!k)return;const input=uni.getStorageSync(k);if(input&&input.version===occurrence.value!.version&&Date.now()-input.updatedAt<86400000){count.value=input.count;checked.value=input.checked;note.value=input.note;saved.value=false}else if(input)uni.removeStorageSync(k)}
function clearLocalDraft(){const k=localDraftKey();if(k)uni.removeStorageSync(k)}
const snapshot=computed(()=>occurrence.value?.snapshot)
const editable=computed(()=>{const o=occurrence.value;if(!o)return false;if(o.status==='NEEDS_CHANGES')return now()<Date.parse(o.supplementUntil||o.endsAt);return o.status==='OPEN'&&now()>=Date.parse(o.startsAt)&&now()<Date.parse(o.endsAt)&&!['STOPPED','NOT_STARTED'].includes(o.displayState)})
const targetMax=computed(()=>snapshot.value?.metric==='DURATION'?1440:snapshot.value?.metric==='DISTANCE'?1000000:100000)
async function load(){
 if(['plans','planEdit','plan','home','todos'].includes(props.page)){children.value=await getAll<Child>(familyPath('/children'),{status:'ACTIVE'})}
 if(props.page==='home'){dashboard.value=await get<Dashboard>(familyPath('/dashboard'));return}
 if(props.page==='today'){today.value=await get<Today>(childPath(undefined,'/today'));return}
 if(props.page==='todos'){await loadTodos();return}
 if(props.page==='plans'){await loadPlans();return}
 if(props.page==='planEdit'&&props.query.id){plan.value=await get<Plan>(familyPath(`/plans/${props.query.id}`));const v=plan.value.scheduledVersion||plan.value.currentVersion||plan.value.draftVersion;if(v){form.value={type:plan.value.type,title:v.title,description:v.description||'',metric:v.metric,targetValue:v.targetValue===undefined?'':String(v.targetValue),unit:v.unit||'REP',awardPoints:String(v.awardPoints),childIds:v.childIds||plan.value.applicableChildIds,weekdays:v.weekdays||[1,2,3,4,5,6,7],startDate:v.startsAt?businessDate(v.startsAt):businessDate(),startTime:v.startsAt?dateTime(v.startsAt).slice(-5):'08:00',endDate:v.endsAt?businessDate(v.endsAt):daysAgo(-1),endTime:v.endsAt?dateTime(v.endsAt).slice(-5):'20:00'}}return}
 if(props.page==='plan'){plan.value=await get<Plan>(familyPath(`/plans/${props.query.id}`));displayDescription.value=plan.value.displayDescription||'';copyTitle.value=((plan.value.currentVersion||plan.value.draftVersion)?.title||'计划')+'（新约定）';await loadOccurrences();const v=await get<PageResult<PlanVersion>>(familyPath(`/plans/${props.query.id}/versions`));versions.value=v.items;return}
 if(['occurrence','activity'].includes(props.page)){hydratingDraft=true;occurrence.value=await get<Occurrence>(familyPath(`/occurrences/${props.query.id}`));const o=occurrence.value;const draft=o.draft;count.value=String(draft?.actualValue??o.latestSubmission?.actualValue??'');checked.value=draft?.checked??o.latestSubmission?.checked??false;note.value=draft?.note??o.latestSubmission?.note??'';draftVersion.value=draft?.version||0;const media=draft?.media||o.latestSubmission?.media||[];photos.value=media.map(m=>({localId:m.id,mediaId:m.id,status:m.status,progress:100,asset:m}));if(draft?.mediaIds&&!media.length)photos.value=await Promise.all(draft.mediaIds.map(async id=>{try{const asset=await get<import('../services/types').MediaAsset>(`/media/${id}`);return{localId:id,mediaId:id,status:asset.status,progress:100,asset}}catch{return{localId:id,mediaId:id,status:'DELETED' as const,progress:0,error:'草稿图片已过期，请重新选择'}}}));completedDate.value=o.businessDate||businessDate(o.startsAt);completedTime.value=businessDate()===completedDate.value?dateTime(new Date(now()).toISOString()).slice(-5):'18:00';restoreLocalDraft();hydratingDraft=false}
}
async function loadPlans(more=false){const result=await get<PageResult<Plan>>(familyPath('/plans'),{type:type.value,lifecycle:status.value||undefined,childId:childId.value||undefined,cursor:more?cursor.value:undefined});plans.value=more?[...plans.value,...result.items]:result.items;cursor.value=result.nextCursor||null;hasMore.value=result.hasMore}
async function loadTodos(more=false){const result=await get<PageResult<Occurrence|Order>>(familyPath('/todos'),{type:todoType.value,childId:childId.value||undefined,cursor:more?cursor.value:undefined});todos.value=more?[...todos.value,...result.items]:result.items;cursor.value=result.nextCursor||null;hasMore.value=result.hasMore}
async function loadOccurrences(more=false){if(date.value>businessDate()){const result=await get<{items?:Occurrence[]}>(familyPath(`/plans/${props.query.id}/schedule-preview`),{dateFrom:date.value,dateTo:date.value,childId:childId.value||undefined});occurrences.value=result.items||[];hasMore.value=false;return}const result=await get<PageResult<Occurrence>>(familyPath(`/plans/${props.query.id}/occurrences`),{dateFrom:plan.value?.type==='ROUTINE'?date.value:undefined,dateTo:plan.value?.type==='ROUTINE'?date.value:undefined,childId:childId.value||undefined,cursor:more?cursor.value:undefined});occurrences.value=more?[...occurrences.value,...result.items]:result.items;cursor.value=result.nextCursor||null;hasMore.value=result.hasMore}
function toggleChild(id:string){const ids=form.value.childIds;form.value.childIds=ids.includes(id)?ids.filter(x=>x!==id):[...ids,id]}
function toggleDay(day:number){form.value.weekdays=form.value.weekdays.includes(day)?form.value.weekdays.filter(x=>x!==day):[...form.value.weekdays,day].sort()}
function planInput():PlanInput{const f=form.value;if([...f.title.trim()].length<2||[...f.title.trim()].length>40)throw new Error('计划名称需2—40字');if(!integer(f.awardPoints,1,1000))throw new Error('奖励积分需为1—1,000整数');if(!f.childIds.length)throw new Error('请选择至少一位适用孩子');const max=f.metric==='DURATION'?1440:f.metric==='DISTANCE'?1000000:100000;if(f.metric!=='CHECK'&&!integer(f.targetValue,1,max))throw new Error(`目标需为1—${max}的整数`);if(f.type==='ROUTINE'&&!f.weekdays.length)throw new Error('请至少选择一个星期中的日期');const body:PlanInput={type:f.type,title:f.title.trim(),description:f.description.trim(),metric:f.metric as PlanInput['metric'],awardPoints:Number(f.awardPoints),childIds:f.childIds,...(f.metric!=='CHECK'?{targetValue:Number(f.targetValue),unit:f.metric==='COUNT'?f.unit:f.metric==='DURATION'?'MINUTE':'METER'}:{}),...(f.type==='ROUTINE'?{weekdays:f.weekdays}:{startsAt:toUtc(f.startDate,f.startTime),endsAt:toUtc(f.endDate,f.endTime)})};if(body.endsAt&&body.startsAt&&Date.parse(body.endsAt)<=Math.max(Date.parse(body.startsAt),now()))throw new Error('挑战结束时间必须晚于开始和当前时间');return body}
async function savePlan(publish=false){await act(async()=>{const input=planInput();let savedPlan:Plan;if(plan.value&&plan.value.lifecycle!=='DRAFT'){if(plan.value.type==='CHALLENGE')throw new Error('已发布挑战的要求冻结，只能修改展示说明或复制新挑战');savedPlan=await mutate<Plan>('POST',familyPath(`/plans/${plan.value.id}/revisions`),{...input,expectedVersion:plan.value.version},'修改明日起的日常')}else{savedPlan=await mutate<Plan>(plan.value?'PATCH':'POST',plan.value?familyPath(`/plans/${plan.value.id}`):familyPath('/plans'),{...input,...(plan.value?{expectedVersion:plan.value.version}:{})},'保存计划草稿');if(publish)savedPlan=await mutate<Plan>('POST',familyPath(`/plans/${savedPlan.id}/publish`),{expectedVersion:savedPlan.version,...(input.type==='ROUTINE'?{startPolicy:startPolicy.value}:{})},'发布家庭计划')}go('plan',{id:savedPlan.id},true)},'计划已保存')}
async function planAction(next:string){await act(async()=>{const p=plan.value!;if(next==='stop'&&!reason.value.trim())throw new Error('请填写停止原因');const accepted=await new Promise<boolean>(resolve=>uni.showModal({title:next==='stop'?'停止这次挑战':'确认计划变更',content:next==='stop'?'立即阻止尚未提交的新提交；已提交仍可审核，已获补充期限保留，已得积分不撤销。':next==='copy'?'会创建一份新草稿，发布后是新的可获奖机会。':'日常变更明天起生效，今天仍按原约定。',success:r=>resolve(r.confirm)}));if(!accepted)return;const result=await mutate<Plan>('POST',familyPath(`/plans/${p.id}/${next}`),{expectedVersion:p.version,...(next==='stop'?{reason:reason.value.trim()}:{}),...(next==='copy'?{newTitle:copyTitle.value.trim()||'新的家庭约定'}:{}),...(next==='publish'&&p.type==='ROUTINE'?{startPolicy:startPolicy.value}:{})},'修改计划状态');if(next==='copy')go('planEdit',{id:result.id});else await load()})}
async function saveDescription(){await act(async()=>{await mutate('PATCH',familyPath(`/plans/${plan.value!.id}/display-description`),{description:displayDescription.value,expectedVersion:plan.value!.version},'修改挑战展示说明');await load()},'展示说明已更新')}
function completionInput(goal:boolean){const s=snapshot.value!;if(s.metric==='CHECK'){if(goal&&!checked.value)throw new Error('请确认已经实际完成');return{checked:checked.value,note:note.value.trim(),mediaIds:photos.value.filter(p=>p.status==='READY'&&p.mediaId).map(p=>p.mediaId!)}}if(!integer(count.value,0,targetMax.value))throw new Error(`请填写0—${targetMax.value}之间的整数`);if(goal&&Number(count.value)<(s.targetValue||1))throw new Error('还没有达到约定目标，可以先保存草稿');return{actualValue:Number(count.value),note:note.value.trim(),mediaIds:photos.value.filter(p=>p.status==='READY'&&p.mediaId).map(p=>p.mediaId!)}}
async function submit(direct=false){await act(async()=>{if(photos.value.some(p=>p.status!=='READY'))throw new Error('请等待照片处理完成，失败照片可重试或移除');const body=completionInput(true);await mutate('POST',familyPath(`/occurrences/${occurrence.value!.id}/${direct?'direct-completion':'submissions'}`),{...body,expectedVersion:occurrence.value!.version,...(direct?{completedAt:toUtc(completedDate.value,completedTime.value)}:{})},direct?'直接记录真实完成':'提交给家长确认');clearLocalDraft();await load();saved.value=false},direct?'真实完成已记录并加分':'已经告诉家长，确认后积分会到账')}
async function saveDraft(){await act(async()=>{const body=completionInput(false);const result=await mutate<{draft:{version:number};occurrenceVersion:number}>('PUT',familyPath(`/occurrences/${occurrence.value!.id}/draft`),{...body,expectedOccurrenceVersion:occurrence.value!.version,expectedDraftVersion:draftVersion.value},'保存完成草稿');draftVersion.value=result.draft.version;occurrence.value!.version=result.occurrenceVersion;clearLocalDraft();saved.value=true},'草稿已保存，没有提交或加分')}
async function review(decision:'APPROVE'|'RETURN'|'EXEMPT'){await act(async()=>{if(decision!=='APPROVE'&&!reason.value.trim())throw new Error('请填写原因');const o=occurrence.value!;await mutate('POST',familyPath(`/occurrences/${o.id}/${decision==='EXEMPT'?'exemption':'review'}`),{expectedVersion:o.version,...(decision==='EXEMPT'?{reason:reason.value.trim()}:{decision,...(reason.value.trim()?{reason:reason.value.trim()}:{})})},decision==='APPROVE'?'通过并发放积分':decision==='RETURN'?'请孩子补充':'本次免做');action.value='';await load()},'记录已更新')}
function openTodo(item:Occurrence|Order){'snapshot'in item?go('occurrence',{id:item.id}):go('order',{id:item.id})}
function todoTitle(item:Occurrence|Order){return 'snapshot'in item?item.snapshot.title:item.rewardSnapshot.name||'兑换奖励'}
function todayRows(){return [...(today.value?.routines||[]),...(today.value?.challenges||[])]}
function completedFraction(progress?:{approvedCount?:number;expectedCount?:number;approved?:number;required?:number;numerator?:number;denominator?:number}){return`${progress?.approvedCount??progress?.approved??progress?.numerator??0} / ${progress?.expectedCount??progress?.required??progress?.denominator??0}`}
function progressTotal(progress?:Progress){return progress?.expectedCount??progress?.required??progress?.denominator??0}
function progressDone(progress?:Progress){return progress?.approvedCount??progress?.approved??progress?.numerator??0}
function progressWidth(progress?:Progress){const total=progressTotal(progress);return`${total?Math.min(100,Math.max(0,progressDone(progress)/total*100)):0}%`}
function metricIcon(metric?:string){return metric==='DURATION'?'clock':metric==='CHECK'?'check':'activity'}
function planView(p:Plan){return p.currentVersion||p.scheduledVersion||p.draftVersion}
function planTarget(p:Plan){const v=planView(p);return !v||v.metric==='CHECK'?'按约定完成':`${v.targetValue}${unit(v.metric,v.unit)}`}
const homePending=computed(()=>dashboard.value?(dashboard.value.pendingReviewCount+dashboard.value.pendingApprovalCount+dashboard.value.readyCount):0)
const todayGroups=computed(()=>[{key:'routines',title:'日常小事',copy:'把每一天，过成自己的节奏',icon:'sun',items:today.value?.routines||[]},{key:'challenges',title:'这次挑战',copy:'给想尝试的事情，留一点空间',icon:'sparkle',items:today.value?.challenges||[]}])
async function showPhotos(sub:Submission){await act(()=>previewMedia(sub.media.filter(m=>m.status!=='DELETED').map(m=>m.id)))}
</script>
<template>
  <AppShell :title="titles[page]" :tab="page==='home'?'home':page==='plans'?'plans':page==='today'?'today':''" :back="!['home','plans','today'].includes(page)" :loading="loading" :error="error" @retry="reload">
    <view class="activity-page">
      <template v-if="page==='home'&&dashboard">
        <view class="activity-date"><AppIcon name="calendar" size="28rpx" tone="muted"/><text>{{businessDate()}} · 北京时间</text></view>
        <view class="activity-overview">
          <view class="activity-overview-top">
            <view class="activity-flex"><text class="activity-overline">一起长大的每一天</text><text class="activity-feature-title">小小努力，都有回应。</text></view>
            <view class="activity-feature-icon"><AppIcon name="sun" size="62rpx" tone="blue"/></view>
          </view>
          <view class="activity-progress-heading"><text class="activity-support">今天的日常</text><text class="activity-progress-number">{{completedFraction(dashboard.routineProgress)}} <text class="activity-small">已通过</text></text></view>
          <view class="activity-progress-track"><view class="activity-progress-fill" :style="{width:progressWidth(dashboard.routineProgress)}"/></view>
          <text class="activity-helper">{{progressTotal(dashboard.routineProgress)?'按自己的节奏完成，休息也不会扣分。':'今天还没有日常安排，可以一起约定一件小事。'}}</text>
        </view>

        <view class="activity-section-heading"><text class="activity-section-title">需要你回应</text><text class="activity-count-label">{{homePending?`${homePending} 件待办`:'都已处理'}}</text></view>
        <view class="activity-inbox-grid">
          <button class="activity-inbox-item" @tap="go('todos',{type:'REVIEW'})"><view class="activity-icon-tile activity-tile-blue"><AppIcon name="check" size="36rpx" tone="blue"/></view><text class="activity-inbox-count">{{dashboard.pendingReviewCount}}</text><text class="activity-inbox-label">完成审核</text><text class="activity-inbox-hint">接住每份努力</text></button>
          <button class="activity-inbox-item" @tap="go('todos',{type:'APPROVAL'})"><view class="activity-icon-tile activity-tile-lilac"><AppIcon name="star" size="36rpx" tone="blue"/></view><text class="activity-inbox-count">{{dashboard.pendingApprovalCount}}</text><text class="activity-inbox-label">兑换批准</text><text class="activity-inbox-hint">一起商量奖励</text></button>
          <button class="activity-inbox-item" @tap="go('todos',{type:'FULFILLMENT'})"><view class="activity-icon-tile activity-tile-mint"><AppIcon name="gift" size="36rpx" tone="green"/></view><text class="activity-inbox-count">{{dashboard.readyCount}}</text><text class="activity-inbox-label">奖励兑现</text><text class="activity-inbox-hint">让承诺发生</text></button>
        </view>

        <view class="activity-section-heading"><text class="activity-section-title">孩子的今天</text><button class="activity-inline-button" @tap="go('family')"><text>管理</text><AppIcon name="chevron" size="24rpx" tone="blue"/></button></view>
        <view v-for="c in dashboard.childrenSummary" :key="c.id" class="activity-child-card">
          <view class="activity-child-profile" @tap="go('child',{id:c.id})">
            <PrivateImage :media-id="c.avatarMediaId" :alt="c.nickname+'的头像'" avatar size="104rpx"/>
            <view class="activity-flex"><text class="activity-child-name">{{c.nickname}}</text><text class="activity-support">{{c.pendingReviewCount?`${c.pendingReviewCount} 份完成等你确认`:'每一点努力，都值得被看见'}}</text></view>
            <AppIcon name="chevron" size="30rpx" tone="muted"/>
          </view>
          <view class="activity-child-metrics">
            <view class="activity-child-points"><text class="activity-metric-label">可用积分</text><text class="activity-child-value">{{c.account?.availablePoints??c.availablePoints??'—'}}<text class="activity-value-unit">分</text></text></view>
            <view class="activity-child-progress"><view class="activity-progress-heading"><text class="activity-metric-label">日常已通过</text><text class="activity-progress-text">{{completedFraction(c.routineProgress)}}</text></view><view class="activity-progress-track activity-track-small"><view class="activity-progress-fill" :style="{width:progressWidth(c.routineProgress)}"/></view></view>
          </view>
          <view v-if="!session.isFamilyReadOnly" class="activity-child-actions"><button class="activity-child-action" @tap="go('history',{childId:c.id,record:'true'})"><AppIcon name="plus" size="30rpx" tone="blue"/><text>记录完成</text></button><button class="activity-child-action activity-child-action-muted" @tap="act(()=>session.enterChild(c.id))"><AppIcon name="sun" size="30rpx" tone="ink"/><text>进入孩子模式</text></button></view>
        </view>
        <EmptyState v-if="!dashboard.childrenSummary.length" title="欢迎第一位小朋友" description="上传头像建立档案，再一起约定喜欢的日常活动。"><button v-if="!session.isFamilyReadOnly" class="primary section" @tap="go('childEdit')">添加孩子</button></EmptyState>
        <view class="activity-gentle-note"><AppIcon name="heart" size="34rpx" tone="blue"/><text>把小事说清楚，把承诺记住。家长可以代录、审核并兑现。</text></view>
      </template>

      <template v-else-if="page==='today'&&today">
        <view class="activity-date"><AppIcon name="sun" size="28rpx" tone="blue"/><text>{{today.businessDate}} · 新的一天，慢慢来</text></view>
        <PointBalance :account="today.account"/>
        <view class="activity-today-progress"><view class="activity-progress-heading"><text class="activity-section-label">今天的日常</text><text class="activity-progress-text">{{completedFraction(today.routineProgress)}} 已通过</text></view><view class="activity-progress-track"><view class="activity-progress-fill" :style="{width:progressWidth(today.routineProgress)}"/></view></view>
        <template v-for="group in todayGroups" :key="group.key">
          <template v-if="group.items.length">
            <view class="activity-section-heading"><view><text class="activity-section-title">{{group.title}}</text><text class="activity-section-caption">{{group.copy}}</text></view><view class="activity-soft-icon"><AppIcon :name="group.icon" size="34rpx" tone="blue"/></view></view>
            <view class="activity-task-group">
              <view v-for="o in group.items" :key="o.id" class="activity-task-card">
                <view class="activity-task-main" @tap="go('activity',{id:o.id})"><view class="activity-task-icon" :class="{'activity-tile-mint':o.status==='APPROVED'}"><AppIcon :name="o.status==='APPROVED'?'check':metricIcon(o.snapshot.metric)" size="40rpx" :tone="o.status==='APPROVED'?'green':'blue'"/></view><view class="activity-flex"><text class="activity-row-title">{{o.snapshot.title}}</text><text class="activity-support">{{o.snapshot.metric==='CHECK'?'按约定完成':`${o.snapshot.targetValue} ${unit(o.snapshot.metric,o.snapshot.unit)}`}}</text></view><view class="activity-point-chip"><AppIcon name="sparkle" size="24rpx" tone="blue"/><text>+{{o.snapshot.awardPoints}}</text></view></view>
                <text v-if="o.type==='CHALLENGE'" class="activity-task-deadline">{{dateTime(o.endsAt)}} 前完成</text>
                <view class="activity-task-footer"><StatusPill :status="o.displayState||o.status"/><button class="activity-inline-button" @tap="go('activity',{id:o.id})"><text>{{o.status==='OPEN'?'记录完成':o.status==='NEEDS_CHANGES'?'去补充':'查看记录'}}</text><AppIcon name="chevron" size="24rpx" tone="blue"/></button></view>
              </view>
            </view>
          </template>
        </template>
        <EmptyState v-if="!todayRows().length" title="今天还没有安排" description="和家长一起商量一件想做的小事，也可以好好休息。"/>
        <button class="activity-wish-link" @tap="go('wishes',{},true)"><view class="activity-icon-tile activity-tile-lilac"><AppIcon name="gift" size="36rpx" tone="blue"/></view><view class="activity-flex"><text class="activity-row-title">我的小心愿</text><text class="activity-support">看看努力离心愿又近了多少</text></view><AppIcon name="chevron" size="30rpx" tone="blue"/></button>
      </template>

      <template v-else-if="page==='todos'">
        <view class="tabs"><button v-for="t in ['REVIEW','APPROVAL','FULFILLMENT']" :key="t" :class="{active:todoType===t}" @tap="todoType=t;act(()=>loadTodos())">{{t==='REVIEW'?'完成审核':t==='APPROVAL'?'兑换批准':'奖励兑现'}}</button></view>
        <view class="activity-filter-heading"><text class="activity-support">{{todoType==='REVIEW'?'看见努力，再把积分交给孩子':todoType==='APPROVAL'?'一起确认这次想要的奖励':'把说好的奖励，认真兑现'}}</text></view>
        <view v-if="children.length" class="activity-filter"><picker :range="['全部孩子',...children.map(c=>c.nickname)]" @change="childId=children[Number($event.detail.value)-1]?.id||'';act(()=>loadTodos())"><view class="activity-filter-control"><AppIcon name="family" size="30rpx" tone="blue"/><text>{{children.find(c=>c.id===childId)?.nickname||'全部孩子'}}</text><AppIcon name="chevron" size="24rpx" tone="muted"/></view></picker></view>
        <view v-for="item in todos" :key="item.id" class="activity-task-card" @tap="openTodo(item)"><view class="activity-task-main"><view class="activity-task-icon"><AppIcon :name="'snapshot'in item?metricIcon(item.snapshot.metric):'gift'" size="40rpx" tone="blue"/></view><view class="activity-flex"><text class="activity-row-title">{{todoTitle(item)}}</text><text class="activity-support">{{item.child?.nickname||item.childNickname||'孩子记录'}}</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></view><view class="activity-task-footer"><StatusPill :status="item.status"/><text class="activity-small">{{'snapshot'in item?item.businessDate:item.status==='PENDING_APPROVAL'?'批准截止 '+dateTime(item.approvalExpiresAt):'等待兑现'}}</text></view></view>
        <EmptyState v-if="!todos.length&&!loading" title="这一类待办都处理好了" description="也可以切换查看另外两类待办。"/><LoadMore :has-more="hasMore" :loading="busy" @more="act(()=>loadTodos(true))"/>
      </template>

      <template v-else-if="page==='plans'">
        <view class="activity-plan-toolbar"><view class="tabs activity-flex"><button :class="{active:type==='ROUTINE'}" @tap="type='ROUTINE';act(()=>loadPlans())">日常</button><button :class="{active:type==='CHALLENGE'}" @tap="type='CHALLENGE';act(()=>loadPlans())">一次挑战</button></view><button v-if="!session.isFamilyReadOnly" class="activity-add-button" aria-label="新建计划" @tap="go('planEdit')"><AppIcon name="plus" size="36rpx" tone="white"/></button></view>
        <text class="activity-page-description">{{type==='ROUTINE'?'让值得坚持的小事，成为每一天的习惯。':'为一次尝试，一起约定清晰的目标。'}}</text>
        <view class="chip-row activity-filter-chips"><button v-for="s in (type==='ROUTINE'?['','DRAFT','PUBLISHED']:['','DRAFT','PUBLISHED','STOPPED'])" :key="s||'all'" class="chip" :class="{active:status===s}" @tap="status=s;act(()=>loadPlans())">{{s?label(s):'全部'}}</button></view>
        <view v-for="p in plans" :key="p.id" class="activity-plan-card" @tap="go('plan',{id:p.id})">
          <view class="activity-task-main"><view class="activity-task-icon" :class="{'activity-tile-lilac':p.type==='CHALLENGE'}"><AppIcon :name="p.type==='CHALLENGE'?'sparkle':metricIcon(planView(p)?.metric)" size="42rpx" tone="blue"/></view><view class="activity-flex"><text class="activity-row-title">{{planView(p)?.title||p.title||'计划草稿'}}</text><text class="activity-support">{{planTarget(p)}}</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></view>
          <view class="activity-plan-schedule"><AppIcon :name="p.type==='ROUTINE'?'calendar':'clock'" size="26rpx" tone="muted"/><text>{{p.type==='ROUTINE'?(planView(p)?.weekdays?.map(d=>weekdays[d-1]).join('、')||'日期尚未设置'):`${dateTime(planView(p)?.startsAt)} 至 ${dateTime(planView(p)?.endsAt)}`}}</text></view>
          <view class="activity-task-footer"><StatusPill :status="p.currentVersion?.active===false?'PAUSED':p.lifecycle"/><text class="activity-plan-points">通过得 {{planView(p)?.awardPoints??'—'}} 积分</text></view>
          <view v-if="p.scheduledVersion" class="activity-scheduled-note"><AppIcon name="clock" size="24rpx" tone="blue"/><text>新约定明天起生效</text></view>
        </view>
        <EmptyState v-if="!plans.length&&!loading" title="一起约定第一件小事" description="明确要做什么、完成标准和通过后的积分。"><button v-if="!session.isFamilyReadOnly" class="primary section" @tap="go('planEdit')">新建计划</button></EmptyState><LoadMore :has-more="hasMore" :loading="busy" @more="act(()=>loadPlans(true))"/>
      </template>

      <template v-else-if="page==='planEdit'&&!session.isFamilyReadOnly">
        <view class="activity-form-intro"><view class="activity-icon-tile activity-tile-blue"><AppIcon name="edit" size="36rpx" tone="blue"/></view><view class="activity-flex"><text class="activity-row-title">把约定，说得清楚一点</text><text class="activity-support">让孩子知道做什么，也知道能得到什么。</text></view></view>
        <view class="tabs"><button :disabled="!!plan" :class="[{active:form.type==='ROUTINE'}, {'is-disabled':!!plan}]" @tap="form.type='ROUTINE'">重复的日常</button><button :disabled="!!plan" :class="[{active:form.type==='CHALLENGE'}, {'is-disabled':!!plan}]" @tap="form.type='CHALLENGE'">一次挑战</button></view>
        <view class="activity-form-group"><text class="activity-form-heading">活动内容</text><view class="field"><text class="field-label">计划名称</text><input class="input" v-model="form.title" maxlength="40" placeholder="例如：整理书包、跳绳"/></view><view class="field"><text class="field-label">完成说明 <text class="activity-optional">选填</text></text><textarea class="textarea" v-model="form.description" maxlength="500" placeholder="一起说清楚怎么确认完成"/></view></view>
        <view class="activity-form-group"><text class="activity-form-heading">完成标准与积分</text><view class="field"><text class="field-label">怎样算达标</text><picker :range="metrics.map(label)" :value="metrics.indexOf(form.metric)" @change="form.metric=metrics[Number($event.detail.value)]"><view class="select-control activity-picker-content"><text>{{label(form.metric)}}</text><AppIcon name="chevron" size="26rpx" tone="muted"/></view></picker></view><view v-if="form.metric!=='CHECK'" class="field"><text class="field-label">目标总量（{{unit(form.metric,form.unit)}}）</text><input class="input" v-model="form.targetValue" type="number" placeholder="填写约定目标"/><view v-if="form.metric==='COUNT'" class="tabs section"><button :class="{active:form.unit==='REP'}" @tap="form.unit='REP'">次</button><button :class="{active:form.unit==='ITEM'}" @tap="form.unit='ITEM'">个</button></view></view><view class="field"><text class="field-label">通过后获得积分</text><input class="input" v-model="form.awardPoints" type="number" placeholder="1—1,000"/><text class="activity-field-note">一次达标固定加分，超过目标也不会额外加分。目标是家庭约定，不是运动建议。</text></view></view>
        <view class="activity-form-group"><text class="activity-form-heading">一起参与的孩子</text><text class="activity-field-note">至少选择一位孩子，每个人独立完成、独立计分。</text><view class="activity-child-choices"><button v-for="c in children" :key="c.id" class="activity-child-choice" :class="{'activity-child-choice-selected':form.childIds.includes(c.id)}" @tap="toggleChild(c.id)"><PrivateImage :media-id="c.avatarMediaId" avatar size="68rpx"/><text class="activity-choice-name">{{c.nickname}}</text><view class="activity-choice-check" :class="{'activity-choice-check-selected':form.childIds.includes(c.id)}"><AppIcon v-if="form.childIds.includes(c.id)" name="check" size="24rpx" tone="white"/></view></button></view><button v-if="!children.length" class="secondary full" @tap="go('childEdit')">先添加孩子</button></view>
        <view class="activity-form-group">
          <text class="activity-form-heading">安排时间</text>
          <template v-if="form.type==='ROUTINE'"><text class="field-label section">每周安排</text><view class="chip-row"><button v-for="(d,i) in weekdays" :key="d" class="chip" :class="{active:form.weekdays.includes(i+1)}" @tap="toggleDay(i+1)">{{d}}</button></view><view v-if="!plan||plan.lifecycle==='DRAFT'" class="field"><text class="field-label">开始时间</text><view class="tabs"><button :class="{active:startPolicy==='TOMORROW'}" @tap="startPolicy='TOMORROW'">明天开始</button><button :class="{active:startPolicy==='TODAY'}" @tap="startPolicy='TODAY'">今天发布后开始</button></view></view><view v-else class="notice">修改从明天 00:00 生效，今天仍按原约定。</view></template>
          <template v-else><view class="field"><text class="field-label">开始时间（北京时间）</text><view class="button-row"><picker mode="date" :value="form.startDate" @change="form.startDate=$event.detail.value"><view class="select-control">{{form.startDate}}</view></picker><picker mode="time" :value="form.startTime" @change="form.startTime=$event.detail.value"><view class="select-control">{{form.startTime}}</view></picker></view></view><view class="field"><text class="field-label">结束时间（北京时间）</text><view class="button-row"><picker mode="date" :value="form.endDate" @change="form.endDate=$event.detail.value"><view class="select-control">{{form.endDate}}</view></picker><picker mode="time" :value="form.endTime" @change="form.endTime=$event.detail.value"><view class="select-control">{{form.endTime}}</view></picker></view></view><view class="notice">发布后目标、积分、孩子和窗口冻结。修改要求需复制成新挑战。</view></template>
        </view>
        <view class="activity-plan-preview"><view class="activity-preview-label"><AppIcon name="shield" size="30rpx" tone="blue"/><text>发布前，再看一眼</text></view><text class="activity-preview-title">{{form.title||'这份家庭约定'}}</text><text class="activity-support">{{form.childIds.length}} 位孩子 · {{form.metric==='CHECK'?'完成即可':`${form.targetValue||'—'} ${unit(form.metric,form.unit)}`}}</text><view class="activity-preview-award"><text>通过后获得</text><text class="activity-preview-points">{{form.awardPoints||'—'}} <text class="activity-small">积分</text></text></view></view>
        <view class="button-stack"><button :class="{'is-disabled':busy}" class="primary" :loading="busy" :disabled="busy" @tap="savePlan(true)">{{plan&&plan.lifecycle!=='DRAFT'?'保存明日起的新约定':'保存并发布'}}</button><button v-if="!plan||plan.lifecycle==='DRAFT'" :class="{'is-disabled':busy}" class="secondary" :disabled="busy" @tap="savePlan(false)">保存草稿</button></view>
      </template>

      <template v-else-if="page==='plan'&&plan">
        <view class="activity-detail-hero"><view class="activity-detail-hero-top"><view class="activity-detail-icon"><AppIcon :name="plan.type==='CHALLENGE'?'sparkle':metricIcon(planView(plan)?.metric)" size="54rpx" tone="blue"/></view><StatusPill :status="plan.currentVersion?.active===false?'PAUSED':plan.lifecycle"/></view><text class="activity-detail-title">{{planView(plan)?.title||plan.title}}</text><text v-if="planView(plan)?.description" class="activity-detail-copy">{{planView(plan)?.description}}</text><view class="activity-detail-metrics"><view class="activity-flex"><text class="activity-metric-label">完成目标</text><text class="activity-goal-value">{{planTarget(plan)}}</text></view><view class="activity-award-block"><text class="activity-metric-label">通过后获得</text><text class="activity-award-value">+{{planView(plan)?.awardPoints}}<text class="activity-value-unit">积分</text></text></view></view><view v-if="plan.type==='CHALLENGE'" class="activity-detail-window"><AppIcon name="clock" size="28rpx" tone="muted"/><text>{{dateTime(planView(plan)?.startsAt)}} 至 {{dateTime(planView(plan)?.endsAt)}}</text></view></view>
        <view v-if="plan.scheduledVersion" class="notice section"><text>明天起{{plan.scheduledVersion.active?'生效':'暂停'}}：{{plan.scheduledVersion.title}} · {{plan.scheduledVersion.targetValue||'完成即可'}} · {{plan.scheduledVersion.awardPoints}} 积分。今天实例不改变。</text></view>
        <view class="activity-section-heading"><text class="activity-section-title">完成情况</text><picker v-if="plan.type==='ROUTINE'" mode="date" :value="date" @change="date=$event.detail.value;act(()=>loadOccurrences())"><view class="activity-date-picker"><AppIcon name="calendar" size="26rpx" tone="blue"/><text>{{date}}</text></view></picker></view>
        <view v-if="date>businessDate()" class="notice">未来日期是安排预览，不能审核或提前记录完成。</view>
        <view v-if="occurrences.length" class="activity-grouped-list"><view v-for="o in occurrences" :key="o.id" class="activity-record-row" @tap="date<=businessDate()&&go('occurrence',{id:o.id})"><view class="activity-record-icon"><AppIcon :name="o.status==='APPROVED'?'check':'activity'" size="32rpx" :tone="o.status==='APPROVED'?'green':'blue'"/></view><view class="activity-flex"><text class="activity-row-title">{{o.child?.nickname||o.childNickname||children.find(c=>c.id===o.childId)?.nickname||'孩子'}}</text><text class="activity-support">{{o.businessDate||'完整挑战周期'}}</text></view><StatusPill :status="o.displayState||o.status"/><AppIcon v-if="date<=businessDate()" name="chevron" size="24rpx" tone="muted"/></view></view>
        <EmptyState v-if="!occurrences.length&&!loading" title="这一天没有适用记录" description="只为真实被安排的日期记录，不补孩子加入前的任务。"/><LoadMore :has-more="hasMore" :loading="busy" @more="act(()=>loadOccurrences(true))"/>
        <view v-if="!session.isFamilyReadOnly" class="button-stack"><button v-if="plan.lifecycle==='DRAFT'||plan.type==='ROUTINE'" class="secondary" @tap="go('planEdit',{id:plan.id})">{{plan.lifecycle==='DRAFT'?'编辑草稿':'编辑明日起的日常'}}</button><button v-if="plan.lifecycle==='DRAFT'" class="primary" @tap="planAction('publish')">发布这份约定</button><button v-if="plan.type==='ROUTINE'&&plan.lifecycle!=='DRAFT'" class="secondary" @tap="planAction((plan.scheduledVersion||plan.currentVersion)?.active===false?'resume':'pause')">{{(plan.scheduledVersion||plan.currentVersion)?.active===false?'明天恢复':'明天暂停'}}</button></view>
        <view v-if="!session.isFamilyReadOnly&&plan.type==='CHALLENGE'&&plan.lifecycle!=='DRAFT'" class="activity-form-group"><text class="activity-form-heading">展示说明</text><textarea class="textarea section" v-model="displayDescription" maxlength="500"/><text class="activity-field-note">不能借展示说明改变原完成标准。</text><button class="secondary full section" @tap="saveDescription">保存展示说明</button><view v-if="!plan.stoppedAt" class="field"><text class="field-label">停止原因</text><textarea class="textarea" v-model="reason" maxlength="200"/><button class="danger-button full section" @tap="planAction('stop')">停止这次挑战</button></view></view>
        <view v-if="!session.isFamilyReadOnly" class="activity-form-group"><view class="activity-form-heading-row"><AppIcon name="plus" size="32rpx" tone="blue"/><text class="activity-form-heading">复制为新约定</text></view><text class="activity-field-note">保留这份记录，为下一次尝试创建新草稿。</text><input class="input section" v-model="copyTitle" maxlength="40"/><button class="secondary full section" @tap="planAction('copy')">创建新草稿</button></view>
        <view class="activity-section-heading"><text class="activity-section-title">版本历史</text><AppIcon name="clock" size="30rpx" tone="muted"/></view><view class="activity-grouped-list"><view v-for="v in versions" :key="v.id||v.revision" class="activity-version-row"><view class="activity-version-index">{{v.revision}}</view><view class="activity-flex"><text class="activity-row-title">{{v.title}}</text><text class="activity-support">生效于 {{dateTime(v.effectiveFrom)}}</text></view><text class="activity-version-points">{{v.awardPoints}} 分</text></view></view>
      </template>

      <template v-else-if="['occurrence','activity'].includes(page)&&occurrence&&snapshot">
        <view class="activity-detail-hero"><view class="activity-detail-hero-top"><view class="activity-detail-icon"><AppIcon :name="metricIcon(snapshot.metric)" size="54rpx" tone="blue"/></view><StatusPill :status="occurrence.displayState||occurrence.status"/></view><text class="activity-detail-title">{{snapshot.title}}</text><text v-if="snapshot.description" class="activity-detail-copy">{{snapshot.description}}</text><view class="activity-detail-metrics"><view class="activity-flex"><text class="activity-metric-label">本次目标</text><text class="activity-goal-value">{{snapshot.metric==='CHECK'?'按约定完成':`${snapshot.targetValue} ${unit(snapshot.metric,snapshot.unit)}`}}</text></view><view class="activity-award-block"><text class="activity-metric-label">通过后获得</text><text class="activity-award-value">+{{snapshot.awardPoints}}<text class="activity-value-unit">积分</text></text></view></view><view class="activity-detail-window"><AppIcon name="calendar" size="28rpx" tone="muted"/><view><text>{{occurrence.businessDate||'一次挑战'}}</text><text class="activity-window-time">{{dateTime(occurrence.startsAt)}} 至 {{dateTime(occurrence.endsAt)}}</text></view></view></view>
        <text class="activity-under-card">一次达标固定加分，超额完成不会额外加分。</text>
        <view v-if="occurrence.status==='NEEDS_CHANGES'" class="notice warning section">请查看家长的补充原因，并在 {{dateTime(occurrence.supplementUntil)}} 前补充。</view>
        <view v-if="occurrence.latestSubmission" class="activity-submission-section"><view class="activity-section-heading"><text class="activity-section-title">提交与处理记录</text><AppIcon name="clock" size="30rpx" tone="muted"/></view><view v-for="s in occurrence.submissions||[occurrence.latestSubmission]" :key="s.id" class="activity-submission-card"><view class="activity-submission-heading"><view class="activity-soft-icon"><AppIcon name="check" size="30rpx" tone="blue"/></view><view class="activity-flex"><text class="activity-row-title">第 {{s.sequence}} 次提交</text><text class="activity-support">{{s.actorMode==='GUARDIAN'?'家长代录':'孩子提交'}} · {{dateTime(s.submittedAt)}}</text></view></view><view class="activity-submission-result"><text class="activity-metric-label">完成情况</text><text class="activity-submission-value">{{s.checked?'已按约定完成':`${s.actualValue??'—'} ${unit(snapshot.metric,snapshot.unit)}`}}</text></view><text class="activity-submission-note">{{s.note||'没有填写说明'}}</text><text v-if="s.completedAt" class="activity-field-note">实际完成 {{dateTime(s.completedAt)}} · 记录 {{dateTime(s.recordedAt)}}</text><view v-if="s.media.length" class="media-grid activity-submission-media"><view v-for="m in s.media" :key="m.id" @tap="m.status!=='DELETED'&&showPhotos(s)"><PrivateImage v-if="m.status!=='DELETED'" :media-id="m.id" size="180rpx"/><text v-else class="caption">照片已按保存期限清理</text></view></view><view v-for="(r,index) in occurrence.reviewHistory?.filter(r=>r.submissionId===s.id)||[]" :key="r.id||index" class="activity-review-item"><view class="activity-review-marker"><AppIcon :name="(r.action||r.decision)==='APPROVE'?'check':'clock'" size="24rpx" :tone="(r.action||r.decision)==='APPROVE'?'green':'orange'"/></view><view class="activity-flex"><text class="activity-row-title">{{(r.action||r.decision)==='APPROVE'?'已通过':(r.action||r.decision)==='RETURN'?'请补充':label(r.action||r.decision)}}</text><text v-if="r.reason" class="activity-review-reason">{{r.reason}}</text><text class="activity-support">{{displayOperator(r.operatorSummary||r.actor)}} · {{dateTime(r.reviewedAt||r.createdAt)}}</text></view></view></view></view>
        <template v-if="!session.isFamilyReadOnly&&(childPage?editable:['OPEN','NEEDS_CHANGES'].includes(occurrence.status))">
          <view class="activity-form-group"><text class="activity-form-heading">{{childPage?'我的完成情况':'记录真实完成'}}</text><view v-if="snapshot.metric==='CHECK'" class="activity-completion-check" :class="{'activity-completion-checked':checked}" @tap="checked=!checked;saved=false"><checkbox :checked="checked" color="#007AFF"/><view class="activity-flex"><text class="activity-row-title">我已经按约定完成</text><text class="activity-support">确认的是这一次的真实完成</text></view></view><view v-else class="field"><text class="field-label">这次总共完成多少</text><view class="activity-number-control"><input class="activity-number-input" v-model="count" type="number" placeholder="0" @input="saved=false"/><text class="activity-number-unit">{{unit(snapshot.metric,snapshot.unit)}}</text></view><text class="activity-field-note">填写本次实例的总完成量，不会把多次输入相加。</text></view>
            <view v-if="!childPage" class="field"><text class="field-label">实际完成时间（北京时间）</text><view class="button-row"><picker mode="date" :value="completedDate" :start="businessDate(occurrence.startsAt)" :end="businessDate(occurrence.endsAt)" @change="completedDate=$event.detail.value"><view class="select-control">{{completedDate}}</view></picker><picker mode="time" :value="completedTime" @change="completedTime=$event.detail.value"><view class="select-control">{{completedTime}}</view></picker></view><text class="activity-field-note">只记录真实发生且在原窗口内的完成；日常含今天可补记 8 个日期，挑战截止后 7×24 小时内可补记。</text></view>
            <view class="field"><text class="field-label">完成说明 <text class="activity-optional">选填</text></text><textarea class="textarea" v-model="note" maxlength="200" placeholder="想和家长分享些什么？" @input="saved=false"/></view>
            <MediaUploader v-model="photos" :scope="{purpose:'COMPLETION_EVIDENCE',familyId:session.view?.familyId,childId:occurrence.childId,occurrenceId:occurrence.id}"/>
          </view>
          <view class="button-stack"><button :class="{'is-disabled':busy||photos.some(p=>p.status!=='READY')}" class="primary" :loading="busy" :disabled="busy||photos.some(p=>p.status!=='READY')" @tap="submit(!childPage)">{{childPage?'提交给家长':`记录完成并加 ${snapshot.awardPoints} 积分`}}</button><button v-if="!childPage" :class="{'is-disabled':busy}" class="secondary" :disabled="busy" @tap="submit(false)">代孩子提交，等待审核</button><button :class="{'is-disabled':busy}" class="secondary" :disabled="busy" @tap="saveDraft">保存草稿</button></view><view class="activity-draft-note"><AppIcon :name="saved?'check':'shield'" size="28rpx" :tone="saved?'green':'muted'"/><text>{{saved?'草稿已保存到服务端，未提交和发分。':'文字和数量自动保存在本机24小时；保存草稿后可跨设备查看。照片处理完成前请留在此页。'}}</text></view>
        </template>
        <template v-if="!session.isFamilyReadOnly&&!childPage&&occurrence.status==='SUBMITTED'"><view class="activity-review-prompt"><AppIcon name="heart" size="34rpx" tone="blue"/><view><text class="activity-row-title">这份努力，等你确认</text><text class="activity-support">查看下方完成说明与照片，再回应孩子。</text></view></view><view class="button-stack"><button :class="{'is-disabled':busy}" class="primary" :loading="busy" :disabled="busy" @tap="review('APPROVE')">通过并加 {{snapshot.awardPoints}} 积分</button><button class="secondary" @tap="action='RETURN';reason=''">请孩子补充</button></view></template>
        <button v-if="!session.isFamilyReadOnly&&!childPage&&['OPEN','SUBMITTED','NEEDS_CHANGES'].includes(occurrence.status)" class="activity-rest-button" @tap="action='EXEMPT';reason=''"><AppIcon name="leaf" size="28rpx" tone="muted"/><text>{{occurrence.type==='ROUTINE'?'今天休息，设为免做':'本次免做'}}</text></button>
        <view v-if="action&&!session.isFamilyReadOnly" class="activity-form-group"><text class="activity-form-heading">{{action==='RETURN'?'请补充的原因':'本次免做的原因'}}</text><textarea class="textarea section" v-model="reason" maxlength="200" :placeholder="action==='RETURN'?'告诉孩子需要补充什么':'写下这次休息的原因'"/><text class="activity-field-note">{{action==='RETURN'?'补充期限取原截止与本次退回后24小时中较晚者。':'不发分、不扣分，不计入应完成数；首发不支持恢复。'}}</text><button :class="{'is-disabled':busy}" class="primary full section" :loading="busy" :disabled="busy" @tap="review(action as 'RETURN'|'EXEMPT')">确认{{action==='RETURN'?'请孩子补充':'本次免做'}}</button><button class="text-button full" @tap="action=''">返回</button></view>
        <view v-if="childPage&&!editable&&occurrence.status==='OPEN'" class="notice warning section">当前还未开放或已经截止，请家长帮忙看看。</view><button v-if="!childPage&&occurrence.status==='APPROVED'" class="secondary full section" @tap="go('ledger',{childId:occurrence.childId})">查看积分记录，必要时完整纠错</button>
      </template>
    </view>
  </AppShell>
</template>

<style lang="scss">
.activity-page { padding-bottom: 12rpx; }
.activity-flex { flex: 1; min-width: 0; }
.activity-date { display: flex; align-items: center; gap: 12rpx; color: #606D80; font-size: 23rpx; margin: -4rpx 0 28rpx; }
.activity-overview { background: linear-gradient(135deg, #EAF3FF 0%, #F0EFFF 62%, #EFFAF6 100%); border: 1rpx solid rgba(255,255,255,.92); border-radius: 40rpx; padding: 36rpx; box-shadow: 0 12rpx 36rpx rgba(67,92,133,.05); }
.activity-overview-top { display: flex; align-items: center; gap: 20rpx; margin-bottom: 38rpx; }
.activity-overline { display: block; color: #61708D; font-size: 23rpx; font-weight: 500; margin-bottom: 12rpx; }
.activity-feature-title { display: block; font-size: 37rpx; font-weight: 700; color: #1C1C1E; line-height: 1.38; letter-spacing: -1rpx; }
.activity-feature-icon { width: 94rpx; height: 94rpx; border-radius: 32rpx; background: rgba(255,255,255,.6); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.activity-progress-heading { display: flex; align-items: center; justify-content: space-between; gap: 12rpx; margin-bottom: 16rpx; }
.activity-progress-number { font-size: 34rpx; color: #1C1C1E; font-weight: 700; }
.activity-small { font-size: 22rpx; color: #606D80; font-weight: 400; line-height: 1.5; }
.activity-support { display: block; color: #606D80; font-size: 24rpx; line-height: 1.6; margin-top: 6rpx; }
.activity-progress-track { height: 12rpx; border-radius: 12rpx; background: rgba(0,122,255,.09); overflow: hidden; }
.activity-progress-fill { height: 100%; border-radius: 12rpx; background: linear-gradient(90deg, #007AFF, #7EB5FF); }
.activity-helper { display: block; font-size: 22rpx; line-height: 1.6; color: #606D80; margin-top: 20rpx; }
.activity-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; margin: 40rpx 0 22rpx; }
.activity-section-title { display: block; color: #1C1C1E; font-size: 33rpx; font-weight: 700; letter-spacing: -.5rpx; }
.activity-count-label { color: #606D80; font-size: 23rpx; }
.activity-inbox-grid { display: flex; gap: 14rpx; }
.activity-inbox-item { flex: 1; min-width: 0; padding: 26rpx 10rpx 24rpx; margin: 0; border: 1rpx solid rgba(255,255,255,.85); background: rgba(255,255,255,.87); border-radius: 32rpx; display: flex; align-items: center; flex-direction: column; line-height: 1.4; box-shadow: 0 6rpx 26rpx rgba(57,74,110,.035); }
.activity-icon-tile { width: 64rpx; height: 64rpx; border-radius: 21rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.activity-tile-blue { background: #EAF3FF; }


.activity-inbox-count { color: #1C1C1E; font-size: 49rpx; font-weight: 700; letter-spacing: -1rpx; margin-top: 18rpx; }
.activity-inbox-label { color: #3A4050; font-size: 24rpx; font-weight: 600; margin-top: 4rpx; }
.activity-inbox-hint { color: #606D80; font-size: 22rpx; margin-top: 8rpx; }
.activity-inline-button { padding: 10rpx 0 10rpx 12rpx; margin: 0; display: flex; align-items: center; gap: 6rpx; color: #0066D6; background: transparent; font-size: 25rpx; line-height: 1.5; flex-shrink: 0; }
.activity-child-card { padding: 30rpx; border-radius: 38rpx; background: rgba(255,255,255,.94); border: 1rpx solid rgba(255,255,255,.95); margin-bottom: 20rpx; box-shadow: 0 10rpx 28rpx rgba(57,74,110,.035); }
.activity-child-profile { display: flex; align-items: center; gap: 22rpx; }
.activity-child-name { display: block; font-size: 34rpx; font-weight: 700; color: #1C1C1E; line-height: 1.4; }
.activity-child-metrics { display: flex; align-items: center; gap: 38rpx; padding: 30rpx 0 26rpx; }
.activity-child-points { min-width: 152rpx; }
.activity-metric-label { display: block; color: #606D80; font-size: 22rpx; line-height: 1.5; }
.activity-child-value { display: block; color: #1C1C1E; font-size: 47rpx; font-weight: 700; line-height: 1.35; letter-spacing: -1rpx; }
.activity-value-unit { font-size: 22rpx; font-weight: 500; color: #606D80; margin-left: 10rpx; letter-spacing: 0; }
.activity-child-progress { flex: 1; min-width: 0; padding-top: 4rpx; }
.activity-progress-text { font-size: 23rpx; color: #556377; font-weight: 600; }
.activity-track-small { height: 10rpx; }
.activity-child-actions { display: flex; gap: 14rpx; }
.activity-child-action { display: flex; align-items: center; justify-content: center; gap: 8rpx; flex: 1; margin: 0; padding: 19rpx 10rpx; min-height: 80rpx; box-sizing: border-box; background: #EDF5FF; color: #0066D6; font-size: 24rpx; font-weight: 600; border-radius: 23rpx; line-height: 1.45; }
.activity-child-action-muted { background: #F5F6FA; color: #434956; }
.activity-gentle-note { display: flex; align-items: flex-start; gap: 14rpx; padding: 18rpx 10rpx 4rpx; font-size: 23rpx; color: #606D80; line-height: 1.75; }
.activity-today-progress { background: rgba(255,255,255,.66); border-radius: 28rpx; padding: 26rpx 28rpx; margin-top: 18rpx; }
.activity-section-label { font-size: 25rpx; color: #4D596C; font-weight: 500; }
.activity-section-caption { display: block; color: #606D80; font-size: 22rpx; margin-top: 8rpx; line-height: 1.5; }
.activity-soft-icon { display: flex; align-items: center; justify-content: center; width: 60rpx; height: 60rpx; border-radius: 20rpx; background: #EDF4FF; flex-shrink: 0; }
.activity-task-group { margin-top: 2rpx; }
.activity-task-card { background: rgba(255,255,255,.94); border-radius: 34rpx; padding: 28rpx; margin-bottom: 18rpx; border: 1rpx solid rgba(255,255,255,.9); box-shadow: 0 6rpx 24rpx rgba(57,74,110,.025); }
.activity-task-main { display: flex; align-items: center; gap: 20rpx; }
.activity-task-icon { width: 86rpx; height: 86rpx; border-radius: 27rpx; background: #EDF4FF; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.activity-tile-lilac { background: #F0EDFF; }
.activity-tile-mint { background: #E6F7F0; }
.activity-row-title { display: block; color: #1C1C1E; font-size: 29rpx; font-weight: 600; line-height: 1.45; overflow-wrap: break-word; }
.activity-point-chip { display: flex; align-items: center; gap: 6rpx; color: #0066D6; font-size: 27rpx; font-weight: 700; background: #EEF5FF; border-radius: 18rpx; padding: 8rpx 12rpx; flex-shrink: 0; }
.activity-task-footer { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; border-top: 1rpx solid #F0F2F6; margin-top: 24rpx; padding-top: 16rpx; }
.activity-task-deadline { display: block; color: #606D80; font-size: 22rpx; line-height: 1.5; margin-top: 20rpx; }
.activity-wish-link { display: flex; align-items: center; gap: 20rpx; margin: 32rpx 0 0; background: linear-gradient(110deg,#EEF1FF,#F6F3FF); padding: 26rpx; border-radius: 32rpx; text-align: left; line-height: 1.5; }
.activity-filter-heading { margin: 20rpx 4rpx; }
.activity-filter { margin: 20rpx 0 26rpx; }
.activity-filter-control { display: flex; align-items: center; gap: 14rpx; background: rgba(255,255,255,.85); border-radius: 24rpx; padding: 22rpx 26rpx; color: #49566A; font-size: 25rpx; }
.activity-plan-toolbar { display: flex; align-items: center; gap: 20rpx; }
.activity-add-button { width: 82rpx; height: 82rpx; min-width: 82rpx; border-radius: 28rpx; margin: 0; padding: 0; background: #007AFF; display: flex; align-items: center; justify-content: center; box-shadow: 0 8rpx 18rpx rgba(0,122,255,.17); }
.activity-page-description { display: block; color: #606D80; font-size: 24rpx; margin: 24rpx 4rpx 10rpx; line-height: 1.65; }
.activity-filter-chips { margin-bottom: 24rpx; }
.activity-plan-card { background: rgba(255,255,255,.94); border-radius: 36rpx; border: 1rpx solid rgba(255,255,255,.96); padding: 30rpx; margin-bottom: 20rpx; box-shadow: 0 8rpx 30rpx rgba(57,74,110,.035); }
.activity-plan-schedule { display: flex; align-items: flex-start; gap: 12rpx; color: #606D80; font-size: 23rpx; line-height: 1.65; margin-top: 24rpx; }
.activity-plan-points { color: #0066D6; font-weight: 600; font-size: 24rpx; }
.activity-scheduled-note { display: flex; align-items: center; gap: 10rpx; border-radius: 18rpx; background: #F1F6FF; padding: 14rpx 18rpx; color: #63799C; font-size: 22rpx; margin-top: 20rpx; }
.activity-form-intro { display: flex; align-items: center; gap: 18rpx; margin-bottom: 28rpx; }
.activity-form-group { padding: 30rpx; border-radius: 34rpx; background: rgba(255,255,255,.93); margin-top: 24rpx; box-shadow: 0 5rpx 20rpx rgba(57,74,110,.025); }
.activity-form-heading { display: block; color: #1C1C1E; font-size: 30rpx; font-weight: 650; line-height: 1.5; }
.activity-form-heading-row { display: flex; align-items: center; gap: 12rpx; }
.activity-optional { color: #606D80; font-size: 22rpx; font-weight: 400; margin-left: 12rpx; }
.activity-field-note { display: block; color: #606D80; font-size: 22rpx; line-height: 1.7; margin-top: 12rpx; }
.activity-picker-content { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.activity-child-choices { display: flex; flex-direction: column; gap: 12rpx; margin-top: 22rpx; }
.activity-child-choice { display: flex; align-items: center; gap: 18rpx; margin: 0; padding: 18rpx 20rpx; background: #F6F7FA; border: 2rpx solid transparent; border-radius: 25rpx; text-align: left; line-height: 1.5; }
.activity-child-choice-selected { background: #F0F6FF; border-color: #CCE2FF; }
.activity-choice-name { flex: 1; min-width: 0; color: #3F4A5A; font-size: 27rpx; font-weight: 500; }
.activity-choice-check { width: 36rpx; height: 36rpx; border-radius: 50%; border: 2rpx solid #CFD7E3; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.activity-choice-check-selected { border-color: #007AFF; background: #007AFF; }
.activity-plan-preview { background: linear-gradient(120deg,#EAF3FF,#F0F0FC); padding: 30rpx; border-radius: 34rpx; margin-top: 28rpx; }
.activity-preview-label { display: flex; align-items: center; gap: 10rpx; color: #677F9F; font-size: 23rpx; }
.activity-preview-title { display: block; color: #253B5C; font-size: 34rpx; font-weight: 700; margin-top: 20rpx; line-height: 1.45; }
.activity-preview-award { display: flex; align-items: center; justify-content: space-between; margin-top: 26rpx; color: #657893; font-size: 24rpx; }
.activity-preview-points { color: #007AFF; font-size: 41rpx; font-weight: 700; }
.activity-detail-hero { padding: 34rpx; border-radius: 40rpx; background: linear-gradient(140deg,#FFFFFF,#F3F7FF 75%,#F1F5FF); border: 1rpx solid rgba(255,255,255,.98); box-shadow: 0 10rpx 30rpx rgba(57,74,110,.035); }
.activity-detail-hero-top { display: flex; justify-content: space-between; align-items: center; gap: 20rpx; }
.activity-detail-icon { width: 104rpx; height: 104rpx; border-radius: 34rpx; background: #EAF2FF; display: flex; align-items: center; justify-content: center; }
.activity-detail-title { display: block; font-size: 42rpx; font-weight: 700; color: #1C1C1E; line-height: 1.4; letter-spacing: -1rpx; margin-top: 26rpx; }
.activity-detail-copy { display: block; color: #606D80; font-size: 26rpx; line-height: 1.75; margin-top: 14rpx; white-space: pre-wrap; }
.activity-detail-metrics { display: flex; justify-content: space-between; gap: 24rpx; margin-top: 32rpx; padding-top: 26rpx; border-top: 1rpx solid #E5EBF5; }
.activity-goal-value { display: block; font-size: 30rpx; font-weight: 600; color: #3C4C63; line-height: 1.5; margin-top: 6rpx; }
.activity-award-block { text-align: right; flex-shrink: 0; }
.activity-award-value { display: block; font-size: 39rpx; font-weight: 700; color: #007AFF; line-height: 1.4; margin-top: 2rpx; }
.activity-detail-window { display: flex; align-items: flex-start; gap: 12rpx; font-size: 22rpx; color: #606D80; line-height: 1.65; margin-top: 26rpx; }
.activity-window-time { display: block; margin-top: 3rpx; }
.activity-date-picker { display: flex; align-items: center; gap: 10rpx; color: #0066D6; font-size: 24rpx; padding: 12rpx 0 12rpx 10rpx; }
.activity-grouped-list { background: rgba(255,255,255,.93); border-radius: 32rpx; padding: 4rpx 28rpx; overflow: hidden; }
.activity-record-row { display: flex; align-items: center; gap: 14rpx; padding: 26rpx 0; border-bottom: 1rpx solid #F0F2F6; }
.activity-record-icon { display: flex; align-items: center; justify-content: center; width: 64rpx; height: 64rpx; border-radius: 21rpx; background: #F0F5FE; flex-shrink: 0; }
.activity-version-row { display: flex; align-items: center; gap: 18rpx; padding: 26rpx 0; border-bottom: 1rpx solid #F0F2F6; }
.activity-version-index { display: flex; align-items: center; justify-content: center; background: #F3F5FA; color: #606D80; font-size: 25rpx; font-weight: 600; border-radius: 18rpx; width: 54rpx; height: 54rpx; flex-shrink: 0; }
.activity-version-points { color: #6D7E95; font-size: 24rpx; font-weight: 500; flex-shrink: 0; }
.activity-under-card { display: block; font-size: 22rpx; color: #606D80; text-align: center; margin: 20rpx 16rpx 28rpx; line-height: 1.6; }
.activity-completion-check { display: flex; align-items: center; gap: 18rpx; background: #F5F7FB; border: 2rpx solid transparent; border-radius: 27rpx; padding: 26rpx 20rpx; margin-top: 24rpx; }
.activity-completion-checked { background: #F0F6FF; border-color: #CFE3FF; }
.activity-number-control { display: flex; align-items: center; background: #F4F7FC; border: 2rpx solid #E6ECF6; border-radius: 28rpx; padding: 22rpx 26rpx; gap: 18rpx; }
.activity-number-input { flex: 1; min-width: 0; color: #007AFF; font-size: 60rpx; font-weight: 650; height: 90rpx; min-height: 90rpx; line-height: 90rpx; background: transparent; }
.activity-number-unit { font-size: 27rpx; font-weight: 500; color: #7E8CA1; }
.activity-draft-note { display: flex; align-items: flex-start; gap: 12rpx; padding: 22rpx 6rpx 0; font-size: 22rpx; color: #606D80; line-height: 1.75; }
.activity-review-prompt { display: flex; align-items: center; gap: 16rpx; margin: 30rpx 6rpx 4rpx; }
.activity-rest-button { display: flex; align-items: center; justify-content: center; gap: 10rpx; font-size: 24rpx; color: #606D80; background: transparent; padding: 24rpx 12rpx; margin-top: 16rpx; line-height: 1.6; }
.activity-submission-section { margin-top: 30rpx; }
.activity-submission-card { background: rgba(255,255,255,.93); border-radius: 34rpx; padding: 30rpx; margin-bottom: 22rpx; }
.activity-submission-heading { display: flex; align-items: center; gap: 18rpx; }
.activity-submission-result { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; background: #F5F8FD; border-radius: 24rpx; padding: 24rpx; margin-top: 24rpx; }
.activity-submission-value { color: #3B567A; font-size: 29rpx; font-weight: 600; }
.activity-submission-note { display: block; color: #627087; font-size: 26rpx; line-height: 1.75; white-space: pre-wrap; margin-top: 24rpx; }
.activity-submission-media { margin-top: 22rpx; }
.activity-review-item { display: flex; align-items: flex-start; gap: 16rpx; padding-top: 26rpx; margin-top: 26rpx; border-top: 1rpx solid #EFF2F7; }
.activity-review-marker { display: flex; align-items: center; justify-content: center; width: 44rpx; height: 44rpx; border-radius: 50%; background: #F0F7F5; flex-shrink: 0; }
.activity-review-reason { display: block; color: #65748A; font-size: 25rpx; line-height: 1.7; margin-top: 10rpx; }
</style>
