<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('reward');
</script>

<template>
  <Screen v-if="ready" page="reward" :query="params" />
</template>
