<script setup lang="ts">
import Screen from '../../features/AuthScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('profile');
</script>

<template>
  <Screen v-if="ready" page="profile" :query="params" />
</template>
