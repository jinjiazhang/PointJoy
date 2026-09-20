<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('rewards');
</script>

<template>
  <Screen v-if="ready" page="rewards" :query="params" />
</template>
