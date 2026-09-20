<script setup lang="ts">
import Screen from '../../features/RecordsScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('growth');
</script>

<template>
  <Screen v-if="ready" page="growth" :query="params" />
</template>
