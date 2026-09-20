<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('plan');
</script>

<template>
  <Screen v-if="ready" page="plan" :query="params" />
</template>
