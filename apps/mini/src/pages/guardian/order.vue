<script setup lang="ts">
import Screen from '../../features/RewardScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('order');
</script>

<template>
  <Screen v-if="ready" page="order" :query="params" />
</template>
