<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('childOrder');
</script>

<template>
  <Screen v-if="ready" page="childOrder" :query="params" />
</template>
