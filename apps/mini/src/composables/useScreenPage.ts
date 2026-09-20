import { ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import type { RouteName } from '../services/navigation';

/** Forward page lifecycle events to the feature screen after its query is ready. */
export function useScreenPage(page: RouteName) {
  const params = ref<Record<string, string>>({});
  const ready = ref(false);

  onLoad((options) => {
    params.value = Object.fromEntries(
      Object.entries(options || {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    ready.value = true;
  });

  const notifyVisible = () => uni.$emit('page:visible', page);
  onShow(notifyVisible);
  onPullDownRefresh(notifyVisible);

  return { params, ready };
}
