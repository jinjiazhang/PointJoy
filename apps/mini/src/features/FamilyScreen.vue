<script setup lang="ts">
import {ref,computed} from 'vue'
import AppShell from '../components/AppShell.vue'
import AppIcon from '../components/AppIcon.vue'
import PrivateImage from '../components/PrivateImage.vue'
import MediaUploader from '../components/MediaUploader.vue'
import EmptyState from '../components/EmptyState.vue'
import StatusPill from '../components/StatusPill.vue'
import PointBalance from '../components/PointBalance.vue'
import LoadMore from '../components/LoadMore.vue'
import {usePage} from '../composables/usePage'
import {get,getAll,mutate,authPost,familyPath,childPath} from '../services/api'
import {go} from '../services/navigation'
import {label,dateTime} from '../services/format'
import type {Child,Account,PageResult,UploadItem,Guardian,Application,Invitation,ArchiveCheck,Wish} from '../services/types'
const props=defineProps<{page:string;query:Record<string,string>}>()
const children=ref<Child[]>([]),child=ref<Child|null>(null),account=ref<Account|null>(null),wish=ref<Wish|null>(null),nickname=ref(''),ageBand=ref(''),avatar=ref<UploadItem[]>([]),childDraftId=ref(''),guardians=ref<Guardian[]>([]),applications=ref<Application[]>([]),invitations=ref<Invitation[]>([]),bindingInvites=ref<Invitation[]>([]),inviteToken=ref(''),inviteExpires=ref(''),invitePurpose=ref(''),tab=ref(props.query.tab||'guardians'),reason=ref(''),pin=ref(''),pendingAction=ref(''),selectedId=ref(''),selectedVersion=ref(0),syncProfile=ref(false),archive=ref<ArchiveCheck|null>(null),retain=ref(false),name=ref(''),cursor=ref<string|null>(null),hasMore=ref(false),includeArchived=ref(false)
const ages=['不填写','4岁以下','4—6岁','7—9岁','10—12岁','13岁及以上'];const ageValues=['','UNDER_4','AGE_4_6','AGE_7_9','AGE_10_12','OVER_12']
const titles:Record<string,string>={family:'家庭',child:'孩子档案',childEdit:props.query.id?'编辑孩子档案':'添加孩子',guardians:'共同家长',settings:'家庭设置'}
const {loading,error,busy,reload,act,session}=usePage(props.page,load,'guardian')
const owner=computed(()=>session.isOwner)
async function load(){
 if(props.page==='family'){await loadChildren();return}
 if(props.page==='settings'){name.value=session.family?.family.name||'';return}
 if(props.page==='guardians'){await loadGuardians();return}
 if(props.page==='childEdit'){
  if(props.query.id){child.value=await get<Child>(childPath(props.query.id));nickname.value=child.value.nickname;ageBand.value=child.value.ageBand||'';avatar.value=[{localId:child.value.avatarMediaId,mediaId:child.value.avatarMediaId,status:'READY',progress:100}]}
  else if(!childDraftId.value){const draft=await mutate<{childDraftId:string}>('POST',familyPath('/child-drafts'),{},'准备孩子头像');childDraftId.value=draft.childDraftId}return
 }
 if(props.page==='child'){const id=props.query.id;[child.value,account.value,wish.value]=await Promise.all([get<Child>(childPath(id)),get<Account>(childPath(id,'/account')),get<Wish>(childPath(id,'/wish'))]);if(owner.value){const result=await get<Invitation[]|PageResult<Invitation>>(childPath(id,'/binding-invitations'));bindingInvites.value=Array.isArray(result)?result:result.items}}
}
async function loadChildren(more=false){const result=await get<PageResult<Child>>(familyPath('/children'),{status:includeArchived.value?undefined:'ACTIVE',cursor:more?cursor.value:undefined});children.value=more?[...children.value,...result.items]:result.items;cursor.value=result.nextCursor||null;hasMore.value=result.hasMore}
async function saveChild(){await act(async()=>{if(!nickname.value.trim()||[...nickname.value.trim()].length>24)throw new Error('孩子昵称需为1—24字');if(avatar.value.length!==1||avatar.value[0].status!=='READY'||!avatar.value[0].mediaId)throw new Error('请先上传孩子档案头像');const body={nickname:nickname.value.trim(),avatarMediaId:avatar.value[0].mediaId,...(ageBand.value?{ageBand:ageBand.value}:child.value?{ageBand:null}:{})};const result=await mutate<Child>(child.value?'PATCH':'POST',child.value?childPath(child.value.id):familyPath('/children'),child.value?{...body,expectedVersion:child.value.version}:{...body,childDraftId:childDraftId.value},child.value?'修改孩子资料':'建立孩子档案');go('child',{id:result.id},true)},'孩子档案已保存')}
async function loadGuardians(){const list=await get<Guardian[]|PageResult<Guardian>>(familyPath('/guardians'));guardians.value=Array.isArray(list)?list:list.items;if(owner.value){const [a,b,i]=await Promise.all([getAll<Application>(familyPath('/join-applications')),getAll<Application>(familyPath('/child-binding-applications')),getAll<Invitation>(familyPath('/invitations'))]);applications.value=[...a.map(x=>({...x,purpose:'GUARDIAN_JOIN'})),...b.map(x=>({...x,purpose:'CHILD_BIND'}))];invitations.value=i}}
async function createInvite(binding=false){await act(async()=>{const result=await mutate<{token:string;expiresAt:string;invitation?:Invitation}>('POST',binding?childPath(child.value!.id,'/binding-invitations'):familyPath('/invitations'),{},binding?'生成孩子绑定邀请':'生成共同家长邀请');inviteToken.value=result.token;inviteExpires.value=result.expiresAt;invitePurpose.value=binding?'CHILD_BIND':'GUARDIAN_JOIN';await load()},'邀请已生成，请交给对应的家人')}
function copyInvite(){uni.setClipboardData({data:inviteToken.value})}
async function revoke(inv:Invitation,binding=false){await act(async()=>{await mutate('POST',familyPath(`/${binding?'binding-invitations':'invitations'}/${inv.id}/revoke`),{expectedVersion:inv.version},'撤销邀请');await load()},'邀请已撤销')}
function showAction(action:string,id='',version=0){pendingAction.value=action;selectedId.value=id;selectedVersion.value=version;reason.value='';pin.value='';retain.value=false;syncProfile.value=false}
async function stepUp(action:string){const fields:Record<string,string>={action};if(pin.value)fields.pin=pin.value;else{const login=await new Promise<UniApp.LoginRes>((resolve,reject)=>uni.login({provider:'weixin',success:resolve,fail:reject}));fields.newWechatCode=login.code}const result=await authPost<{stepUpToken:string}>('/auth/step-up',fields);return result.stepUpToken}
async function checkArchive(family=false){await act(async()=>{archive.value=await get<ArchiveCheck>(family?familyPath('/archive-check'):childPath(child.value!.id,'/archive-check'));showAction(family?'archiveFamily':'archiveChild')})}
async function execute(){await act(async()=>{
 const a=pendingAction.value
 if(['remove','unbind','reject'].includes(a)&&!reason.value.trim())throw new Error('请填写原因')
 if(a==='remove')await mutate('POST',familyPath(`/guardians/${selectedId.value}/remove`),{reason:reason.value.trim(),expectedVersion:selectedVersion.value},'移除共同家长')
 if(a==='transfer'){const token=await stepUp('OWNERSHIP_TRANSFER');await mutate('POST',familyPath('/ownership-transfer'),{newOwnerMembershipId:selectedId.value,expectedVersion:session.family!.family.version,stepUpToken:token},'转让家庭负责人');await session.bootstrap()}
 if(a==='unbind'){const token=await stepUp('UNBIND_CHILD');await mutate('POST',childPath(child.value!.id,'/unbind'),{reason:reason.value.trim(),expectedBindingVersion:child.value!.bindingVersion,stepUpToken:token},'解除孩子账号绑定')}
 if(a==='approve'||a==='reject'){const app=applications.value.find(x=>x.id===selectedId.value)!;await mutate('POST',familyPath(`/${app.purpose==='CHILD_BIND'?'child-binding-applications':'join-applications'}/${app.id}/decision`),{decision:a==='approve'?'APPROVE':'REJECT',expectedVersion:app.version,...(reason.value.trim()?{reason:reason.value.trim()}:{}),...(app.purpose==='CHILD_BIND'?{syncProfile:syncProfile.value}:{})},a==='approve'?'批准申请':'拒绝申请')}
 if(a==='archiveChild'){if(!archive.value?.canArchive)throw new Error('请先处理下面列出的完成记录和订单');if(!retain.value)throw new Error('请确认保留只读账本');await mutate('POST',childPath(child.value!.id,'/archive'),{expectedVersion:archive.value.version,retainNonzeroBalanceConfirmed:true},'归档孩子档案')}
 if(a==='archiveFamily'){if(!archive.value?.canArchive)throw new Error('请先处理家庭全部待办');if(!retain.value)throw new Error('请确认保留只读账本');const token=await stepUp('ARCHIVE_FAMILY');await mutate('POST',familyPath('/archive'),{expectedVersion:archive.value.version,retainLedgersConfirmed:true,stepUpToken:token},'归档家庭');await session.bootstrap()}
 if(a==='leave'){await mutate('POST',familyPath('/leave'),{expectedVersion:session.family!.membership.version},'退出家庭');pendingAction.value='';go('contexts',{},true);return}
 pendingAction.value='';await load()
 },'操作已完成')}
