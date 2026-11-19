let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * A short line under the terminal header for six seconds: an error (a failed
 * fork, a file that could not be attached), or with `info` news that is not one
 * (a session moved to another account). A new one replaces the last.
 */
export function showHeaderToast(message: string, info = false): void {
  const toast = document.getElementById('error-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('info', info);
  toast.classList.remove('hidden');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => toast.classList.add('hidden'), 6000);
}
