<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('childReward');
</script>

<template>
  <Screen v-if="ready" page="childReward" :query="params" />
</template>
