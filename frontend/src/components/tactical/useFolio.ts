import { onScopeDispose, ref } from 'vue';

export function useFolio() {
  const folioOpen = ref(true);
  const toggleFolio = () => { folioOpen.value = !folioOpen.value; };
  function onKey(event: KeyboardEvent) {
    if (event.key !== ']' || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]')) return;
    toggleFolio();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKey);
    onScopeDispose(() => window.removeEventListener('keydown', onKey));
  }
  return { folioOpen, toggleFolio };
}