async function saveFamily(){await act(async()=>{const n=name.value.trim();if([...n].length<2||[...n].length>30)throw new Error('家庭名需2—30字');await mutate('PATCH',familyPath(),{name:n,expectedVersion:session.family!.family.version},'修改家庭名称');await session.bootstrap()},'家庭名称已保存')}
function guardianName(g:Guardian){return g.user?.displayName||g.displayName||'共同家长'}
</script>
<template>
<AppShell :title="titles[page]" :tab="page==='family'?'family':''" :back="page!=='family'" :loading="loading" :error="error" @retry="reload">
<view class="family-ui">
  <template v-if="page==='family'">
    <view class="family-overview">
      <view class="family-icon-tile family-icon-tile-large"><AppIcon name="family" size="52rpx" tone="blue"/></view>
      <view class="grow"><text class="family-overline">一起陪伴，慢慢长大</text><button class="family-name-action" aria-label="切换家庭" @tap="go('contexts')"><text class="family-overview-title">{{session.family?.family.name||'我们的家庭'}}</text><AppIcon name="chevron" tone="muted" size="26rpx"/></button><text class="caption">每个孩子，都有自己的成长节奏。</text></view>
    </view>
    <view class="section-head family-section-head"><text class="section-title">孩子档案</text><button v-if="session.family?.family.status!=='ARCHIVED'" class="text-button family-add" @tap="go('childEdit')"><AppIcon name="plus" size="30rpx" tone="blue"/><text>添加孩子</text></button></view>
    <view class="family-children">
      <view v-for="c in children" :key="c.id" class="family-child-card" @tap="go('child',{id:c.id})">
        <PrivateImage :media-id="c.avatarMediaId" size="104rpx" avatar/>
        <view class="grow"><text class="family-child-name">{{c.nickname}}</text><text class="caption">{{c.status==='ARCHIVED'?'已归档 · 只读档案':'查看成长与积分'}}</text></view>
        <AppIcon name="chevron" size="30rpx" tone="muted"/>
      </view>
    </view>
    <EmptyState v-if="!loading&&!children.length" title="添加第一位小朋友" description="上传喜欢的头像，取一个家里熟悉的昵称。"/>
    <LoadMore :has-more="hasMore" :loading="busy" @more="act(()=>loadChildren(true))"/>
    <view class="check-row family-archive-filter" @tap="includeArchived=!includeArchived;act(()=>loadChildren())"><checkbox :checked="includeArchived" color="#007AFF"/><text>显示已归档档案</text></view>
    <view class="family-group-label">家庭管理</view>
    <view class="family-setting-group">
      <button class="family-setting-row" @tap="go('guardians')"><view class="family-icon-tile"><AppIcon name="family" size="36rpx" tone="blue"/></view><view class="family-setting-copy"><text class="family-setting-title">共同家长与邀请</text><text class="caption">和家人一起参与</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('history')"><view class="family-icon-tile family-icon-neutral"><AppIcon name="history" size="36rpx" tone="ink"/></view><view class="family-setting-copy"><text class="family-setting-title">家庭记录</text><text class="caption">完成、兑换与操作历史</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('settings')"><view class="family-icon-tile family-icon-neutral"><AppIcon name="settings" size="36rpx" tone="ink"/></view><view class="family-setting-copy"><text class="family-setting-title">设置与隐私</text><text class="caption">家庭资料、账号和数据</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
    </view>
    <view class="family-footnote"><AppIcon name="heart" size="30rpx" tone="muted"/><text>一位家长也能完整使用。可以直接记录真实完成，也可以代孩子提交后审核。</text></view>
  </template>

  <template v-else-if="page==='childEdit'">
    <view class="family-edit-intro"><text class="family-overview-title">{{child?'熟悉的小名，喜欢的头像':'认识一位小朋友'}}</text><text class="caption">这份档案属于孩子，也记录你们一起的成长。</text></view>
    <view class="family-panel"><MediaUploader v-model="avatar" :scope="{purpose:'CHILD_AVATAR',familyId:session.view?.familyId,childId:child?.id,childDraftId:childDraftId||undefined}" :max="1" avatar/></view>
    <view class="family-panel">
      <view class="field"><text class="field-label">孩子昵称 <text class="family-required">必填</text></text><input class="input" v-model="nickname" maxlength="24" placeholder="家里熟悉的小名就好"/></view>
      <view class="field"><text class="field-label">年龄段 <text class="family-optional">选填</text></text><picker :range="ages" :value="Math.max(0,ageValues.indexOf(ageBand))" @change="ageBand=ageValues[Number($event.detail.value)]"><view class="select-control family-select">{{ages[Math.max(0,ageValues.indexOf(ageBand))]}}<AppIcon name="chevron" size="26rpx" tone="muted"/></view></picker></view>
    </view>
    <view class="family-footnote"><AppIcon name="shield" size="30rpx" tone="muted"/><text>不需要学校、住址或精确生日。头像可以是插画，不必是真人照片。</text></view>
    <button :class="{'is-disabled':busy}" class="primary full family-save" :loading="busy" :disabled="busy" @tap="saveChild">保存孩子档案</button>
  </template>

  <template v-else-if="page==='child'&&child">
    <view class="family-profile-header"><PrivateImage :media-id="child.avatarMediaId" size="136rpx" avatar/><view class="grow"><text class="family-profile-name">{{child.nickname}}</text><StatusPill :status="child.status"/></view><view class="family-profile-decoration"><AppIcon name="heart" size="44rpx" tone="blue"/></view></view>
    <PointBalance class="family-balance" :account="account"/>
    <view v-if="wish?.rewardSummary" class="family-wish"><view class="family-icon-tile family-icon-warm"><AppIcon name="star" size="36rpx" tone="orange"/></view><view class="grow"><text class="caption">正在期待的小心愿</text><text class="family-setting-title">{{wish.rewardSummary.name}}</text></view></view>
    <button v-if="!session.isFamilyReadOnly&&child.status==='ACTIVE'" class="primary full family-save" :loading="busy" @tap="act(()=>session.enterChild(child!.id))">进入这个孩子的模式</button>
    <view class="family-group-label">陪伴与记录</view>
    <view class="family-setting-group">
      <button v-if="child.status==='ACTIVE'" class="family-setting-row" @tap="go('history',{childId:child.id,record:'true'})"><view class="family-icon-tile"><AppIcon name="check" size="36rpx" tone="blue"/></view><text class="family-setting-copy family-setting-title">记录完成 / 历史补记</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('ledger',{childId:child.id})"><view class="family-icon-tile family-icon-warm"><AppIcon name="star" size="36rpx" tone="orange"/></view><text class="family-setting-copy family-setting-title">积分账本与手动表扬</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('history',{childId:child.id})"><view class="family-icon-tile family-icon-neutral"><AppIcon name="history" size="36rpx" tone="ink"/></view><text class="family-setting-copy family-setting-title">完成与兑换记录</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button v-if="child.status==='ACTIVE'" class="family-setting-row family-row-divider" @tap="go('childEdit',{id:child.id})"><view class="family-icon-tile family-icon-neutral"><AppIcon name="edit" size="36rpx" tone="ink"/></view><text class="family-setting-copy family-setting-title">编辑孩子档案</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
    </view>
    <view v-if="owner" class="family-panel family-binding-panel">
      <view class="family-panel-heading"><AppIcon name="user" size="36rpx" tone="blue"/><text class="section-title">孩子自己的微信</text></view>
      <text class="family-panel-description">{{child.bindingState==='BOUND'?'已绑定微信，孩子可以自己登录。':'尚未绑定，可以继续由家长代操作。'}}</text>
      <template v-if="child.status==='ACTIVE'"><button v-if="child.bindingState!=='BOUND'" class="secondary full section" :loading="busy" @tap="createInvite(true)">生成孩子绑定邀请</button><button v-else class="danger-button full section" @tap="showAction('unbind')">解除当前微信绑定</button></template>
      <view v-for="inv in bindingInvites" :key="inv.id" class="family-invite-history"><view class="row between"><StatusPill :status="inv.status"/><button v-if="['ACTIVE','PENDING'].includes(inv.status)" class="text-button" @tap="revoke(inv,true)">撤销邀请</button></view><text class="caption">有效至 {{dateTime(inv.expiresAt)}}</text></view>
      <button class="family-inline-link" @tap="go('guardians',{tab:'applications'})"><text>查看绑定申请</text><AppIcon name="chevron" size="26rpx" tone="blue"/></button>
    </view>
    <button v-if="child.status==='ACTIVE'" class="family-quiet-action" @tap="checkArchive()"><AppIcon name="archive" size="30rpx" tone="muted"/><text>归档这个孩子的档案</text></button>
  </template>

  <template v-else-if="page==='guardians'">
    <view class="tabs family-tabs"><button :class="{active:tab==='guardians'}" @tap="tab='guardians'">共同家长</button><button v-if="owner" :class="{active:tab==='applications'}" @tap="tab='applications'">待处理申请</button><button v-if="owner" :class="{active:tab==='invitations'}" @tap="tab='invitations'">邀请</button></view>
    <template v-if="tab==='guardians'">
      <view v-for="g in guardians" :key="g.id" class="family-panel family-member-card"><view class="row"><PrivateImage :media-id="g.user?.avatarMediaId" size="96rpx" avatar/><view class="grow"><text class="family-child-name">{{guardianName(g)}}</text><text class="caption">{{label(g.role)}}</text></view><AppIcon v-if="g.role==='OWNER'" name="shield" size="36rpx" tone="blue"/></view><view v-if="!session.isFamilyReadOnly&&owner&&g.role!=='OWNER'" class="button-row family-member-actions"><button class="secondary" @tap="showAction('transfer',g.membershipId||g.id,g.version)">转让负责人</button><button class="danger-button" @tap="showAction('remove',g.membershipId||g.id,g.version)">移除</button></view></view>
      <button v-if="owner&&!session.isFamilyReadOnly" class="primary full family-save" @tap="createInvite()">邀请共同家长</button>
      <button class="family-quiet-action" @tap="showAction('leave')">退出这个家庭</button>
    </template>
    <template v-if="tab==='applications'">
      <view v-for="a in applications" :key="a.id" class="family-panel"><view class="row between"><text class="family-overline">{{a.purpose==='CHILD_BIND'?'孩子账号绑定':'共同家长加入'}}</text><StatusPill :status="a.status"/></view><view class="row family-applicant"><PrivateImage :media-id="(a.applicantProfile||a.applicant)?.avatarMediaId" size="96rpx" avatar/><view class="grow"><text class="family-child-name">{{(a.applicantProfile||a.applicant)?.displayName||'申请者'}}</text><text v-if="a.child||a.childNickname" class="caption">目标孩子：{{a.child?.nickname||a.childNickname}}</text></view></view><text class="caption">申请于 {{dateTime(a.createdAt)}}</text><view v-if="['PENDING','PENDING_APPROVAL'].includes(a.status)" class="button-row family-member-actions"><button class="primary" @tap="showAction('approve',a.id,a.version)">核对并批准</button><button class="secondary" @tap="showAction('reject',a.id,a.version)">拒绝</button></view></view>
      <EmptyState v-if="!applications.length" title="暂时没有申请" description="受邀家人完成头像昵称后，可以向你提出申请。"/>
    </template>
    <template v-if="tab==='invitations'">
      <button class="primary full family-save" @tap="createInvite()">生成新家长邀请</button>
      <view v-for="inv in invitations" :key="inv.id" class="family-panel"><view class="row between"><view class="family-panel-heading"><AppIcon name="family" size="34rpx" tone="blue"/><text class="family-setting-title">共同家长邀请</text></view><StatusPill :status="inv.status"/></view><text class="caption section">有效至 {{dateTime(inv.expiresAt)}}</text><button v-if="['ACTIVE','PENDING'].includes(inv.status)" class="family-inline-link" @tap="revoke(inv)"><text>撤销此邀请</text></button></view>
    </template>
  </template>

  <template v-else-if="page==='settings'">
    <view class="family-group-label">家庭资料</view>
    <view class="family-panel"><view class="field"><text class="field-label">家庭名称</text><input class="input" v-model="name" maxlength="30" :disabled="!owner||session.family?.family.status==='ARCHIVED'"/></view><button v-if="owner&&session.family?.family.status!=='ARCHIVED'" class="primary full" :loading="busy" @tap="saveFamily">保存家庭名称</button></view>
    <view class="family-group-label">账号与安全</view>
    <view class="family-setting-group">
      <button class="family-setting-row" @tap="go('account')"><view class="family-icon-tile"><AppIcon name="user" size="36rpx" tone="blue"/></view><text class="family-setting-copy family-setting-title">我的头像、昵称与账号</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('pin',{purpose:session.view?.pinEnabled?'change':'enroll'})"><view class="family-icon-tile family-icon-neutral"><AppIcon name="lock" size="36rpx" tone="ink"/></view><text class="family-setting-copy family-setting-title">设置 / 修改家长密码</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
      <button class="family-setting-row family-row-divider" @tap="go('privacy')"><view class="family-icon-tile family-icon-neutral"><AppIcon name="shield" size="36rpx" tone="ink"/></view><text class="family-setting-copy family-setting-title">隐私说明与个人数据</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button>
    </view>
    <template v-if="owner"><view class="family-group-label">家庭数据</view><view class="family-setting-group"><button class="family-setting-row" @tap="go('privacy',{scope:'FAMILY'})"><view class="family-icon-tile"><AppIcon name="download" size="36rpx" tone="blue"/></view><view class="family-setting-copy"><text class="family-setting-title">家庭全量数据</text><text class="caption">申请导出或删除</text></view><AppIcon name="chevron" size="28rpx" tone="muted"/></button><button v-if="session.family?.family.status!=='ARCHIVED'" class="family-setting-row family-row-divider" @tap="checkArchive(true)"><view class="family-icon-tile family-icon-neutral"><AppIcon name="archive" size="36rpx" tone="ink"/></view><text class="family-setting-copy family-setting-title">归档家庭</text><AppIcon name="chevron" size="28rpx" tone="muted"/></button></view></template>
    <view class="family-footnote"><AppIcon name="shield" size="30rpx" tone="muted"/><text>归档保留只读记录，不等于删除。最后一位家长不能直接退出留下无主家庭。</text></view>
  </template>

  <view v-if="inviteToken" class="family-panel family-generated-invite"><view class="family-panel-heading"><AppIcon name="family" size="38rpx" tone="blue"/><text class="section-title">{{invitePurpose==='CHILD_BIND'?'孩子绑定邀请':'共同家长邀请'}}</text></view><text class="family-panel-description">24 小时内、一次成功有效。只交给你确认的对应使用者。</text><text class="caption">有效至 {{dateTime(inviteExpires)}}</text><view class="code-box section">{{inviteToken}}</view><button class="primary full section" @tap="copyInvite">复制邀请令牌</button><text class="caption section">对方微信登录后需上传头像、填写昵称，再在家庭入口粘贴邀请。申请仍需负责人批准。</text></view>

  <view v-if="pendingAction" class="family-panel family-confirm-panel"><view class="family-panel-heading"><AppIcon name="shield" size="38rpx" tone="orange"/><text class="section-title">确认{{({remove:'移除家长',transfer:'转让负责人',unbind:'解除绑定',approve:'批准申请',reject:'拒绝申请',archiveChild:'归档孩子',archiveFamily:'归档家庭',leave:'退出家庭'} as Record<string,string>)[pendingAction]}}</text></view><view class="notice warning section">{{pendingAction==='unbind'?'旧微信账号将立即不能再访问这个孩子，账本和历史保留。':pendingAction==='transfer'?'新负责人将获得邀请、移除和家庭数据管理权限。':pendingAction==='leave'?'退出后不能再访问这个家庭。负责人必须先转让，最后一名家长不能直接退出。':'请核对对象和操作后果，历史操作将被保留。'}}</view>
    <template v-if="archive&&pendingAction.startsWith('archive')"><view v-if="!archive.canArchive" class="notice error">请先处理以下待办，不能自动批准或取消。</view><button v-for="o in archive.blockingOccurrences" :key="o.id" class="secondary full section" @tap="go('occurrence',{id:o.id})">处理完成记录：{{o.snapshot?.title||o.id}}</button><button v-for="o in archive.blockingOrders" :key="o.id" class="secondary full section" @tap="go('order',{id:o.id})">处理兑换：{{o.rewardSnapshot?.name||o.id}}</button><text v-if="archive.account" class="body-copy">保留只读账本：可用 {{archive.account.availablePoints}}、预留 {{archive.account.heldPoints}} 积分</text><view class="check-row" @tap="retain=!retain"><checkbox :checked="retain" color="#007AFF"/><text>我确认保留只读账本，归档不清零积分</text></view></template>
    <view v-if="['remove','unbind','reject'].includes(pendingAction)" class="field"><text class="field-label">原因（必填）</text><textarea class="textarea" v-model="reason" maxlength="200"/></view>
    <view v-if="pendingAction==='approve'&&applications.find(x=>x.id===selectedId)?.purpose==='CHILD_BIND'" class="check-row" @tap="syncProfile=!syncProfile"><checkbox :checked="syncProfile" color="#007AFF"/><text>将已验证的账号头像昵称同步到孩子档案</text></view>
    <view v-if="['transfer','unbind','archiveFamily'].includes(pendingAction)" class="field"><text class="field-label">家长密码（如已设置）</text><input class="input" v-model="pin" password type="number" maxlength="6"/></view>
    <view class="button-row"><button :class="{'is-disabled':busy}" class="primary" :loading="busy" :disabled="busy" @tap="execute">确认操作</button><button :class="{'is-disabled':busy}" class="secondary" :disabled="busy" @tap="pendingAction=''">暂不操作</button></view>
  </view>
