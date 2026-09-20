<script setup lang="ts">
import Screen from '../../features/ActivityScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('planEdit');
</script>

<template>
  <Screen v-if="ready" page="planEdit" :query="params" />
</template>
