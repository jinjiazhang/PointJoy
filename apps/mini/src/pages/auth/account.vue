<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('account');
</script>

<template>
  <Screen v-if="ready" page="account" :query="params" />
</template>
