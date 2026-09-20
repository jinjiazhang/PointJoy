<script setup lang="ts">
import { label } from '../services/format';
defineProps<{ status?: string }>();
</script>
<template>
  <text
    class="status-pill"
    :class="{
      waiting: ['SUBMITTED', 'PENDING_APPROVAL', 'NEEDS_CHANGES'].includes(status || ''),
      ended: ['REVOKED', 'CANCELED', 'REJECTED', 'EXPIRED', 'ARCHIVED'].includes(status || ''),
    }"
    >{{ label(status) }}</text
  >
</template>
