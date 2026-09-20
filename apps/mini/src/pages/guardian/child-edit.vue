<script setup lang="ts">
import Screen from '../../features/FamilyScreen.vue';
import { useScreenPage } from '../../composables/useScreenPage';

const { params, ready } = useScreenPage('childEdit');
</script>

<template>
  <Screen v-if="ready" page="childEdit" :query="params" />
</template>
