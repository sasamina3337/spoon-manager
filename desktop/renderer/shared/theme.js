// Runs before styles load so a saved dark theme does not flash a light screen.
(() => {
  const key = 'spoon-manager.theme';
  const modes = ['system', 'light', 'dark'];
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  const valid = value => modes.includes(value) ? value : 'system';
  let mode = 'system';
  try { mode = valid(window.localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    document.documentElement.dataset.theme = mode === 'system' ? (system?.matches ? 'dark' : 'light') : mode;
    const picker = document.getElementById('theme-mode');
    if (picker) picker.value = mode;
  }
  apply();
  system?.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    mode = valid(event.newValue);
    apply();
  });
  function initialize() {
    apply();
    document.getElementById('theme-mode')?.addEventListener('change', event => {
      mode = valid(event.target.value);
      try { window.localStorage.setItem(key, mode); } catch { /* Keep the choice for this window. */ }
      apply();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once: true});
  else initialize();
})();
