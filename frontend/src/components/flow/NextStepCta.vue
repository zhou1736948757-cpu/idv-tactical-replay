<script setup lang="ts">
import { setStep, type StepId } from '@/store/app';
defineProps<{ step: StepId; label: string }>();
</script>
<template>
<button class="gbtn fr cut" type="button" data-test="flow-next" @click="setStep(step)">{{ label }}</button>
</template>
