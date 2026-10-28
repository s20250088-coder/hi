// 深色 / 淺色模式：在第一次繪製前就套用，避免畫面閃白。
// 使用者沒選過時依系統偏好；選過（cp:theme）就沿用。
(function () {
  var t = null;
  try {
    var raw = localStorage.getItem('cp:theme');
    t = raw ? JSON.parse(raw) : null;
  } catch (e) { t = null; }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
