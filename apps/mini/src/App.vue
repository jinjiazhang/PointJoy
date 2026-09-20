<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';
import { useSession } from './stores/session';
onShow(() => {
  useSession().foreground();
});
</script>
<style lang="scss">
@use './design/theme.scss';
</style>
