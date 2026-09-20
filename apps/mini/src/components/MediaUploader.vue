<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { UploadItem } from '../services/types';
import {
  chooseLocalImages,
  uploadImage,
  pollImage,
  mediaUrl,
  type MediaScope,
} from '../services/media';
import { mutate } from '../services/api';
import { uuid } from '../services/vault';
import PrivateImage from './PrivateImage.vue';
import AppIcon from './AppIcon.vue';
const props = withDefaults(
  defineProps<{
    modelValue: UploadItem[];
    scope: MediaScope;
    max?: number;
    avatar?: boolean;
    wechatAvatar?: boolean;
    disabled?: boolean;
  }>(),
  { max: 3, avatar: false, wechatAvatar: false, disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [UploadItem[]] }>();
const count = computed(() => props.modelValue.length);
const choosing = ref(false);
const showOtherAvatar = ref(false);
let supportsWechatAvatar = false;
// #ifdef MP-WEIXIN
supportsWechatAvatar = uni.canIUse('button.open-type.chooseAvatar');
// #endif
function selectionError(e: unknown) {
  const message = e instanceof Error ? e.message : (e as { errMsg?: string })?.errMsg;
  if (message && !/cancel/i.test(message)) {
    uni.showToast({ title: '未能选择图片，请重试', icon: 'none' });
  }
}
async function selectAndUpload(select: () => Promise<UploadItem[]>) {
  if (props.disabled || choosing.value) {
    return;
  }
  choosing.value = true;
  try {
    const files = await select();
    if (!files.length) {
      return;
    }
    const additions = files.map((f) => reactive(f));
    const list = props.avatar ? additions : [...props.modelValue, ...additions];
    emit('update:modelValue', list);
    for (const item of additions) {
      try {
        await uploadImage(item, props.scope);
      } catch {
        /* each tile displays its own retry state */
      }
    }
  } catch (e) {
    selectionError(e);
  } finally {
    choosing.value = false;
  }
}
async function choose(source: 'camera' | 'album') {
  await selectAndUpload(() =>
    chooseLocalImages(props.avatar ? 1 : props.max - count.value, source),
  );
}
async function chooseWechatAvatar(event: { detail?: { avatarUrl?: string } }) {
  const path = event.detail?.avatarUrl;
  if (
    !props.wechatAvatar ||
    !props.avatar ||
    props.scope.purpose !== 'USER_AVATAR' ||
    typeof path !== 'string' ||
    !path
  ) {
    return;
  }
  await selectAndUpload(async () => [
    {
      localId: uuid(),
      localPath: path,
      name: path.split('/').pop() || 'wechat-avatar.jpg',
      status: 'SELECTED',
      progress: 0,
    },
  ]);
}
function wechatAvatarError(event: unknown) {
  selectionError((event as { detail?: { errMsg?: string } })?.detail);
}
async function remove(item: UploadItem) {
  item.status = 'DELETED';
  emit(
    'update:modelValue',
    props.modelValue.filter((i) => i.localId !== item.localId),
  );
  if (item.mediaId) {
    try {
      await mutate('DELETE', `/media/${item.mediaId}`, {}, '移除未提交照片');
    } catch {
      /* expired or already removed files have no business effect */
    }
  }
}
async function retry(item: UploadItem) {
  try {
    if (item.status === 'PROCESSING') {
      await pollImage(item);
    } else if (item.localPath) {
      await uploadImage(item, props.scope);
    } else {
      await choose('album');
    }
  } catch {
    /* item carries its own error */
  }
}
async function preview(item: UploadItem) {
  const url = item.localPath || (item.mediaId ? await mediaUrl(item.mediaId) : '');
  if (url) {
    uni.previewImage({ urls: [url] });
  }
}
</script>
<template>
  <view class="media-upload"
    ><view class="row between"
      ><text class="field-label">{{ avatar ? '头像（必选）' : '完成照片（选填）' }}</text
      ><text v-if="!avatar" class="caption">{{ count }}/{{ max }}</text></view
    ><view v-if="avatar && !count" class="avatar-empty"
      ><AppIcon name="user" tone="blue" size="78rpx" /></view
    ><view class="media-grid" :class="{ single: avatar }"
      ><view v-for="(item, index) in modelValue" :key="item.localId" class="media-tile"
        ><view @tap="preview(item)"
          ><image v-if="item.localPath" :src="item.localPath" mode="aspectFill" /><PrivateImage
            v-else
            :media-id="item.mediaId"
            size="180rpx"
          /><text class="caption">{{
            item.status === 'READY'
              ? avatar
                ? '已选好'
                : '已准备好'
              : item.status === 'UPLOADING'
                ? avatar
                  ? '正在保存头像'
                  : '正在保存照片'
                : item.status === 'PROCESSING'
                  ? '正在处理'
                  : item.status === 'DELETED'
                    ? '已过期'
                    : item.status === 'FAILED'
                      ? '保存未完成'
                      : '正在准备'
          }}</text></view
        ><button
          v-if="!disabled"
          class="remove-image"
          :disabled="choosing"
          @tap="remove(item)"
          :aria-label="`移除第${index + 1}张图片`"
        >
          ×</button
        ><text v-if="item.error" class="field-error">{{ item.error }}</text
        ><button
          v-if="['FAILED', 'PROCESSING', 'DELETED'].includes(item.status) && !disabled"
          class="text-button"
          :disabled="choosing"
          @tap="retry(item)"
        >
          重试 / 查询
        </button></view
      ></view
    ><view v-if="!disabled && (count < max || avatar)">
      <!-- #ifdef MP-WEIXIN -->
      <button
        v-if="wechatAvatar && avatar && scope.purpose === 'USER_AVATAR' && supportsWechatAvatar"
        class="primary full wechat-avatar-button"
        :class="{ 'is-disabled': choosing }"
        open-type="chooseAvatar"
        :disabled="choosing"
        @chooseavatar="chooseWechatAvatar"
        @error="wechatAvatarError"
      >
        <AppIcon name="wechat" tone="blue" size="36rpx" /><text>{{
          count ? '更换微信头像' : '选择微信头像'
        }}</text></button
      ><button
        v-if="wechatAvatar && supportsWechatAvatar"
        class="text-button full"
        @tap="showOtherAvatar = !showOtherAvatar"
      >
        {{ showOtherAvatar ? '收起其他方式' : '使用其他头像' }}
      </button>
      <text v-if="wechatAvatar && !supportsWechatAvatar" class="caption"
        >当前微信版本不支持微信头像选择，可以从相册上传，或升级微信后重试。</text
      >
      <!-- #endif -->
      <view v-if="!wechatAvatar || !supportsWechatAvatar || showOtherAvatar" class="upload-actions"
        ><button
          class="secondary"
          :class="{ 'is-disabled': choosing }"
          :disabled="choosing"
          @tap="choose('album')"
        >
          从相册选择</button
        ><button
          class="secondary"
          :class="{ 'is-disabled': choosing }"
          :disabled="choosing"
          @tap="choose('camera')"
        >
          拍照
        </button></view
      ></view
    ><text class="caption upload-help"
      >{{
        avatar
          ? '选择头像后会自动保存，无需再上传一次。头像也可以是喜欢的插画。'
          : '仅本人及有权限的家长可见。草稿照片保留24小时，首次正式提交后保留180天。'
      }}
      JPEG / PNG / WebP，每张不超过10 MiB。</text
    ><text v-if="modelValue.some((x) => x.status !== 'READY')" class="field-error"
      >请等待图片保存完成；未完成时可以重试或重新选择。</text
    ></view
  >
</template>
