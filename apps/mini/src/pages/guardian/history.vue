<script setup lang="ts">
import Screen from '../../features/RecordsScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('history');
</script>

<template>
  <Screen v-if="ready" page="history" :query="params" />
</template>
