<script setup lang="ts">
import Screen from '../../features/FamilyScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('settings');
</script>

<template>
  <Screen v-if="ready" page="settings" :query="params" />
</template>
