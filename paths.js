/* Lesson Vault — path helper for InfinityFree / subdirectory hosting */
window.LV = window.LV || {};

LV.siteUrl = function (path) {
  return new URL(String(path || '').replace(/^\//, ''), document.baseURI).href;
};

LV.apiUrl = function (path) {
  return LV.siteUrl('api/' + String(path || '').replace(/^\//, ''));
};
