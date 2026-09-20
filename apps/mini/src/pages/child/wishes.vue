<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('wishes');
</script>

<template>
  <Screen v-if="ready" page="wishes" :query="params" />
</template>
