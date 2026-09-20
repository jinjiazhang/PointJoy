<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('login');
</script>

<template>
  <Screen v-if="ready" page="login" :query="params" />
</template>
