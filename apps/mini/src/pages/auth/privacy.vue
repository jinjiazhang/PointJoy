<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('privacy');
</script>

<template>
  <Screen v-if="ready" page="privacy" :query="params" />
</template>
