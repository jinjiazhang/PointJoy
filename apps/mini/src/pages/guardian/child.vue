<script setup lang="ts">
import Screen from '../../features/FamilyScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('child');
</script>

<template>
  <Screen v-if="ready" page="child" :query="params" />
</template>
