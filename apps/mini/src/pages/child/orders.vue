<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('orders');
</script>

<template>
  <Screen v-if="ready" page="orders" :query="params" />
</template>
