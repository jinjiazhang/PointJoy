<script setup lang="ts">
import Screen from '../../features/FamilyScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('guardians');
</script>

<template>
  <Screen v-if="ready" page="guardians" :query="params" />
</template>
