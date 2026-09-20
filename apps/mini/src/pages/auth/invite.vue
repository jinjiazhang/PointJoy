<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('invite');
</script>

<template>
  <Screen v-if="ready" page="invite" :query="params" />
</template>
