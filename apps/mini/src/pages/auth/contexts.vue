<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('contexts');
</script>

<template>
  <Screen v-if="ready" page="contexts" :query="params" />
</template>
