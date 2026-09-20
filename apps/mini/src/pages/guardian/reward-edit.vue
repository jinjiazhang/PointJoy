<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('rewardEdit');
</script>

<template>
  <Screen v-if="ready" page="rewardEdit" :query="params" />
</template>
