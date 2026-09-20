import { request, mutate, get, ApiError } from './api';
import { loadAuth, uuid } from './vault';
import type { UploadItem, UploadIntent, MediaAsset } from './types';
import { sendImageFile } from './media-transport';
const readCache = new Map<string, { url: string; expires: number; scope: string }>();
uni.$on('scope:changed', () => readCache.clear());
export async function mediaUrl(id: string, force = false) {
  const scope = loadAuth()?.session.actorScopeKey || '';
  const entry = readCache.get(id);
  if (!force && entry && entry.scope === scope && entry.expires > Date.now() + 5000) {
    return entry.url;
  }
  const grant = await request<{ readUrl: string; expiresAt: string }>(
    'POST',
    `/media/${id}/read-grants`,
    {},
  );
  if (scope !== loadAuth()?.session.actorScopeKey) {
    throw new ApiError('SCOPE_MISMATCH', '当前身份已变更');
  }
  readCache.set(id, { url: grant.readUrl, expires: Date.parse(grant.expiresAt), scope });
  return grant.readUrl;
}
export interface MediaScope {
  purpose: 'USER_AVATAR' | 'CHILD_AVATAR' | 'COMPLETION_EVIDENCE';
  familyId?: string;
  childId?: string;
  childDraftId?: string;
  occurrenceId?: string;
}
export async function chooseLocalImages(
  count: number,
  source: 'camera' | 'album' = 'album',
): Promise<UploadItem[]> {
  const result = await new Promise<UniApp.ChooseImageSuccessCallbackResult>((resolve, reject) =>
    uni.chooseImage({
      count,
      sizeType: ['original'],
      sourceType: [source],
      success: resolve,
      fail: reject,
    }),
  );
  const files = Array.isArray(result.tempFiles) ? result.tempFiles : [];
  const paths = Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [result.tempFilePaths];
  return paths.map((path: string, i: number) => ({
    localId: uuid(),
    localPath: path,
    mime: (files[i] as { type?: string })?.type,
    name: (files[i] as { name?: string })?.name || path.split('/').pop() || 'photo.jpg',
    status: 'SELECTED',
    progress: 0,
  }));
}
export async function uploadImage(item: UploadItem, scope: MediaScope) {
  if (!item.localPath) {
    throw new ApiError('MEDIA_LOCAL_MISSING', '请重新选择照片');
  }
  const context = loadAuth()?.session.actorScopeKey;
  item.status = 'UPLOADING';
  item.error = undefined;
  try {
    const file = await new Promise<{ size: number }>((resolve, reject) =>
      uni.getFileInfo({
        filePath: item.localPath!,
        success: (r) => resolve({ size: r.size }),
        fail: reject,
      }),
    );
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('每张图片不能超过 10 MiB');
    }
    const info = await new Promise<UniApp.GetImageInfoSuccessData>((resolve, reject) =>
      uni.getImageInfo({ src: item.localPath!, success: resolve, fail: reject }),
    );
    if (info.width * info.height > 40000000) {
      throw new Error('图片不能超过 4,000 万像素');
    }
    let detectedType = info.type || item.mime?.split('/')[1] || '';
    // #ifdef H5
    if (!detectedType) {
      const localBlob = await fetch(item.localPath).then((r) => r.blob());
      detectedType = localBlob.type.split('/')[1] || '';
    }
    // #endif
    const format = (detectedType || item.name?.split('.').pop() || '').toLowerCase();
    const mime =
      format === 'png'
        ? 'image/png'
        : format === 'webp'
          ? 'image/webp'
          : ['jpg', 'jpeg'].includes(format)
            ? 'image/jpeg'
            : '';
    if (!mime) {
      throw new Error('只支持 JPEG、PNG、WebP 图片');
    }
    const intent = await mutate<UploadIntent>(
      'POST',
      '/media/upload-intents',
      { ...scope, filename: item.name || `photo.${format}`, mime, sizeBytes: file.size },
      '创建图片上传',
    );
    item.mediaId = intent.mediaId;
    if (intent.uploadMethod !== 'POST') {
      throw new Error('上传协议不匹配，请刷新后重试');
    }
    if (context !== loadAuth()?.session.actorScopeKey) {
      throw new Error('身份已切换，请重新选择图片');
    }
    await sendImageFile(intent, item, mime, file.size);
    if (context !== loadAuth()?.session.actorScopeKey) {
      throw new Error('身份已切换，请在原身份重新检查图片');
    }
    item.asset = await mutate<MediaAsset>(
      'POST',
      `/media/${item.mediaId}/finish`,
      {},
      '处理上传图片',
    );
    item.status = 'PROCESSING';
    await pollImage(item);
  } catch (e) {
    item.status = 'FAILED';
    item.error = e instanceof Error ? e.message : '图片上传失败';
    throw e;
  }
}
export async function pollImage(item: UploadItem) {
  if (!item.mediaId) {
    return;
  }
  for (const wait of [0, 1000, 2000, 4000, 8000, 8000]) {
    if (wait) {
      await new Promise((r) => setTimeout(r, wait));
    }
    if (item.status === 'DELETED') {
      return;
    }
    const asset = await get<MediaAsset>(`/media/${item.mediaId}`);
    item.asset = asset;
    item.status = asset.status;
    if (asset.status === 'READY') {
      item.progress = 100;
      return;
    }
    if (asset.status === 'FAILED' || asset.status === 'DELETED') {
      item.error = asset.failureCode || '图片不可用，请重试或移除';
      return;
    }
  }
  item.status = 'PROCESSING';
  item.error = '图片仍在处理，可以稍后查询状态';
}
export async function previewMedia(ids: string[]) {
  const urls = await Promise.all(ids.map((id) => mediaUrl(id, true)));
  uni.previewImage({ urls });
}
