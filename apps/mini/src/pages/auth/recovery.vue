<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('recovery');
</script>

<template>
  <Screen v-if="ready" page="recovery" :query="params" />
</template>
