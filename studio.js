/* ================================================================
 * 彩紙屋 · 展示站上的兩塊畫布
 *  1. 首頁 Hero：會發光的色紙（燙金 / 雷射邊＋一段示範筆跡）
 *  2. 線上試玩：可實際作畫的小畫布（六種筆、顏色、筆寬、復原、清空、存圖）
 * 兩者都重用 app.js 裡的同一套 Canvas 渲染程式（window.CP_ENGINE）。
 * ================================================================ */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function dprOf() {
    return Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  }

  function sizeCanvas(canvas, cssW, cssH) {
    const dpr = dprOf();
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /* ================================================================
   * 1. Hero 色紙
   * ================================================================ */
  function initHero() {
    const host = document.getElementById('heroPaper');
    if (!host) return;
    const paperCv = document.getElementById('heroPaperCanvas');
    const fxCv = document.getElementById('heroFx');
    const inkCv = document.getElementById('heroInk');
    const size = 720;
    let sparks = [];
    let last = 0;
    let raf = 0;
    let visible = true;

    function layout() {
      const box = host.getBoundingClientRect();
      const cssW = Math.max(200, Math.min(box.width, box.height));
      const cssH = cssW;
      for (const cv of [paperCv, fxCv, inkCv]) {
        cv.style.width = cssW + 'px';
        cv.style.height = cssH + 'px';
      }
      const p = sizeCanvas(paperCv, cssW, cssH);
      const f = sizeCanvas(fxCv, cssW, cssH);
      const i = sizeCanvas(inkCv, cssW, cssH);
      drawPaper(p, cssW, cssH);
      drawSampleInk(i, cssW, cssH);
      sparks = buildSparks(cssW * dprOf(), cssH * dprOf());
      drawEdgeFrame(f, cssW, cssH, 0);
    }

    function drawPaper(ctx, w, h) {
      const E = window.CP_ENGINE;
      const dpr = dprOf();
      if (!E || !E.getPaperFill) return;
      const text = E.getPaperFill('white', Math.round(w * dpr), Math.round(h * dpr));
      const rad = Math.round(w * 0.09);
      const pad = E.getPad(rad);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, Math.max(0, rad * 0.9 - pad * 0.6));
      ctx.clip();
      ctx.drawImage(text, 0, 0, w, h);
      ctx.restore();
    }

    function buildSparks(w, h) {
      const E = window.CP_ENGINE;
      if (E && E.buildSparks) {
        const paper = { bg: 'white', edge: 'gold', hue: 210 };
        E.buildSparks(w, h, paper, Math.round(w * 0.09));
        return E.getSparks().slice();
      }
      return [];
    }

    function drawEdgeFrame(ctx, w, h, t) {
      const E = window.CP_ENGINE;
      if (!E || !E.drawEdge) return;
      const dpr = dprOf();
      const R = Math.round(w * 0.09) * dpr;
      const saved = E.getSparks ? E.getSparks() : [];
      if (E.setSparks) E.setSparks(sparks);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      E.drawEdge(ctx, Math.round(w * dpr), Math.round(h * dpr), { bg: 'white', edge: 'gold', hue: 210 }, R, t, false);
      ctx.restore();
      if (E.setSparks) E.setSparks(saved);
    }

    function drawSampleInk(ctx, w, h) {
      const E = window.CP_ENGINE;
      if (!E || !E.paintStroke) return;
      const dpr = dprOf();
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const S = (pts) => pts.map(([x, y]) => ({ x: x * w, y: y * h }));
      // 水彩色的波浪
      const wave = [];
      for (let k = 0; k <= 40; k++) {
        const u = k / 40;
        wave.push([0.22 + u * 0.56, 0.42 + Math.sin(u * Math.PI * 2 + 0.6) * 0.07]);
      }
      E.paintStroke(ctx, S(wave), 'watercolor', '#2f8f7a', Math.max(6, w * 0.055), 0.55, 11);
      // 燙金筆的一撇
      const gold = [];
      for (let k = 0; k <= 30; k++) {
        const u = k / 30;
        gold.push([0.2 + u * 0.58, 0.6 + Math.sin(u * Math.PI * 1.2) * 0.03]);
      }
      E.paintStroke(ctx, S(gold), 'goldpen', '#e8c269', Math.max(4, w * 0.034), 1, 7);
      // 鉛筆的細線
      const pencil = [];
      for (let k = 0; k <= 30; k++) {
        const u = k / 30;
        pencil.push([0.26 + u * 0.5, 0.74 - Math.sin(u * Math.PI) * 0.05]);
      }
      E.paintStroke(ctx, S(pencil), 'pencil', '#3d3a42', Math.max(2, w * 0.012), 0.9, 3);
      ctx.restore();
    }

    function frame(now) {
      if (!visible) { raf = 0; return; }
      const t = now / 1000;
      if (!last) last = t;
      last = t;
      // 只在看得見時才畫
      const f = fxCv.getContext('2d');
      const dpr = dprOf();
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.clearRect(0, 0, fxCv.width, fxCv.height);
      drawEdgeFrame(f, fxCv.width / dpr, fxCv.height / dpr, t);
      raf = requestAnimationFrame(frame);
    }

    // 等版面完成後才量測（剛載入時可能還量不到尺寸）
    requestAnimationFrame(() => { layout(); setTimeout(layout, 300); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        const wasVisible = visible;
        visible = entries.some((e) => e.isIntersecting);
        if (visible && !wasVisible) layout();
        if (visible && !raf) raf = requestAnimationFrame(frame);
      }, { threshold: 0.05 }).observe(host);
    }
    raf = requestAnimationFrame(frame);
    let t0 = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t0);
      t0 = setTimeout(layout, 150);
    });
    window.addEventListener('load', () => setTimeout(layout, 120));
    document.addEventListener('cp:langchange', () => setTimeout(layout, 120));
    document.addEventListener('cp:studioshow', () => { visible = false; });
    document.addEventListener('cp:studiohide', () => { visible = true; if (!raf) raf = requestAnimationFrame(frame); });
  }

  /* ================================================================
   * 2. 線上試玩
   * ================================================================ */
  function initDemo() {
    const paper = document.getElementById('demoPaper');
    if (!paper) return;
    const paperCv = document.getElementById('demoPaperCanvas');
    const fxCv = document.getElementById('demoFx');
    const inkCv = document.getElementById('demoInk');
    const toolsBox = document.getElementById('demoTools');
    const colorInput = document.getElementById('demoColor');
    const sizeInput = document.getElementById('demoSize');

    const TOOLS = [
      { id: 'pencil', key: 'tool.pencil', icon: '✎' },
      { id: 'watercolor', key: 'tool.watercolor', icon: '💧' },
      { id: 'highlight', key: 'tool.highlight', icon: '▭' },
      { id: 'pen', key: 'tool.pen', icon: '✒' },
      { id: 'goldpen', key: 'tool.goldpen', icon: '✨' },
      { id: 'eraser', key: 'tool.eraser', icon: '⌫' },
    ];
    const tool = { id: 'pen', color: '#1d1c2b', size: 3 };
    const SIZES = { pencil: 3, watercolor: 18, highlight: 22, pen: 3, goldpen: 8, eraser: 26 };
    const SAVE_KEY = 'cp:demoDraft';
    let strokes = [];
    let undone = [];
    let drawing = null;
    let demoSeq = 0;
    const nextSeed = () => (demoSeq = (demoSeq + 7919) % 100000, demoSeq);
    let sparks = [];
    let raf = 0;
    let hasGold = false;

    // 工具按鈕
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo-tool';
      b.dataset.tool = t.id;
      b.dataset.i18nTool = t.key;
      b.innerHTML = `<i aria-hidden="true">${t.icon}</i><span>${window.CP_I18N ? window.CP_I18N.t(t.key) : t.id}</span>`;
      b.addEventListener('click', () => pickTool(t.id));
      toolsBox.appendChild(b);
    }

    function pickTool(id) {
      tool.id = id;
      tool.size = SIZES[id] || 3;
      tool.color = id === 'goldpen' ? '#d9a93b' : id === 'eraser' ? '#ffffff' : (colorInput.value || '#1d1c2b');
      for (const b of $$('.demo-tool', toolsBox)) b.classList.toggle('active', b.dataset.tool === id);
      sizeInput.value = tool.size;
      colorInput.disabled = id === 'eraser';
      inkCv.style.cursor = id === 'eraser' ? 'cell' : 'crosshair';
    }
    colorInput.addEventListener('input', () => {
      tool.color = colorInput.value;
      if (tool.id === 'eraser') pickTool('pen');
    });
    sizeInput.addEventListener('input', () => { tool.size = Number(sizeInput.value); });

    function layout() {
      // 量測用父容器（畫布的 CSS 尺寸由 aspect-ratio 決定，可能還沒完成排版）
      // 以「外框內可用的寬度」為準（只取父容器寬度，畫布本身不會撐大版面）
      const host = paper.parentElement || paper;
      const hostStyle = getComputedStyle(host);
      const avail = host.clientWidth - parseFloat(hostStyle.paddingLeft || 0) - parseFloat(hostStyle.paddingRight || 0);
      const maxPx = Math.min(window.innerWidth - 48, 720);
      let cssW = Math.min(avail > 0 ? avail : 0, maxPx);
      // 還量不到（例如在畫面外）就先略過，等捲動到時再排版
      if (cssW < 120) return false;
      const cssH = Math.round(cssW * 3 / 4);
      paper.style.width = cssW + 'px';
      paper.style.height = cssH + 'px';
      const p = sizeCanvas(paperCv, cssW, cssH);
      sizeCanvas(fxCv, cssW, cssH);
      sizeCanvas(inkCv, cssW, cssH);
      drawPaper(p, cssW, cssH);
      sparks = (() => {
        const E = window.CP_ENGINE;
        if (!E || !E.buildSparks) return [];
        const dpr = dprOf();
        E.buildSparks(cssW * dpr, cssH * dpr, { bg: 'white', edge: 'gold', hue: 210 }, Math.round(cssW * dpr * 0.07));
        return E.getSparks().slice();
      })();
      renderInk();
      return true;
    }

    function drawPaper(ctx, w, h) {
      const E = window.CP_ENGINE;
      const dpr = dprOf();
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (E && E.getPaperFill && E.getPad) {
        const rad = Math.round(w * 0.07);
        const pad = E.getPad(rad);
        const fill = E.getPaperFill('white', Math.round(w * dpr), Math.round(h * dpr));
        ctx.beginPath();
        ctx.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, Math.max(2, rad - pad));
        ctx.clip();
        ctx.drawImage(fill, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#f7f2e8';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }

    function renderInk() {
      const E = window.CP_ENGINE;
      const dpr = (inkCv.width > 0 && inkCv.getBoundingClientRect().width > 0)
        ? inkCv.width / inkCv.getBoundingClientRect().width
        : dprOf();
      const ctx = inkCv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, inkCv.width, inkCv.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!E || !E.paintStroke) return;
      for (const s of strokes) {
        // 座標換回 CSS 像素（畫布有內部解析度，必須乘上實際縮放）
        E.paintStroke(ctx, s.points.map((q) => ({ x: q.x * (inkCv.width / dpr), y: q.y * (inkCv.height / dpr) })), s.tool, s.color, s.size, 1, s.seed);
      }
      hasGold = strokes.some((s) => s.tool === 'goldpen');
    }

    function drawFx(t) {
      const E = window.CP_ENGINE;
      const dpr = (fxCv.width > 0 && fxCv.getBoundingClientRect().width > 0)
        ? fxCv.width / fxCv.getBoundingClientRect().width
        : dprOf();
      const ctx = fxCv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, fxCv.width, fxCv.height);
      if (!E || !E.drawEdge) return;
      const w = fxCv.width / dpr;
      const h = fxCv.height / dpr;
      const R = Math.round(Math.min(w, h) * 0.07) * dpr;
      const saved = E.getSparks ? E.getSparks() : [];
      if (E.setSparks) E.setSparks(sparks);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      E.drawEdge(ctx, fxCv.width, fxCv.height, { bg: 'white', edge: 'gold', hue: 210 }, R, t, false);
      if (E.setSparks) E.setSparks(saved);
    }

    function frame(now) {
      drawFx(now / 1000);
      raf = requestAnimationFrame(frame);
    }

    function norm(e) {
      const r = inkCv.getBoundingClientRect();
      // 防護：捲動或版面還沒完成時 r 可能是 0，除以 0 會得到 Infinity 讓整筆畫在畫布外
      const w = r.width || inkCv.width || 1;
      const h = r.height || inkCv.height || 1;
      const x = (e.clientX - r.left) / w;
      const y = (e.clientY - r.top) / h;
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    function start(e) {
      // 不要對 PointerEvent 呼叫 preventDefault()：那會把這個指標標成「已取消」，
      // 瀏覽器隨後會自動送出 pointercancel，把正在畫的這一筆中斷。（改由 CSS touch-action 阻止捲動）
      if (e.cancelable && e.pointerType === 'mouse') e.preventDefault();
      try { inkCv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (tool.id === 'eraser') {
        // 橡皮擦：只抹掉自己畫過的；簡化版直接移除最近的筆畫（示意）
        drawing = { erase: true, last: norm(e) };
        eraseAt(drawing.last);
        return;
      }
      const p = norm(e);
      const s = {
        id: 's' + Math.random().toString(36).slice(2, 9),
        tool: tool.id,
        color: tool.color,
        size: tool.size,
        seed: nextSeed(),
        points: [p],
      };
      strokes.push(s);
      undone = [];
      drawing = s;
      renderInk();
      scheduleSave();
    }

    function move(e) {
      if (!drawing) return;
      const p = norm(e);
      if (drawing.erase) { eraseAt(p); drawing.last = p; return; }
      const pts = drawing.points;
      const lastP = pts[pts.length - 1];
      if (Math.abs(lastP.x - p.x) * inkCv.width < 1.5 && Math.abs(lastP.y - p.y) * inkCv.height < 1.5) return;
      pts.push(p);
      renderInk();
    }

    /** 局部擦除：把每一筆被擦到的點切掉，其餘保留（一條線擦中間會變兩段） */
    function eraseAt(p) {
      const w = paper.getBoundingClientRect().width || 1;
      const h = paper.getBoundingClientRect().height || 1;
      const radius = tool.size / 2;
      let changed = false;
      const next = [];
      for (const s of strokes) {
        const thr = radius + s.size * 0.45;
        const thr2 = thr * thr;
        const keep = s.points.map((q) => Math.hypot((q.x - p.x) * w, (q.y - p.y) * h) > thr);
        if (keep.every(Boolean)) { next.push(s); continue; }
        changed = true;
        let cur = [];
        const flush = () => {
          if (cur.length >= 2) next.push({ ...s, id: s.id + '#' + next.length, points: cur });
          else if (cur.length === 1) next.push({ ...s, id: s.id + '#' + next.length, points: [cur[0], { x: cur[0].x + 0.0006, y: cur[0].y + 0.0006 }] });
          cur = [];
        };
        s.points.forEach((q, i) => { if (keep[i]) cur.push(q); else flush(); });
        flush();
        void thr2;
      }
      if (changed) {
        strokes = next;
        renderInk();
        scheduleSave();
      }
    }

    function end() {
      drawing = null;
    }

    const openFull = document.getElementById('demoOpenStudio');
    if (openFull) {
      openFull.addEventListener('click', () => {
        // 把示範畫面的圖存成畫廊（可選）並進入正式工作區
        if (window.CP_SITE) window.CP_SITE.openStudio({ hash: '#workspace' });
      });
    }
    inkCv.addEventListener('pointerdown', start);
    inkCv.addEventListener('pointermove', move);
    inkCv.addEventListener('pointerup', end);
    inkCv.addEventListener('pointercancel', end);
    inkCv.addEventListener('pointerleave', () => {});
    window.addEventListener('pointerup', () => { if (drawing) end(); });

    document.getElementById('demoUndo').addEventListener('click', () => {
      const s = strokes.pop();
      if (!s) { toast(window.CP_I18N.t('toast.noUndo')); return; }
      undone.push(s);
      renderInk();
      scheduleSave();
    });
    document.getElementById('demoRedo').addEventListener('click', () => {
      const s = undone.pop();
      if (!s) { toast(window.CP_I18N.t('toast.noRedo')); return; }
      strokes.push(s);
      renderInk();
      scheduleSave();
    });
    document.getElementById('demoClear').addEventListener('click', () => {
      if (!strokes.length) { toast(window.CP_I18N.t('toast.noStroke')); return; }
      const n = strokes.length;
      if (!confirm(window.CP_I18N.t('toast.confirmClear', { n }))) return;
      undone = strokes.slice().reverse().concat(undone).slice(0, 50);
      strokes = [];
      renderInk();
      scheduleSave();
    });
    document.getElementById('demoSave').addEventListener('click', () => {
      const dpr = dprOf();
      const w = inkCv.width, h = inkCv.height;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const c = out.getContext('2d');
      c.drawImage(paperCv, 0, 0);
      c.drawImage(fxCv, 0, 0);
      c.drawImage(inkCv, 0, 0);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = 'rgba(120, 80, 20, .75)';
      c.font = `600 ${Math.max(9, w / dpr * 0.022)}px "Noto Serif TC", serif`;
      c.textAlign = 'right';
      c.fillText('Color Paper Studio', w / dpr - 14, h / dpr - 12);
      try {
        const a = document.createElement('a');
        a.href = out.toDataURL('image/png');
        a.download = 'color-paper-demo.png';
        a.click();
      } catch (err) {
        toast(window.CP_I18N.t('studio.noExport'));
      }
    });

    /* ---- 草稿自動儲存（重新整理後還能接續畫） ---- */
    let saveTimer = 0;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDraft, 700);
    }
    function saveDraft() {
      try {
        const data = strokes.map((s) => ({
          t: s.tool, c: s.color, z: Math.round(s.size * 10) / 10, s: s.seed,
          p: s.points.map((q) => [Math.round(q.x * 1e4) / 1e4, Math.round(q.y * 1e4) / 1e4]),
        }));
        // 限制資料量，避免 localStorage 爆掉
        const json = JSON.stringify(data);
        if (json.length < 400000) localStorage.setItem(SAVE_KEY, json);
      } catch { /* ignore */ }
    }
    function loadDraft() {
      try {
        const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (!Array.isArray(raw)) return;
        strokes = raw.slice(0, 200).map((d, i) => ({
          id: 'd' + i, tool: d.t, color: d.c, size: d.z, seed: d.s || i,
          points: (d.p || []).map((q) => ({ x: q[0], y: q[1] })),
        })).filter((s) => s.points.length);
      } catch { strokes = []; }
    }

    function toast(text) {
      // 借用工作區的 toast 容器，但它在隱藏的工作區裡，所以這裡自己做一個簡易提示
      let host = document.getElementById('demoToast');
      if (!host) {
        host = document.createElement('div');
        host.id = 'demoToast';
        host.className = 'demo-toast';
        paper.parentElement.appendChild(host);
      }
      host.textContent = text;
      host.classList.add('show');
      clearTimeout(host._t);
      host._t = setTimeout(() => host.classList.remove('show'), 2200);
    }

    pickTool('pen');
    loadDraft();
    // 等版面完成後才量測（剛載入時試玩區可能在畫面外、寬度量到 0）
    requestAnimationFrame(() => { if (!layout()) setTimeout(layout, 300); });
    // 捲動到試玩區時再確認一次尺寸
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) layout();
      }, { threshold: 0.1 }).observe(paper.parentElement || paper);
    }
    raf = requestAnimationFrame(frame);
    let t0 = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t0);
      t0 = setTimeout(layout, 150);
    });
    document.addEventListener('cp:studiohide', () => setTimeout(layout, 200));
    window.addEventListener('load', () => setTimeout(layout, 100));
    document.addEventListener('cp:langchange', () => {
      for (const b of $$('.demo-tool', toolsBox)) {
        const key = b.dataset.i18nTool;
        const label = b.querySelector('span');
        if (label && key) label.textContent = window.CP_I18N.t(key);
      }
    });
    // 避免顏色選單的預設白字
    void hasGold;
  }

  function init() {
    initHero();
    initDemo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
