<script setup>
defineProps({
  icon: { type: String, default: 'mdi-information-outline' },
  title: { type: String, required: true },
  text: { type: String, default: '' },
  actionText: { type: String, default: '' },
  actionTo: { type: String, default: '' }
})
</script>

<template>
  <div class="text-center py-10 px-4">
    <v-icon :icon="icon" size="40" class="text-medium-emphasis mb-3" />
    <div class="text-title-medium font-weight-medium">{{ title }}</div>
    <div v-if="text" class="text-body-medium text-medium-emphasis mt-1" style="white-space: pre-line">{{ text }}</div>
    <v-btn v-if="actionText" :to="actionTo" class="mt-4" variant="tonal" color="primary">{{ actionText }}</v-btn>
  </div>
</template>
