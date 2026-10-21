// Keep the callback identity stable so React focuses only when a field mounts,
// rather than reclaiming focus after another field updates the editor.
export function focusInputOnMount(input: HTMLInputElement | null) {
  input?.focus({ preventScroll: true });
}
