// Runs before first paint (classic, non-deferred script; DESIGN §6.17).
// Applies the per-device theme preference so the first frame is already themed.
(function () {
  var theme = 'dark';
  try {
    var prefs = JSON.parse(localStorage.getItem('notesapp:prefs') || '{}');
    if (prefs && (prefs.theme === 'light' || prefs.theme === 'dark')) {
      theme = prefs.theme;
    } else if (prefs && prefs.theme === 'system' && window.matchMedia) {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch (e) {
    // Storage blocked or corrupt: keep the static dark default.
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', theme === 'light' ? '#ffffff' : '#1e1e1e');
  var colorScheme = document.querySelector('meta[name="color-scheme"]');
  if (colorScheme) colorScheme.setAttribute('content', theme === 'light' ? 'light dark' : 'dark light');
})();
