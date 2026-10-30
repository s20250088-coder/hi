/* ================================================================
 * 彩紙屋 · 展示網站與語言切換
 *  - 繁中 / English 切換（記在 localStorage，預設跟隨瀏覽器）
 *  - 展示站與工作區之間的切換（保留原有畫布功能）
 *  - 限制與缺點列表、頁面內容套用
 * ================================================================ */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const STORE_KEY = 'cp:lang';
  const TITLES = {
    zh: '彩紙屋 Color Paper Studio · 燙金燙雷射色紙彩繪',
    en: 'Color Paper Studio · Gold-foil & holographic drawing in your browser',
  };

  function preferredLang() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved === 'zh' || saved === 'en') return saved;
    } catch { /* ignore */ }
    const nav = (navigator.language || 'zh').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }

  function savedLang() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      return saved === 'zh' || saved === 'en' ? saved : null;
    } catch { return null; }
  }

  /** 套用字典到靜態標記 */
  function applyStatic(lang) {
    const t = window.CP_I18N.t;
    for (const el of $$('[data-i18n]')) {
      const key = el.dataset.i18n;
      el.textContent = t(key);
    }
    for (const el of $$('[data-i18n-html]')) {
      el.innerHTML = t(el.dataset.i18nHtml);
    }
    for (const el of $$('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    }
    for (const el of $$('[data-i18n-title]')) {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    }
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
    document.title = TITLES[lang] || TITLES.zh;
    for (const btn of $$('.lang-btn')) {
      const on = btn.dataset.lang === lang;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute('content', lang === 'en'
        ? 'Color Paper Studio: pick a white sheet with a gold-foil or holographic edge, draw with six tools, draw together in a two-person room and trade paper. A browser-based drawing studio.'
        : '彩紙屋 Color Paper Studio：可選擇燙金邊、燙雷射邊的色紙，用鉛筆、炭筆、水彩、螢光筆、原子筆與燙金筆作畫，和朋友聯機彩繪、聊天、交換色紙。');
    }
  }

  /** 限制與缺點列表 */
  function renderLimits(lang) {
    const list = document.getElementById('limitList');
    if (!list) return;
    const t = window.CP_I18N.t;
    const items = window.CP_I18N.limits();
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'limit-card';
      li.innerHTML = `
        <div class="limit-head">
          <span class="limit-ico" aria-hidden="true">${it.icon}</span>
          <span class="limit-tag">${it.tag}</span>
          <span class="limit-no">${String(i + 1).padStart(2, '0')}</span>
        </div>
        <h3>${it.title}</h3>
        <p>${it.text}</p>
        <p class="limit-fix"><b>${t('honesty.improve')}</b>${it.fix}</p>`;
      list.appendChild(li);
    });
  }

  /** 切換演示畫布上的工具按鈕文字 */
  function localizeDemoTools() {
    const t = window.CP_I18N.t;
    for (const btn of $$('#demoTools .demo-tool')) {
      const label = btn.querySelector('span');
      if (label && btn.dataset.i18nTool) label.textContent = t(btn.dataset.i18nTool);
    }
  }

  function setLang(lang, opts = {}) {
    const next = lang === 'en' ? 'en' : 'zh';
    // 先更新屬性和字典的 current()，再套用文字
    document.documentElement.setAttribute('data-lang', next);
    applyStatic(next);
    renderLimits(next);
    localizeDemoTools();
    if (!opts.initial) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }
    // 通知 app.js 重繪所有動態文字（狀態列、房間卡片、畫廊…）
    document.dispatchEvent(new CustomEvent('cp:langchange', { detail: { lang: next } }));
    document.dispatchEvent(new CustomEvent('cp:langsettled', { detail: { lang: next } }));
    // 語言按鈕旁的小提示（螢幕閱讀器）
    const live = document.getElementById('langLive');
    if (live) live.textContent = next === 'en' ? 'Language set to English' : '語言已切換為繁體中文';
    try { sessionStorage.removeItem('cp:langAnchor'); } catch { /* ignore */ }
  }

  /* ---- 展示站 / 工作區 ---- */
  let studioOpen = false;

  function openStudio(opts = {}) {
    const site = document.getElementById('siteView');
    const shell = document.getElementById('studioShell');
    if (!site || !shell) return;
    site.hidden = true;
    shell.hidden = false;
    document.body.classList.add('studio-mode');
    studioOpen = true;
    window.scrollTo(0, 0);
    // 讓畫布依新的視窗大小重新排版
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
    });
    if (opts.hash) history.replaceState(null, '', opts.hash);
    document.title = (window.CP_I18N.current() === 'en' ? 'Studio · ' : '工作區 · ') + TITLES[window.CP_I18N.current()].split(' · ')[0];
    // 更新頂部按鈕文字
    const enter = document.getElementById('enterBtn');
    if (enter) enter.textContent = window.CP_I18N.t('cta.backToSite');
    document.dispatchEvent(new CustomEvent('cp:studioshow'));
  }

  function closeStudio(hash = '#studio') {
    const site = document.getElementById('siteView');
    const shell = document.getElementById('studioShell');
    if (!site || !shell) return;
    shell.hidden = true;
    site.hidden = false;
    document.body.classList.remove('studio-mode');
    studioOpen = false;
    document.title = TITLES[window.CP_I18N.current()];
    const enter = document.getElementById('enterBtn');
    if (enter) enter.textContent = window.CP_I18N.t('cta.openStudio');
    history.replaceState(null, '', hash);
    if (hash === '#studio') {
      const target = document.getElementById('studio');
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
      else window.scrollTo(0, 0);
    }
    document.dispatchEvent(new CustomEvent('cp:studiohide'));
  }

  function toggleStudio() {
    if (studioOpen) closeStudio('#studio');
    else openStudio({ hash: '#workspace' });
  }

  function initNavigation() {
    const enter = document.getElementById('enterBtn');
    if (enter) enter.addEventListener('click', toggleStudio);
    const hero = document.getElementById('heroTry');
    if (hero) hero.addEventListener('click', () => openStudio({ hash: '#workspace' }));
    const back = document.getElementById('studioBackBtn');
    if (back) back.addEventListener('click', () => closeStudio('#studio'));
    const brand = document.getElementById('siteBrand');
    if (brand) {
      brand.addEventListener('click', (e) => {
        e.preventDefault();
        if (studioOpen) closeStudio('#top');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    // 錨點導覽：在工作區時要先回到展示站
    for (const a of $$('a[href^="#"]')) {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href').slice(1);
        if (!id) return;
        if (studioOpen) {
          e.preventDefault();
          closeStudio('#' + id);
        }
      });
    }
    // 支援網址直接開啟工作區：#workspace
    if (location.hash === '#workspace') openStudio({ hash: '#workspace' });
  }

  function initLang() {
    for (const btn of $$('.lang-btn')) {
      btn.addEventListener('click', () => setLang(btn.dataset.lang));
    }
    const initial = savedLang() || preferredLang();
    setLang(initial, { initial: true });
  }

  function init() {
    initLang();
    initNavigation();
    // 內建測試用
    window.CP_SITE = { setLang, openStudio, closeStudio, isStudioOpen: () => studioOpen };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
