<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('today');
</script>

<template>
  <Screen v-if="ready" page="today" :query="params" />
</template>
