<script setup lang="ts">
import Screen from '../../features/RecordsScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('ledger');
</script>

<template>
  <Screen v-if="ready" page="ledger" :query="params" />
</template>
