<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('activity');
</script>

<template>
  <Screen v-if="ready" page="activity" :query="params" />
</template>
