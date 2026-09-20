<script setup lang="ts">
import Screen from '../../features/FamilyScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('family');
</script>

<template>
  <Screen v-if="ready" page="family" :query="params" />
</template>
