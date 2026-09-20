<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('occurrence');
</script>

<template>
  <Screen v-if="ready" page="occurrence" :query="params" />
</template>
