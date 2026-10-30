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
  // 語言：在第一次繪製前就決定（避免畫面先出現另一種語言）——以 <html data-lang> 給 i18n.js 讀
  var lang = null;
  try {
    var rawLang = localStorage.getItem('cp:lang');
    lang = rawLang ? JSON.parse(rawLang) : null;
  } catch (e) { lang = null; }
  if (lang !== 'zh' && lang !== 'en') {
    lang = String(navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }
  document.documentElement.setAttribute('data-lang', lang);
})();