</view>
</AppShell>
</template>

<style lang="scss">
.family-ui { color: #1c1c1e; }
.family-overview { display: flex; align-items: center; gap: 26rpx; padding: 34rpx 28rpx; margin-bottom: 34rpx; background: #fff; border: 1rpx solid rgba(28,28,30,.035); border-radius: 40rpx; }
.family-overline { display: block; font-size: 22rpx; font-weight: 600; line-height: 1.5; color: #8e8e93; letter-spacing: 1rpx; }
.family-overview-title { display: block; margin: 7rpx 0 10rpx; font-size: 35rpx; font-weight: 650; line-height: 1.3; letter-spacing: -.6rpx; }
.family-name-action { display: flex; align-items: center; gap: 10rpx; margin: 0; padding: 0; background: transparent; border-radius: 0; text-align: left; }
.family-icon-tile { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 64rpx; height: 64rpx; border-radius: 20rpx; background: #edf5ff; }
.family-icon-tile-large { width: 106rpx; height: 106rpx; border-radius: 34rpx; }
.family-icon-neutral { background: #f2f3f7; }
.family-icon-warm { background: #fff5e8; }
.family-section-head { margin: 4rpx 6rpx 18rpx; }
.family-add { display: flex; align-items: center; gap: 6rpx; font-size: 25rpx; }
.family-children { display: flex; flex-direction: column; gap: 16rpx; }
.family-child-card { display: flex; align-items: center; gap: 24rpx; min-height: 154rpx; padding: 26rpx; background: #fff; border-radius: 36rpx; border: 1rpx solid rgba(28,28,30,.035); }
.family-child-name { display: block; margin-bottom: 7rpx; font-size: 32rpx; font-weight: 650; line-height: 1.4; }
.family-archive-filter { margin: 10rpx 6rpx 26rpx; color: #8e8e93; font-size: 24rpx; }
.family-group-label { margin: 34rpx 18rpx 14rpx; font-size: 24rpx; font-weight: 500; color: #8e8e93; line-height: 1.5; }
.family-setting-group { overflow: hidden; padding: 0 26rpx; background: #fff; border: 1rpx solid rgba(28,28,30,.035); border-radius: 36rpx; }
.family-setting-row { display: flex; align-items: center; gap: 20rpx; min-height: 116rpx; width: 100%; margin: 0; padding: 24rpx 0; border-radius: 0; background: transparent; text-align: left; line-height: 1.4; color: #1c1c1e; }
.family-row-divider { border-top: 1rpx solid #f0f0f3; }
.family-setting-copy { display: block; flex: 1; min-width: 0; }
.family-setting-title { display: block; font-size: 28rpx; font-weight: 550; line-height: 1.45; }
.family-setting-row .caption { margin-top: 5rpx; font-size: 23rpx; }
.family-footnote { display: flex; align-items: flex-start; gap: 12rpx; padding: 24rpx 14rpx; color: #8e8e93; font-size: 23rpx; line-height: 1.65; }
.family-panel { margin: 20rpx 0; padding: 30rpx; border-radius: 36rpx; background: #fff; border: 1rpx solid rgba(28,28,30,.035); }
.family-panel-heading { display: flex; align-items: center; gap: 14rpx; }
.family-panel-description { display: block; margin: 18rpx 0 8rpx; color: #636366; font-size: 26rpx; line-height: 1.7; }
.family-edit-intro { padding: 4rpx 6rpx 16rpx; }
.family-required { margin-left: 10rpx; color: #007aff; font-size: 22rpx; font-weight: 400; }
.family-optional { margin-left: 10rpx; color: #8e8e93; font-size: 22rpx; font-weight: 400; }
.family-select { display: flex; align-items: center; justify-content: space-between; }
.family-save { margin: 26rpx 0; }
.family-profile-header { display: flex; align-items: center; gap: 26rpx; margin: 4rpx 0 24rpx; padding: 30rpx; border-radius: 40rpx; background: #fff; }
.family-profile-name { display: block; margin-bottom: 12rpx; font-size: 42rpx; font-weight: 680; letter-spacing: -1rpx; line-height: 1.25; }
.family-profile-decoration { align-self: flex-start; padding-top: 8rpx; }
.family-balance { margin-bottom: 20rpx; }
.family-wish { display: flex; align-items: center; gap: 20rpx; padding: 26rpx; background: #fff; border-radius: 32rpx; }
.family-wish .family-setting-title { margin-top: 6rpx; }
.family-binding-panel { margin-top: 30rpx; }
.family-invite-history { padding: 22rpx 0; margin-top: 14rpx; border-top: 1rpx solid #f0f0f3; }
.family-inline-link { display: flex; align-items: center; justify-content: space-between; gap: 12rpx; width: 100%; margin: 14rpx 0 0; padding: 18rpx 0 0; background: transparent; color: #007aff; text-align: left; font-size: 26rpx; line-height: 1.5; }
.family-quiet-action { display: flex; align-items: center; justify-content: center; gap: 10rpx; margin: 24rpx auto; padding: 20rpx; background: transparent; color: #8e8e93; font-size: 25rpx; line-height: 1.5; }
.family-tabs { margin-bottom: 28rpx; }
.family-member-card { padding: 28rpx; }
.family-member-actions { margin-top: 24rpx; padding-top: 22rpx; border-top: 1rpx solid #f0f0f3; }
.family-applicant { margin: 24rpx 0 18rpx; }
.family-generated-invite { border-color: #d8eaff; }
.family-confirm-panel { border-color: #f0dfc3; margin-top: 32rpx; }
</style>
