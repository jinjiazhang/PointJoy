<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('todos');
</script>

<template>
  <Screen v-if="ready" page="todos" :query="params" />
</template>
