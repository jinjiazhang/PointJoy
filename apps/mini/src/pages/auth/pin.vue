<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('pin');
</script>

<template>
  <Screen v-if="ready" page="pin" :query="params" />
</template>
