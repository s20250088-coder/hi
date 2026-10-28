/* ================================================================
 * 彩紙屋 · 前端
 *   1. 工具函式             2. 狀態
 *   3. 色紙渲染（底色、紙紋、燙金/燙雷射邊、火花）
 *   4. 四種畫筆渲染器        5. 繪圖與互動
 *   6. WebSocket 連線        7. UI（面板、聊天室、夥伴、畫廊）
 *   8. 交換色紙              9. 啟動
 * ================================================================ */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* ============================================================
   * 1. 工具
   * ============================================================ */
  const STORE = {
    get(key, fb) {
      try {
        const raw = localStorage.getItem('cp:' + key);
        return raw == null ? fb : JSON.parse(raw);
      } catch { return fb; }
    },
    set(key, val) {
      try { localStorage.setItem('cp:' + key, JSON.stringify(val)); return true; } catch { return false; }
    },
    del(key) {
      try { localStorage.removeItem('cp:' + key); } catch { /* ignore */ }
    },
  };

  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };
  function mix(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function smoothPath(ctx, pts, closed = false) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) { ctx.lineTo(pts[0].x + 0.01, pts[0].y); return; }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    if (closed) ctx.closePath();
  }
  function polyline(ctx, pts, closed = false) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) ctx.closePath();
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function toast(text, opts = {}) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.gold ? ' gold' : '');
    el.textContent = text;
    wrap.appendChild(el);
    while (wrap.children.length > 3) wrap.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, opts.ms || 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  const initial = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

  /* ============================================================
   * 2. 狀態
   * ============================================================ */
  const PAPER_SIZES = {
    B4: { w: 720, h: 1000, label: 'B4' },
    A5: { w: 640, h: 900, label: 'A5' },
    SQ: { w: 820, h: 820, label: '方形' },
    B6: { w: 560, h: 790, label: 'B6' },
    WL: { w: 960, h: 600, label: '橫式' },
    L: { w: 520, h: 1040, label: '長條' },
    CD: { w: 720, h: 720, label: '卡片' },
  };

  const PAPERS = [
    { id: 'sakura', c1: '#fbd1d9', c2: '#f3a9b9', name: '櫻花粉' },
    { id: 'peach', c1: '#fde3cf', c2: '#f7c4a1', name: '蜜桃橘' },
    { id: 'lemon', c1: '#fdf0b5', c2: '#f4dc74', name: '月光黃' },
    { id: 'matcha', c1: '#ddebc8', c2: '#bcd5a0', name: '抹茶綠' },
    { id: 'mizu', c1: '#d4eaf4', c2: '#a9cfdf', name: '水色藍' },
    { id: 'lilac', c1: '#e5ddf5', c2: '#c9bbe8', name: '薰衣草' },
    { id: 'beige', c1: '#f6eedf', c2: '#e8d7bb', name: '米白' },
    { id: 'coral', c1: '#f9c0b4', c2: '#eb9688', name: '珊瑚' },
    { id: 'sage', c1: '#cfe0d6', c2: '#a9c4b5', name: '灰綠' },
    { id: 'sky', c1: '#cfe1f7', c2: '#a4c3e8', name: '晴空藍' },
    { id: 'rose', c1: '#f5c9cf', c2: '#e29aa6', name: '玫瑰' },
    { id: 'cream', c1: '#fbf4e4', c2: '#f0e2c6', name: '奶油' },
    { id: 'teal', c1: '#c3e3df', c2: '#8fc6bf', name: '薄荷' },
    { id: 'apricot', c1: '#fde2c0', c2: '#f6c083', name: '杏仁' },
    { id: 'graphite', c1: '#dfe1e6', c2: '#bfc4cd', name: '霧灰' },
    { id: 'night', c1: '#4d4f7a', c2: '#2f3154', name: '夜藍' },
    { id: 'ink', c1: '#3d3a42', c2: '#242229', name: '墨黑' },
    { id: 'moss', c1: '#cfd9bf', c2: '#a9b893', name: '苔綠' },
    { id: 'linen', c1: '#efe6d8', c2: '#dccdb8', name: '亞麻' },
    { id: 'lotus', c1: '#f4e3ef', c2: '#e3c3db', name: '藕粉' },
  ];

  // 站台設定：GitHub Pages 版由 scripts/build-pages.mjs 產生 app.config.js
  // apiBase    → 聯機 / 交換色紙用的雲端 WebSocket 伺服器（空字串 = 只有本機伺服器）
  // staticHost → 目前是純靜態空間（GitHub Pages），沒有 Node 後端
  const SITE = Object.assign({ apiBase: '', staticHost: false }, window.COLORPAPER_CONFIG || {});
  const HAS_BACKEND = !!SITE.apiBase || !SITE.staticHost;
  if (SITE.apiBase) SITE.staticHost = false;

  const TOOLS = {
    pencil: { label: '鉛筆', size: 3, alpha: 0.9, color: '#43413f' },
    watercolor: { label: '水彩', size: 18, alpha: 0.55, color: '#e8747c' },
    highlight: { label: '螢光筆', size: 22, alpha: 0.45, color: '#ffe045' },
    pen: { label: '原子筆', size: 2.4, alpha: 1, color: '#1d1c2b' },
    eraser: { label: '橡皮擦', size: 26, alpha: 1, color: '#ffffff' },
  };

  const SWATCHES = [
    '#1d1c2b', '#4a4a55', '#ffffff', '#e8747c', '#d24a5b', '#a8325a',
    '#f2a86f', '#e8c269', '#f5e07a', '#8fbf6a', '#2f8f7a', '#6fc3c9',
    '#4f86d9', '#2c4a9e', '#9a7be0', '#c9a7f0', '#8b5a3c', '#c67b5c',
  ];

  const QUICK_EMOJIS = ['😊', '😂', '✨', '🎉', '🎁', '💖', '🌸', '🔥', '👍', '😮', '🎨', '🖌️', '🦋', '⭐'];

  const state = {
    self: { id: uid('u'), name: '', color: '#9cc3f0' },
    tool: 'pen',
    color: '#1d1c2b',
    toolOpts: {
      pencil: { size: 3, alpha: 0.9 },
      watercolor: { size: 18, alpha: 0.55 },
      highlight: { size: 22, alpha: 0.45 },
      pen: { size: 2.4, alpha: 1 },
      eraser: { size: 26, alpha: 1 },
    },
    recent: [],
    paper: { preset: 'sakura', bg: '#fbd1d9', edge: 'gold', hue: 210, size: 'B4' },
    strokes: [],       // { id, tool, color, size, alpha, points: Float32Array, by }
    undone: [],        // 自己復原的筆畫，可重做
    pending: [],       // 離線時待送出的操作
    room: null,
    others: new Map(), // 遠端會員 id -> { id, name, color, strokeCount, online }
    peersOffline: new Map(), // 暫時斷線的成員
    othersCursor: new Map(),
    conn: { ws: null, status: 'offline', retries: 0, timer: null, rejoin: false },
    selection: { ids: null, start: null, moving: false, drag: false },
    incoming: new Map(), // 收到的交換請求
    exchangeTarget: null,
    sparks: [],
    render: { dpr: 1, W: 0, H: 0, pad: 0, pw: 0, ph: 0, rad: 0, live: 0 },
    dirty: false,
    pendingPaper: false,
    sparkDirty: true,
    lastPointer: null,
    t: 0,
  };

  const els = {};
  for (const id of [
    'paperGrid', 'edgeOptions', 'hueRow', 'edgeHue', 'hueOut', 'hueShiftBtn', 'progressBar', 'progressText',
    'undoBtn', 'redoBtn', 'clearBtn', 'roomChip', 'connDot', 'roomLabel', 'roomIdLabel', 'copyLinkBtn',
    'fitBtn', 'exchangeOpenBtn', 'saveBtn', 'themeBtn', 'themeLabel', 'createRoomBtn', 'canvasWrap', 'paperHost', 'paperCanvas', 'fxSoft', 'fxCanvas', 'inkCanvas',
    'cursorLayer', 'landing', 'landingNew', 'landingRoom', 'landingNote', 'selBar', 'toolGroup', 'swatches',
    'colorInput', 'colorWellFill', 'recentColors', 'sizeInput', 'sizeOut', 'alphaInput', 'alphaOut',
    'chatBadge', 'galleryBadge', 'roomCardTitle', 'roomCardDesc', 'roomForm', 'joinCodeInput', 'joinBtn',
    'roomActions', 'copyCodeBtn', 'leaveRoomBtn', 'roomShare', 'shareLinkInput', 'copyShareBtn',
    'peerCount', 'peopleList', 'incomingBox', 'incomingCount', 'incomingList', 'chatLog', 'chatEmpty',
    'chatForm', 'quickEmojis', 'chatInput', 'galleryDesc', 'galleryGrid', 'galleryEmpty', 'exchangeModal',
    'exchangePreview', 'exchangeMeta', 'exchangeSub', 'exchangePeople', 'exchangeHint', 'exchangeSendBtn',
    'joinModal', 'nickInput', 'joinCodeField', 'joinCodeInput2', 'joinError', 'joinConfirmBtn',
    'incomingModal', 'incomingTitle', 'incomingBody', 'acceptOfferedBtn', 'declineOfferedBtn', 'chatJoinBtn', 'twoPersonNote',
  ]) els[id] = document.getElementById(id);

  /* ============================================================
   * 3. 色紙渲染
   * ============================================================ */
  const paperCache = new Map();

  function paperOf(b) {
    return PAPERS.find((p) => p.id === b) || PAPERS[0];
  }

  /** 底色（含紙紋） */
  function getPaperFill(bg, W, H) {
    const key = `${bg}@${W}x${H}`;
    const hit = paperCache.get(key);
    if (hit) return hit;
    const canvas = makeCanvas(W, H);
    const c = canvas.getContext('2d');
    const preset = paperOf(bg);
    const base = new Path2D();
    base.rect(0, 0, W, H);
    c.clip(base);
    c.fillStyle = mix(preset.c2, preset.c1, 0.45);
    c.fillRect(0, 0, W, H);

    // 紙張的斑駁
    const rnd = mulberry32(hashStr(bg));
    const blob = makeCanvas(W / 4, H / 4);
    const bc = blob.getContext('2d');
    const bimg = bc.createImageData(blob.width, blob.height);
    for (let i = 0; i < bimg.data.length; i += 4) {
      const v = 0.5 + (rnd() - 0.5) * 0.6;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = 255;
      bimg.data[i + 3] = v * 26;
    }
    bc.putImageData(bimg, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(blob, 0, 0, W, H);

    // 大面積色暈
    for (let i = 0; i < 7; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const r = (0.25 + rnd() * 0.45) * Math.max(W, H);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const warm = rnd() > 0.5;
      g.addColorStop(0, warm ? 'rgba(255,255,255,0.10)' : 'rgba(120,70,60,0.05)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }

    // 纖維
    c.lineCap = 'round';
    const fibers = Math.round((W * H) / 1200);
    for (let i = 0; i < fibers; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const len = 3 + rnd() * 16;
      const a = rnd() * Math.PI * 2;
      const light = rnd() > 0.45;
      c.strokeStyle = light ? `rgba(255,255,255,${0.06 + rnd() * 0.12})` : `rgba(90,60,50,${0.03 + rnd() * 0.05})`;
      c.lineWidth = 0.5 + rnd() * 0.9;
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 4, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      c.stroke();
    }

    // 細密的布紋
    c.globalAlpha = 0.05;
    c.strokeStyle = '#5a3a32';
    c.lineWidth = 1;
    for (let x = 0; x < W; x += 7) {
      c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke();
    }
    for (let y = 0; y < H; y += 7) {
      c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke();
    }
    c.globalAlpha = 1;

    // 角落的光線
    const lg = c.createLinearGradient(0, 0, W, H);
    lg.addColorStop(0, 'rgba(255,255,255,0.20)');
    lg.addColorStop(0.35, 'rgba(255,255,255,0)');
    lg.addColorStop(0.8, 'rgba(0,0,0,0.04)');
    lg.addColorStop(1, 'rgba(0,0,0,0.10)');
    c.fillStyle = lg;
    c.fillRect(0, 0, W, H);

    paperCache.set(key, canvas);
    if (paperCache.size > 24) paperCache.delete(paperCache.keys().next().value);
    return canvas;
  }

  function getAtlas() {
    if (state.atlas) return state.atlas;
    const size = 128;
    const canvas = makeCanvas(size, size);
    const c = canvas.getContext('2d');
    const img = c.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size - 0.5;
        const dy = (y + 0.5) / size - 0.5;
        const d = clamp(Math.hypot(dx, dy) * 2, 0, 1);
        const a = Math.pow(1 - d, 1.3);
        const idx = (y * size + x) * 4;
        img.data[idx] = 255;
        img.data[idx + 1] = 255;
        img.data[idx + 2] = 255;
        img.data[idx + 3] = Math.round(a * 255);
      }
    }
    c.putImageData(img, 0, 0);
    state.atlas = canvas;
    return canvas;
  }

  function warmAtlas() {
    const a = getAtlas();
    const ctx = els.fxCanvas.getContext('2d');
    try { ctx.drawImage(a, -5000, -5000, 1, 1); } catch { /* ignore */ }
  }

  /** 雷射塗層（區域化色相，可做流光） */
  function laserPaint(c, rad) {
    if (!c._laser) {
      const s = 256;
      const canvas = makeCanvas(s, s);
      const x = canvas.getContext('2d');
      const img = x.createImageData(s, s);
      for (let py = 0; py < s; py++) {
        for (let px = 0; px < s; px++) {
          const u = px / s;
          const v = py / s;
          const h = (u * 300 + (v - 0.5) * 140 + Math.sin(u * 9.4 + v * 5.1) * 22 + Math.sin(v * 17.0 - u * 4.2) * 9 + 360) % 360;
          const [r, g, b] = hslToRgb(h, 0.95, 0.62);
          const idx = (py * s + px) * 4;
          img.data[idx] = r;
          img.data[idx + 1] = g;
          img.data[idx + 2] = b;
          img.data[idx + 3] = 255;
        }
      }
      x.putImageData(img, 0, 0);
      c._laser = canvas;
    }
    return c._laser;
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255].map(Math.round);
  }

  const edgeMotion = { x: 0, y: 0, dir: 0, speed: 0, lastInput: 0 };
  function tickEdgeMotion(dt) {
    if (!state.goldTime) state.goldTime = 0;
    state.goldTime += dt;
    const decay = Math.exp(-dt * 2.2);
    edgeMotion.dir += (edgeMotion.speed - edgeMotion.dir) * Math.min(1, dt * 6);
    edgeMotion.speed *= decay;
    edgeMotion.x += edgeMotion.dir * dt;
    edgeMotion.y += edgeMotion.dir * dt * 0.4;
  }

  /** 畫紙邊工藝（每幀） */
  function drawEdge(ctx, W, H, paper, rad, t, soft = false) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pad = getPad(rad);
    if (pad <= 0) { ctx.restore(); return; }

    const oi = rad + pad;
    const ring = new Path2D();
    buildRing(ring, W, H, pad, oi);

    // 紙張本身的落影（畫在內側）
    ctx.save();
    ctx.clip(new Path2D(`M${pad},${pad} h${W - 2 * pad} v${H - 2 * pad} h${-(W - 2 * pad)} Z`));
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = Math.max(2, pad * 0.35);
    ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
    ctx.restore();

    if (soft) {
      // 柔光層：只取亮部，讓燙金/雷射的光暈溢到紙外
      ctx.fillStyle = paper.edge === 'gold' ? 'rgba(255,214,120,0.95)' : `hsla(${(paper.hue + t * 20) % 360},95%,62%,0.9)`;
      ctx.fill(ring, 'evenodd');
      if (state.sparks.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (const sp of state.sparks) {
          const tw = Math.sin(t * sp.speed + sp.phase);
          if (tw <= 0.2) continue;
          ctx.globalAlpha = Math.pow(tw, 1.5) * 0.9;
          const g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, sp.size * 5);
          g.addColorStop(0, 'rgba(255,255,255,1)');
          g.addColorStop(1, 'rgba(255,200,90,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, sp.size * 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      return;
    }

    if (paper.edge === 'plain') {
      ctx.fillStyle = '#f7efe2';
      ctx.fill(ring, 'evenodd');
      // 壓凹的邊線
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = Math.max(1, rad * 0.012);
      ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(1, rad * 0.008);
      ctx.strokeRect(pad * 1.06, pad * 1.06, W - 2 * pad * 1.06, H - 2 * pad * 1.06);
      ctx.restore();
      return;
    }

    if (paper.edge === 'gold') {
      // 主體金屬
      const g = ctx.createLinearGradient(0, 0, Math.max(W, H) * 1.1, Math.max(W, H) * 0.8);
      const sh = Math.sin(t * 0.55) * 0.16 + edgeMotion.x * 0.012;
      g.addColorStop(clamp(0.0 + sh, 0, 1), '#fff6c8');
      g.addColorStop(clamp(0.16 + sh, 0, 1), '#f2d47a');
      g.addColorStop(clamp(0.3 + sh, 0, 1), '#a87c1f');
      g.addColorStop(clamp(0.42 + sh, 0, 1), '#e8c269');
      g.addColorStop(clamp(0.56 + sh, 0, 1), '#fffbe0');
      g.addColorStop(clamp(0.7 + sh, 0, 1), '#c9a227');
      g.addColorStop(clamp(0.84 + sh, 0, 1), '#8a6414');
      g.addColorStop(clamp(1.0 + sh, 0, 1), '#fff3c4');
      ctx.fillStyle = g;
      ctx.fill(ring, 'evenodd');
      // 細密的光澤條紋
      ctx.save();
      ctx.clip(ring, 'evenodd');
      ctx.globalCompositeOperation = 'overlay';
      for (let i = 0; i < 30; i++) {
        const o = ((i / 30) * 1.6 + t * 0.02 + edgeMotion.x * 0.004) % 1.6 - 0.2;
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.22)' : 'rgba(90,60,0,0.18)';
        ctx.save();
        ctx.translate(o * W * 1.4, o * H * 0.9);
        ctx.rotate(-0.5);
        ctx.fillRect(0, -H * 2, W * 0.02, H * 4);
        ctx.restore();
      }
      // 掃過的高光
      const sx = ((t * 0.09) % 1.3 - 0.15) * W;
      const sg = ctx.createLinearGradient(sx - W * 0.2, 0, sx + W * 0.2, H * 0.5);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      // 邊緣的高光與倒角
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,252,225,0.95)';
      ctx.lineWidth = Math.max(1, pad * 0.08);
      roundRectStroke(ctx, pad * 0.6, pad * 0.6, W - pad * 1.2, H - pad * 1.2, oi * 0.85);
      ctx.strokeStyle = 'rgba(90,60,10,0.55)';
      ctx.lineWidth = Math.max(1, pad * 0.06);
      ctx.stroke(outerInnerPath(pad, W, H, rad));
      // 壓入紙面的金色細線
      ctx.strokeStyle = 'rgba(255,230,160,0.85)';
      ctx.lineWidth = Math.max(1, rad * 0.01);
      const inset = pad * 0.32;
      roundRectStroke(ctx, pad + inset, pad + inset, W - 2 * (pad + inset), H - 2 * (pad + inset), Math.max(2, rad * 0.75 - inset));
    } else {
      /* ---- 燙雷射 ---- */
      const hue = paper.hue || 210;
      const laser = laserPaint(ctx, rad);
      ctx.save();
      ctx.clip(ring, 'evenodd');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#2a2431';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      // 雷射紙的區域色相反射
      ctx.filter = `hue-rotate(${hue + Math.sin(t * 0.35) * 22 + Math.sin(t * 0.11 + 1) * 14}deg) saturate(2) brightness(1.08)`;
      for (const [ox, oy, sc] of [[0, 0, 1], [0, 0, 0.5], [0.3, 0.5, 0.33]]) {
        ctx.globalAlpha = sc === 1 ? 0.62 : 0.5;
        ctx.drawImage(laser, ox * W, oy * H, W, H);
      }
      // 流動的糖紙光條
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.translate(edgeMotion.x * 0.6, edgeMotion.y * 0.4);
      for (let i = 0; i < 9; i++) {
        const c0 = hslToRgb((hue + i * 40 + t * 14 + edgeMotion.x * 0.25) % 360, 0.95, 0.55).join(',');
        const x0 = ((i / 9) * 1.8 + ((t * 0.05) % 1) - 0.4) * W - edgeMotion.x;
        ctx.fillStyle = `rgba(${c0},0.55)`;
        ctx.save();
        ctx.translate(x0, 0);
        ctx.rotate(0.65);
        ctx.fillRect(-W * 0.08, -H * 2, W * 0.16, H * 4);
        ctx.restore();
      }
      // 白色耀眼的閃光帶
      ctx.globalCompositeOperation = 'screen';
      const count = 5;
      for (let i = 0; i < count; i++) {
        const p = ((i / count) + t * 0.05) % 1;
        const x0 = (p * 1.6 - 0.3) * W;
        const grd = ctx.createLinearGradient(x0, 0, x0 + W * 0.18, H * 0.12);
        grd.addColorStop(0, 'rgba(255,255,255,0)');
        grd.addColorStop(0.5, 'rgba(255,255,255,0.28)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);
      }
      // 顆粒
      if (!ctx._grain) {
        const gr = makeCanvas(128, 128);
        const gc = gr.getContext('2d');
        const img = gc.createImageData(128, 128);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.random();
          img.data[i] = img.data[i + 1] = 255;
          img.data[i + 3] = v > 0.82 ? 70 : 0;
        }
        gc.putImageData(img, 0, 0);
        ctx._grain = gr;
      }
      ctx.globalAlpha = 0.8;
      const pat = ctx.createPattern(ctx._grain, 'repeat');
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 內外邊緣的細亮線
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, pad * 0.07);
      roundRectStroke(ctx, pad * 0.6, pad * 0.6, W - pad * 1.2, H - pad * 1.2, oi * 0.85);
      ctx.strokeStyle = 'rgba(20,10,30,0.5)';
      ctx.lineWidth = Math.max(1, pad * 0.06);
      ctx.stroke(outerInnerPath(pad, W, H, rad));
    }

    // 閃爍的火花：金箔碎屑 / 雷射亮片
    const n = state.sparks.length;
    if (n) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const sp = state.sparks[i];
        const tw = Math.sin(t * sp.speed + sp.phase);
        if (tw <= 0.15) continue;
        const a = Math.pow(tw, 1.6) * sp.intensity;
        const s = sp.size * (0.35 + tw * 1.2);
        ctx.globalAlpha = a;
        if (paper.edge === 'gold') {
          // 四芒星
          ctx.save();
          ctx.translate(sp.x, sp.y);
          ctx.fillStyle = 'rgba(255,250,220,1)';
          ctx.beginPath();
          ctx.moveTo(0, -s * 2.2);
          ctx.quadraticCurveTo(0, 0, s * 2.2, 0);
          ctx.quadraticCurveTo(0, 0, 0, s * 2.2);
          ctx.quadraticCurveTo(0, 0, -s * 2.2, 0);
          ctx.quadraticCurveTo(0, 0, 0, -s * 2.2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,214,120,0.55)';
          ctx.beginPath();
          ctx.arc(0, 0, s * 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = `hsla(${(sp.hue + t * 40) % 360},100%,80%,1)`;
          ctx.save();
          ctx.translate(sp.x, sp.y);
          ctx.rotate(sp.phase + t * 0.4);
          ctx.fillRect(-s, -s, s * 2, s * 2);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill(ring, 'evenodd');
    ctx.globalCompositeOperation = 'source-over';
  }

  function buildRing(p, W, H, pad, rOuter) {
    const rIn = Math.max(0, rOuter - pad * 0.6);
    // 外圈（順時針）
    p.moveTo(rOuter, 0);
    p.lineTo(W - rOuter, 0);
    p.arcTo(W, 0, W, rOuter, rOuter);
    p.lineTo(W, H - rOuter);
    p.arcTo(W, H, W - rOuter, H, rOuter);
    p.lineTo(rOuter, H);
    p.arcTo(0, H, 0, H - rOuter, rOuter);
    p.lineTo(0, rOuter);
    p.arcTo(0, 0, rOuter, 0, rOuter);
    p.closePath();
    // 內圈（反向，形成鏤空）
    const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad;
    p.moveTo(x0 + rIn, y0);
    p.arcTo(x0, y0, x0, y0 + rIn, rIn);
    p.lineTo(x0, y1 - rIn);
    p.arcTo(x0, y1, x0 + rIn, y1, rIn);
    p.lineTo(x1 - rIn, y1);
    p.arcTo(x1, y1, x1, y1 - rIn, rIn);
    p.lineTo(x1, y0 + rIn);
    p.arcTo(x1, y0, x1 - rIn, y0, rIn);
    p.closePath();
  }
  function roundRectStroke(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.max(0, r));
    ctx.stroke();
  }
  function outerInnerPath(pad, W, H, rad) {
    const p = new Path2D();
    p.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, Math.max(0, rad * 0.9 - pad * 0.6));
    // 注意：因為要「描線」而不是填充，這裡不能加外圈，否則會一起被描到
    return p;
  }

  function getPad(rad) {
    return Math.max(8, Math.round(rad * 0.13));
  }

  /** 產生邊緣火花 */
  function buildSparks(W, H, paper, rad) {
    if (paper.edge === 'plain') { state.sparks = []; return; }
    const pad = getPad(rad);
    const rnd = mulberry32(hashStr(paper.bg + paper.edge) + 7);
    const inner = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad, r: Math.max(0, rad - pad * 0.6) };
    const gold = paper.edge === 'gold';
    const total = Math.round(clamp((W + H) / 22, 24, 110));
    const arr = [];
    for (let i = 0; i < total; i++) {
      const side = Math.floor(rnd() * 4);
      const along = rnd();
      let x, y;
      const inset = pad * (0.25 + rnd() * 0.5);
      if (side === 0) { x = inset + along * (W - inset * 2); y = inset; }
      else if (side === 1) { x = W - inset; y = inset + along * (H - inset * 2); }
      else if (side === 2) { x = inset + along * (W - inset * 2); y = H - inset; }
      else { x = inset; y = inset + along * (H - inset * 2); }
      arr.push({
        x, y,
        size: (gold ? 1.6 : 1.8) + rnd() * (gold ? 2.6 : 2.2),
        phase: rnd() * Math.PI * 2,
        speed: 0.6 + rnd() * 2.4,
        intensity: gold ? 0.55 + rnd() * 0.45 : 0.45 + rnd() * 0.55,
        hue: rnd() * 360,
      });
    }
    state.sparks = arr;
  }

  /* ============================================================
   * 4. 畫筆渲染器
   * ============================================================ */
  const liveBuf = new Map();
  const texCache = new Map();
  const strokeCanvas = makeCanvas(10, 10);
  const strokeCtx = strokeCanvas.getContext('2d');

  function getGrainTex(seed) {
    const key = hashStr(seed) % 12;
    if (texCache.has(key)) return texCache.get(key);
    const t = makeCanvas(256, 256);
    const c = t.getContext('2d');
    const rnd = mulberry32(key * 7919 + 13);
    const img = c.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 255 * (0.35 + 0.65 * Math.pow(rnd(), 1.3));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v;
    }
    c.putImageData(img, 0, 0);
    texCache.set(key, t);
    return t;
  }

  function setupCtx(c, lw) {
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = lw;
  }

  /** 水中流動：切線數值梯度 */
  function normalAt(pts, i) {
    if (!pts || !pts.length) return [0, 1];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    if (!a || !b) return [0, 1];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return [0, 1];
    return [-dy / len, dx / len];
  }

  /**
   * 核心：把一筆畫到 ctx
   * opt: { wobble, grain, halo, dotThresh, wet, taper, buildAlpha }
   */
  function paintStroke(ctx, pts, tool, color, size, alpha, seed, opt = {}) {
    if (!Array.isArray(pts)) pts = [];
    // 保險：任何非有限座標都會讓 canvas 的漸層直接丟例外，先把壞點濾掉
    pts = pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!Number.isFinite(size) || size <= 0) size = 2;
    if (!Number.isFinite(alpha)) alpha = 1;
    const n = pts.length;
    if (!n) return;
    const rnd = mulberry32(seed);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const lw = Math.max(0.6, size);
    ctx.save();
    // 防禦：重設裁切區與濾鏡，避免先前哪一筆漏了 restore 就讓之後的筆跡整片消失
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.clip();
    ctx.filter = 'none';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;

    if (tool === 'highlight') {
      // 螢光筆：像麥克筆一樣把紙上的顏色壓亮，邊緣微微加深
      const [r, g, b] = hexToRgb(color);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw * 1.02;
      ctx.globalAlpha = alpha * 0.9;
      const path = new Path2D();
      if (n < 3) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.35;
        ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
        ctx.lineWidth = Math.max(1, lw * 0.06);
        ctx.stroke();
      } else {
        smoothPath(path, pts);
        ctx.stroke(path);
        // 起收筆的圓頭
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
        ctx.arc(pts[n - 1].x, pts[n - 1].y, lw / 2, 0, Math.PI * 2);
        ctx.fill();
        // 疊筆處的深色邊
        ctx.globalAlpha = alpha * 0.3;
        ctx.strokeStyle = mix(color, '#7a5a00', 0.55);
        ctx.lineWidth = Math.max(1, lw * 0.05);
        ctx.stroke(path);
      }
      ctx.restore();
      return;
    }

    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = lw;
      if (n < 3) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    /* --- 水彩 --- */
    if (tool === 'watercolor') {
      let total = 0;
      for (let i = 1; i < n; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const grain = getGrainTex('wc' + seed);
      const core = mix(color, '#ffffff', 0.18);
      const deep = mix(color, '#3a2a26', 0.35);

      // 1. 水在紙上先把顏色暈開
      ctx.filter = `blur(${Math.max(1.5, lw * 0.11)}px)`;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw * 1.02;
      ctx.globalAlpha = alpha * 0.8;
      if (n < 3) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lw * 0.62, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.stroke();
      }
      ctx.filter = 'none';

      // 2. 筆身 + 紙紋
      ctx.globalAlpha = alpha * 0.62;
      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      if (n >= 3) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = ctx.createPattern(grain, 'repeat');
      if (n >= 3) ctx.stroke();

      // 3. 又乾又濕的筆觸
      ctx.lineCap = 'butt';
      const stride = Math.max(2, Math.round(n / 90));
      ctx.lineCap = 'round';
      for (let l = 0; l < 2; l++) {
        const side = l === 1 ? -1 : 1;
        const offset = lw * (l === 0 ? 0.22 : 0.3);
        ctx.globalAlpha = alpha * 0.12;
        ctx.strokeStyle = l === 1 ? deep : core;
        ctx.lineWidth = lw * 0.16;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i += stride) {
          const [tx, ty] = normalAt(pts, i);
          const wob = Math.sin(i * 0.07 + l * 2.1) * lw * 0.06;
          const x = pts[i].x + tx * (side * offset + wob);
          const y = pts[i].y + ty * (side * offset + wob);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.lineCap = 'round';

      // 4. 邊緣積水
      ctx.globalAlpha = alpha * 0.3;
      ctx.strokeStyle = mix(color, '#2e2220', 0.4);
      ctx.lineWidth = Math.max(0.8, lw * 0.06);
      if (n >= 3) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      if (n < 3) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lw * 0.56, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 5. 水漬與斑點
      const [cr, cg, cb] = hexToRgb(color);
      const blots = clamp(Math.round(total / Math.max(6, lw * 0.8)), 1, 30);
      ctx.lineCap = 'round';
      for (let i = 0; i < blots; i++) {
        const p = pts[Math.floor(rnd() * n)];
        if (!p) continue;
        const [tx, ty] = normalAt(pts, Math.floor(rnd() * n));
        const rr = lw * (0.09 + rnd() * 0.3);
        const dist = rnd() * lw * 0.7;
        const a = rnd() * Math.PI * 2;
        const x = p.x + Math.cos(a) * dist + tx * (rnd() - 0.5) * lw * 0.35;
        const y = p.y + Math.sin(a) * dist + ty * (rnd() - 0.5) * lw * 0.35;
        if (rnd() > 0.55) {
          const g2 = ctx.createRadialGradient(x, y, 0, x, y, rr);
          g2.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha * 0.2})`);
          g2.addColorStop(0.65, `rgba(${cr},${cg},${cb},${alpha * 0.1})`);
          g2.addColorStop(0.82, `rgba(${cr},${cg},${cb},${alpha * 0.16})`);
          g2.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          ctx.globalAlpha = 1;
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fill();
        } else if (total > lw * 3 && rr > lw * 0.14) {
          // 邊緣的小水珠：半透明的圓點，不要細線（細線會被誤看成刮痕）
          ctx.globalAlpha = alpha * (0.25 + rnd() * 0.3);
          ctx.fillStyle = mix(color, '#3a2a26', 0.2);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.6, rr * 0.28), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      return;
    }

    /* --- 鉛筆 --- */
    if (tool === 'pencil') {
      const grain = getGrainTex('p' + seed);
      // 石墨粉末
      ctx.filter = `blur(${Math.max(0.4, lw * 0.09)}px)`;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.18;
      ctx.globalAlpha = alpha * 0.32;
      if (n >= 2) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      ctx.filter = 'none';
      // 注意：createPattern 會把當下的 filter 烘進圖樣，所以一定要在濾鏡重設後才建立
      ctx.strokeStyle = ctx.createPattern(grain, 'repeat');
      ctx.globalAlpha = alpha * 0.9;
      ctx.lineWidth = lw;
      if (n >= 2) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * 0.85;
      ctx.lineWidth = lw * 0.92;
      if (n >= 2) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      // 石墨顆粒起伏
      ctx.lineCap = 'butt';
      ctx.strokeStyle = color;
      const stride = Math.max(1, Math.round(lw / 3));
      for (let i = 0; i + stride < n; i += stride) {
        const a = pts[i];
        const b = pts[i + stride];
        const [tx, ty] = normalAt(pts, i);
        const off = (rnd() - 0.5) * lw * 0.95;
        ctx.globalAlpha = alpha * (0.12 + rnd() * 0.3);
        ctx.lineWidth = Math.max(0.35, lw * (0.12 + rnd() * 0.18));
        ctx.beginPath();
        ctx.moveTo(a.x + tx * off, a.y + ty * off);
        ctx.lineTo(b.x + tx * off, b.y + ty * off);
        ctx.stroke();
      }
      // 重壓處
      ctx.lineCap = 'round';
      ctx.strokeStyle = mix(color, '#000000', 0.3);
      ctx.globalAlpha = alpha * 0.16;
      ctx.lineWidth = Math.max(0.5, lw * 0.2);
      const stride2 = Math.max(2, Math.round(lw * 2));
      for (let i = 0; i + stride2 < n; i += stride2) {
        const a = pts[i];
        const b = pts[i + stride2];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    /* --- 原子筆 --- */
    const mainPath = new Path2D();
    if (n < 3) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      return;
    }
    const ink = new Path2D();
    // 帶著一點點不規則
    const jit = Math.max(0.1, lw * 0.04);
    const pts2 = pts.map((p, i) => {
      if (i === 0 || i === n - 1) return p;
      return { x: p.x + (rnd() - 0.5) * jit, y: p.y + (rnd() - 0.5) * jit };
    });
    smoothPath(ink, pts2);
    // 墨跡暈在紙上的外圈
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * 0.16;
    ctx.lineWidth = lw * 1.55;
    ctx.stroke(ink);
    // 筆身
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.stroke(ink);
    // 筆尖方向造成的雙線感
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = mix(color, '#000000', 0.2);
    ctx.lineWidth = Math.max(0.4, lw * 0.3);
    ctx.save();
    ctx.translate(lw * 0.22, lw * 0.18);
    ctx.stroke(ink);
    ctx.restore();
    // 起筆的小墨點
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, lw * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ============================================================
   * 5. 繪圖
   * ============================================================ */
  let ctxPaper, ctxSoft, ctxFx, ctxInk;

  function sizeLayer(canvas, W, H, dpr) {
    canvas.width = W;
    canvas.height = H;
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }

  function layout() {
    const size = PAPER_SIZES[state.paper.size] || PAPER_SIZES.B4;
    els.paperHost.style.setProperty('--ar', (size.w / size.h).toFixed(4));
    // 先把紙張宿主縮成 1px，CSS 的 aspect-ratio / max-height 才不會把畫布容器「撐大」，
    // 否則在窄視窗裡量到的空間會一直縮小（回饋迴路）。
    els.paperHost.style.width = '1px';
    els.paperHost.style.height = '1px';
    const box = els.canvasWrap.getBoundingClientRect();
    const availW = Math.max(200, box.width - 44);
    const availH = Math.max(200, box.height - 20);
    let w = availW;
    let h = w * (size.h / size.w);
    if (h > availH) { h = availH; w = h * (size.w / size.h); }
    // 畫布解析度：至少 2 倍（純色紙縮放時線條才不會糊成一片）
    const dpr = clamp(Math.max(window.devicePixelRatio || 1, 2), 1, 3);
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    els.paperHost.style.width = Math.round(w) + 'px';
    els.paperHost.style.height = Math.round(h) + 'px';
    els.paperHost.style.aspectRatio = 'auto';

    const rad = Math.max(10, Math.round(W * 0.035));
    state.render = { dpr, W, H, rad, pad: getPad(rad), cssW: w, cssH: h, live: state.render.live };
    ctxPaper = sizeLayer(els.paperCanvas, W, H, dpr);
    ctxSoft = sizeLayer(els.fxSoft, W, H, dpr);
    ctxFx = sizeLayer(els.fxCanvas, W, H, dpr);
    ctxInk = sizeLayer(els.inkCanvas, W, H, dpr);
    buildSparks(W, H, state.paper, rad);
    renderPaper();
    renderInk();
    state.sparkDirty = true;
  }

  function renderPaper() {
    if (!ctxPaper) return;
    const { W, H, rad } = state.render;
    ctxPaper.clearRect(0, 0, W, H);
    ctxPaper.save();
    ctxPaper.beginPath();
    ctxPaper.roundRect(state.render.pad, state.render.pad, W - 2 * state.render.pad, H - 2 * state.render.pad, Math.max(0, rad * 0.9 - state.render.pad * 0.6));
    ctxPaper.clip();
    ctxPaper.drawImage(getPaperFill(state.paper.bg, W, H), 0, 0, W, H);
    // 紙張邊緣的陰影，讓紙面有一點厚度
    const pad = state.render.pad;
    const vig = ctxPaper.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.07)');
    ctxPaper.fillStyle = vig;
    ctxPaper.fillRect(0, 0, W, H);
    ctxPaper.strokeStyle = 'rgba(255,255,255,0.55)';
    ctxPaper.lineWidth = Math.max(1, pad * 0.3);
    ctxPaper.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
    ctxPaper.restore();
    state.pendingPaper = true;
  }

  /** 把正規化座標（0~1）的筆畫實際畫到墨跡圖層上；例外：用來找問題的除錯開關 */
  function paintStrokesToInk(exceptLive) {
    for (const st of state.strokes) {
      const { cssW, cssH } = state.render;
      const px = st.points.map((p) => ({ x: p.x * cssW, y: p.y * cssH }));
      paintStroke(ctxInk, px, st.tool, st.color, st.size, st.alpha, strokeSeed(st.id));
    }
    for (const l2 of liveBuf.values()) if (l2 !== exceptLive) paintLive(l2);
  }

  /** 主渲染：清空後把所有筆畫重畫一次 */
  function renderInk() {
    if (!ctxInk) return;
    // 用「絕對值」設定轉換，不要依賴 save/restore 的相對狀態
    ctxInk.setTransform(1, 0, 0, 1, 0, 0);
    ctxInk.clearRect(0, 0, ctxInk.canvas.width, ctxInk.canvas.height);
    ctxInk.setTransform(state.render.dpr, 0, 0, state.render.dpr, 0, 0);
    paintStrokesToInk(null);
    ctxInk.setTransform(state.render.dpr, 0, 0, state.render.dpr, 0, 0);
    state.dirty = false;
  }

  /** 橡皮擦的即時筆跡畫在 fx 圖層上 */
  function drawErasePreview() {
    const { W, H } = state.render;
    ctxFx.save();
    ctxFx.setTransform(state.render.dpr, 0, 0, state.render.dpr, 0, 0);
    ctxFx.globalCompositeOperation = 'source-over';
    ctxFx.fillStyle = 'rgba(255,255,255,0.42)';
    ctxFx.beginPath();
    for (const live of liveBuf.values()) {
      const pts = live.pts;
      if (pts.length < 3) {
        const p = pts[0];
        if (p) ctxFx.arc(p.x, p.y, live.size / 2, 0, Math.PI * 2);
      } else polyline(ctxFx, pts);
    }
    ctxFx.fill();
    ctxFx.restore();
  }

  function clearFxLive() {
    renderFx(state.t);
  }

  function paintLive(live) {
    const pts = live.pts;
    if (!pts.length || live.tool === 'eraser') return;
    const { dpr } = state.render;
    const n = pts.length;
    const from = Math.max(0, live.painted - 2);
    // 短的筆畫整筆重畫（紋理一致），長的筆畫只畫新增段落（流暢）
    if (n <= 90) {
      // 短的筆畫整筆重畫（全部在 CSS 像素座標系）
      ctxInk.setTransform(1, 0, 0, 1, 0, 0);
      ctxInk.clearRect(0, 0, ctxInk.canvas.width, ctxInk.canvas.height);
      ctxInk.setTransform(state.render.dpr, 0, 0, state.render.dpr, 0, 0);
      paintStrokesToInk(live);
      paintStroke(ctxInk, pts, live.tool, live.color, live.size, live.alpha, strokeSeed(live.id));
    } else {
      paintStroke(ctxInk, pts.slice(from), live.tool, live.color, live.size, live.alpha, strokeSeed(live.id) + from);
    }
    live.painted = n;
  }

  const seedMap = new Map();
  function strokeSeed(id) {
    if (typeof id !== 'string' || !id) return Math.floor(Math.random() * 1e6);
    let v = seedMap.get(id);
    if (v === undefined) {
      v = hashStr(id);
      seedMap.set(id, v);
      if (seedMap.size > 5000) seedMap.clear();
    }
    return v;
  }

  /** 邊框動畫（只重畫 fx 圖層） */
  function renderFx(t) {
    if (!ctxFx) return;
    const { W, H, rad } = state.render;
    drawEdge(ctxFx, W, H, state.paper, rad, t, false);
    drawEdge(ctxSoft, W, H, state.paper, rad, t, true);
    if (draw.active && draw.tool === 'eraser') drawErasePreview();
    state.sparkDirty = false;
  }

  let lastFrame = 0;
  function frame(now) {
    if (document.hidden) { state.rafRunning = false; return; }
    const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
    lastFrame = now;
    state.t += dt;
    tickEdgeMotion(dt);
    renderFx(state.t);
    if (state.dirty) renderInk();
    if (draw.active && draw.tool === 'eraser') drawErasePreview();
    updateRemoteCursors();
    requestAnimationFrame(frame);
    // 隱藏的頁籤 / 列印時停止動畫，避免佔用 CPU；回到前景時自動繼續
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.rafRunning) {
        state.rafRunning = true;
        lastFrame = 0;
        requestAnimationFrame(frame);
        renderPaper();
        renderInk();
      }
    });
  }

  /* ---- 座標轉換 ---- */
  function toNorm(e) {
    const r = els.inkCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function elAt(e) {
    return document.elementFromPoint(e.clientX, e.clientY) || e.target;
  }

  /* ---- 繪圖事件 ---- */
  const draw = { active: false, stroke: null, last: null, lastTs: 0, pointerId: null };

  function currentStyle() {
    const opts = state.toolOpts[state.tool];
    return { size: opts.size, alpha: opts.alpha };
  }

  function startStroke(p) {
    if (p.x < -0.02 || p.y < -0.02 || p.x > 1.02 || p.y > 1.02) return;
    const style = currentStyle();
    // 筆寬以「CSS 像素」為單位存進筆畫（不同螢幕大小 / 解析度看到的大小一致）
    const cssSize = Math.max(0.6, Math.round(style.size * 4) / 4);
    setEdgeMotion(p);
    if (state.tool === 'eraser') {
      draw.active = true;
      draw.tool = 'eraser';
      draw.erased = [];
      draw.last = p;
      draw.stroke = { id: uid('e'), tool: 'eraser', pts: [{ x: p.x * state.render.cssW, y: p.y * state.render.cssH }], size: cssSize, painted: 0 };
      liveBuf.set(draw.stroke.id, draw.stroke);
      state.dirty = true;
      eraseHits(p);
      return;
    }
    const stroke = {
      id: uid('s'),
      tool: state.tool,
      color: state.color,
      size: cssSize,
      alpha: style.alpha,
      points: [p],
      by: state.self.id,
      last: p,
      lastTs: performance.now(),
    };
    // 進行中的筆畫先放在 liveBuf，放開後才正式加入（避免同一筆被畫兩次）
    liveBuf.set(stroke.id, {
      id: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, alpha: stroke.alpha,
      pts: stroke.points.map((q) => ({ x: q.x * state.render.cssW, y: q.y * state.render.cssH })),
      painted: 0, isStroke: true,
    });
    draw.active = true;
    draw.stroke = stroke;
    draw.last = p;
    draw.lastTs = stroke.lastTs;
    hideSelection();
    updateProgress();
  }

  function addPoint(p) {
    const stroke = draw.stroke;
    const W = state.render.cssW;
    const H = state.render.cssH;
    if (draw.tool === 'eraser') {
      const lx = p.x * W;
      const ly = p.y * H;
      const last = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(lx - last.x, ly - last.y) > stroke.size * 0.15) stroke.pts.push({ x: lx, y: ly });
      state.dirty = true;
      eraseHits(p);
      return;
    }
    const lp = stroke.points[stroke.points.length - 1];
    if (Math.abs(lp.x - p.x) * W < 0.6 && Math.abs(lp.y - p.y) * H < 0.6) return;
    stroke.points.push(p);
    stroke.last = p;
    const live = liveBuf.get(stroke.id);
    if (live) live.pts.push({ x: p.x * W, y: p.y * H });
    state.dirty = true;
  }

  function eraseHits(p) {
    const r = draw.stroke ? draw.stroke.size / 2 : currentStyle().size / 2;
    const hit = [];
    for (const s of state.strokes) {
      if (draw.erased.includes(s.id)) continue;
      const pts = s.points;
      // s.size 是 CSS 像素，這裡換算成和 p 相同的正規化單位
      const reach = r + (s.size / 2) / Math.max(64, state.render.cssW) + 0.004;
      for (let i = 0; i < pts.length; i++) {
        if (Math.abs(pts[i].x - p.x) < reach && Math.abs(pts[i].y - p.y) < reach) {
          if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) <= reach) { hit.push(s.id); break; }
        }
      }
    }
    if (!hit.length) return;
    hit.forEach((id) => draw.erased.push(id));
    state.strokes = state.strokes.filter((s) => !hit.includes(s.id));
    updateProgress();
  }

  function endStroke() {
    if (!draw.active) return;
    const stroke = draw.stroke;
    draw.active = false;
    draw.stroke = null;

    if (draw.tool === 'eraser') {
      liveBuf.delete(stroke.id);
      clearFxLive();
      const ids = draw.erased || [];
      draw.erased = null;
      state.dirty = true;
      if (!ids.length) return;
      if (state.conn.status === 'online' && state.room) {
        wsSend('erase', { ids });
      } else {
        state.pending.push({ t: 'erase', body: { ids } });
      }
      return;
    }

    const s = stroke;
    const live = liveBuf.get(s.id);
    liveBuf.delete(s.id);
    const pts = s.points;
    if (pts.length === 1) { pts.push({ x: pts[0].x + 0.0004, y: pts[0].y + 0.0004 }); if (live) live.pts.push({ x: pts[1].x * state.render.cssW, y: pts[1].y * state.render.cssH }); }
    state.strokes.push(s);
    s.last = undefined;
    s.lastTs = undefined;
    state.undone = [];
    state.dirty = true;
    if (state.conn.status === 'online' && state.room) {
      wsSend('stroke', { stroke: serializeStroke(s) });
    } else {
      state.pending.push({ t: 'stroke', body: { stroke: serializeStroke(s) } });
    }
    updateUndoButtons();
  }

  function serializeStroke(s) {
    const flat = [];
    for (const p of s.points) flat.push(Math.round(p.x * 1e5) / 1e5, Math.round(p.y * 1e5) / 1e5);
    return {
      id: s.id, tool: s.tool, color: s.color, size: s.size, alpha: s.alpha,
      points: flat, by: state.self.id, paperW: Math.round(state.render.cssW || 534),
    };
  }

  function normalizeSize(size) {
    // 舊版客戶端把筆寬存成「紙張寬度的比例」，新版是 CSS 像素；用大小區分並轉換
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0) return 3;
    if (n < 1) return Math.max(0.6, n * Math.max(64, state.render.cssW || 720));
    return n;
  }

  /** 遠端筆寬以送出者的紙張寬度為基準，換算成自己畫面上的像素，兩邊看到的大小才一致 */
  function remoteSize(size, paperW) {
    const n = normalizeSize(size);
    const base = Number(paperW) > 0 ? Math.min(4000, Number(paperW)) : 534;
    const mine = state.render.cssW || 534;
    return Math.max(0.4, Math.min(120, n * (mine / base)));
  }

  function deserializeStroke(s) {
    const flat = Array.isArray(s.points) ? s.points : [];
    const points = new Float32Array(flat.length);
    for (let i = 0; i < flat.length; i++) points[i] = flat[i];
    return {
      id: s.id || uid('r'), tool: s.tool, color: s.color, size: normalizeSize(s.size), alpha: s.alpha,
      points: ptsArrayToObjs(points), by: s.by || '', paperW: s.paperW || 0,
    };
  }
  function ptsArrayToObjs(flat) {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
    return out;
  }

  function setEdgeMotion(p) {
    const last = state.lastPointer;
    state.lastPointer = p;
    if (!last) return;
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    const dir = Math.sign(p.x - last.x) || Math.sign(p.y - last.y);
    edgeMotion.speed = Math.min(edgeMotion.speed + d * 900, 120);
    if (dir !== 0) edgeMotion.dir = edgeMotion.speed * Math.sign(dir);
  }

  /** 指標捕捉：部分環境（合成事件、舊瀏覽器）會丟錯，不能讓它中斷繪圖 */
  function capturePointer(el, id) {
    try { el.setPointerCapture(id); return true; } catch { return false; }
  }

  function bindDrawing() {
    const ink = els.inkCanvas;
    ink.addEventListener('pointerdown', (e) => {
      // PointerEvent 預設的 button 是 -1（代表「沒有按鍵」），所以先套用預設值再比對
      const btn = e.button ?? 0;
      if (btn !== 0 && e.pointerType === 'mouse') return;
      if (state.selection.ids) {
        if (state.selection.moving && elAt(e) !== ink) return; // 交給搬移處理
        hideSelection();
        if (elAt(e) !== ink) return;
      }
      e.preventDefault();
      hideLanding();
      capturePointer(ink, e.pointerId);
      draw.pointerId = e.pointerId;
      const p = toNorm(e);
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') ensureSizeForTouch();
      startStroke(p);
      sendCursor(p, true);
    });

    const move = (e) => {
      const p = toNorm(e);
      if (!draw.active) {
        setEdgeMotion(p);
        state.lastPointer = p;
        sendCursor(p, false);
        return;
      }
      if (draw.pointerId !== e.pointerId) return;
      // 只有「真的由瀏覽器產生的同一個指標」才展開合併事件；合成事件沒有座標，不能用
      let events = [e];
      if (e.getCoalescedEvents && e.isTrusted) {
        try {
          const list = e.getCoalescedEvents();
          if (list && list.length) events = list;
        } catch { /* 忽略 */ }
      }
      for (const ev of events) addPoint(toNorm(ev));
      setEdgeMotion(p);
      sendCursor(p, false);
    };
    ink.addEventListener('pointermove', move);
    window.addEventListener('pointermove', (e) => {
      if (e.target === ink) return;
      if (state.lastPointer) sendCursor(toNorm(e), false);
    });

    const up = (e) => {
      if (draw.pointerId !== e.pointerId || !draw.active) return;
      endStroke();
      draw.pointerId = null;
    };
    ink.addEventListener('pointerup', up);
    ink.addEventListener('pointercancel', up);
    ink.addEventListener('pointerleave', () => {
      if (!draw.active) sendCursor(null, false);
    });

    // 阻止手機上畫圖時捲動頁面
    ink.addEventListener('touchstart', (e) => { if (state.tool !== 'eraser') e.preventDefault(); }, { passive: false });
  }

  function ensureSizeForTouch() {
    // 手指繪圖時稍微加粗，比較好畫
    const o = state.toolOpts[state.tool];
    if (!state._touchSized) o.size = Math.min(40, Math.round(o.size * 1.6));
    state._touchSized = true;
  }

  /* ============================================================
   * 6. WebSocket
   * ============================================================ */
  let cursorThrottle = 0;
  function sendCursor(p, force) {
    if (!state.room || state.conn.status !== 'online') return;
    const now = performance.now();
    if (!force && now - cursorThrottle < 40) return;
    cursorThrottle = now;
    if (p) wsSend('cursor', { x: p });
    else wsSend('cursor', { x: null });
  }

  function wsSend(t, body = {}) {
    const ws = state.conn.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ t, body: { ...body, memberId: state.self.id, name: state.self.name, strokeCount: state.strokes.length, paper: state.paper } }));
    return true;
  }

  function wsUrl() {
    if (SITE.apiBase) {
      if (SITE.apiBase.startsWith('ws://') || SITE.apiBase.startsWith('wss://')) return SITE.apiBase.replace(/\/+$/, '') + '/ws';
      return SITE.apiBase.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  /** 分享連結：在本機伺服器上指向自己的房間；靜態版則指向設定的後端 */
  function shareUrl(roomCode) {
    if (!SITE.apiBase) return `${location.origin}${location.pathname}?room=${roomCode}`;
    return `${SITE.apiBase.replace(/^ws/, 'http').replace(/\/+$/, '')}/?room=${roomCode}`;
  }

  let lastHello = null;
  function backendMissing() {
    toast('這個網站是 GitHub Pages 的靜態版，聯機與交換色紙需要另外的伺服器。想和朋友一起畫，請在本機跑 `node server.js`。', { ms: 6000 });
    switchTab('friends');
    return true;
  }

  function connect(opts = {}) {
    const { joinCode, createRoom, onReady, silent } = opts;
    if (!HAS_BACKEND) {
      state.conn.status = 'offline';
      state.conn.joining = null;
      updateConnUI();
      if (!silent) backendMissing();
      return;
    }
    if (location.protocol === 'file:') {
      toast('請用 node server.js 啟動伺服器，才能和朋友一起畫');
      state.conn.status = 'offline';
      updateConnUI();
      return;
    }
    if (state.conn.ws && state.conn.ws.readyState <= 1) {
      try { state.conn.ws.onclose = null; state.conn.ws.close(); } catch { /* ignore */ }
    }
    const ws = new WebSocket(wsUrl());
    state.conn.ws = ws;
    state.conn.status = 'connecting';
    updateConnUI();

    let handshook = false;
    // 開房/加入時呼叫者提供的完成回呼（成功時會在 joined 後呼叫，失敗時在 error / onclose 呼叫）
    state.conn.readyCb = onReady || null;
    ws.onopen = () => {
      handshook = true;
      state.conn.status = 'online';
      state.conn.retries = 0;
      state.conn.rejoin = !!state.room;
      let hello = {};
      if (createRoom) hello.createRoom = true;
      else if (joinCode) hello.joinCode = joinCode;
      else if (state.conn.rejoin) hello.rejoin = true;
      wsSendRaw(ws, 'hello', hello);
      updateConnUI();
      // 重連時若已經不在房間裡，就直接回到目前的房間；否則維持在線狀態（可以聊天）
      if (!createRoom && !joinCode && state.room) wsSend('join-room', { code: state.room.code });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    };
    ws.onclose = () => {
      if (state.conn.ws !== ws) return;
      const wasOnline = state.conn.status === 'online';
      state.conn.ws = null;
      state.conn.status = 'offline';
      if (!handshook && !silent) {
        const e = { error: '無法連上伺服器，請確認 server.js 有在執行' };
        if (state.conn.joining) { state.conn.joining = null; state.joinError = e.error; renderJoinModalError(); toast(e.error); }
        if (state.conn.readyCb) { const cb = state.conn.readyCb; state.conn.readyCb = null; cb(e); }
        state.conn.status = 'offline';
        updateConnUI();
        return;
      }
      updateConnUI();
      if (wasOnline && state.room) {
        toast('連線中斷了，正在重新連線…');
        clearPeers();
        scheduleReconnect();
      }
    };
    ws.onerror = () => {};
    ws.addEventListener('open', () => onReady && onReady(null));
  }

  function wsSendRaw(ws, t, body) {
    ws.send(JSON.stringify({
      t,
      body: {
        ...body,
        memberId: state.self.id,
        name: state.self.name,
        color: state.self.color,
        strokeCount: state.strokes.length,
        paper: state.paper,
      },
    }));
  }

  function scheduleReconnect() {
    clearTimeout(state.conn.timer);
    const delay = Math.min(1000 * Math.pow(1.6, state.conn.retries++), 12000);
    state.conn.timer = setTimeout(() => {
      if (!state.room) return;
      connect({ silent: true });
    }, delay);
  }

  function updateConnUI() {
    const s = state.conn.status;
    els.connDot.parentElement.classList.toggle('online', s === 'online');
    if (s === 'online' && state.room) {
      els.roomLabel.textContent = '聯機中';
      els.roomIdLabel.hidden = false;
      els.roomIdLabel.textContent = state.room.code;
      els.copyLinkBtn.hidden = false;
    } else if (s === 'connecting') {
      els.roomLabel.textContent = state.room ? '重新連線中…' : (state.conn.joining ? `正在加入 ${state.conn.joining}…` : '連線中…');
      els.roomIdLabel.hidden = !state.room;
    } else {
      els.roomLabel.textContent = state.room ? '連線中斷' : (HAS_BACKEND ? '離線模式' : '單機模式');
      els.roomIdLabel.hidden = true;
      els.copyLinkBtn.hidden = true;
    }
    renderRoomCard();
  }

  function flushPending() {
    if (!state.room || state.conn.status !== 'online') return;
    const ops = state.pending.splice(0);
    for (const op of ops) {
      if (op.t === 'stroke') wsSend('stroke', op.body);
      else if (op.t === 'erase') wsSend('erase', op.body);
    }
    if (state.pendingPaper) { state.pendingPaper = false; wsSend('paper', state.paper); }
  }

  function handleServer(msg) {
    switch (msg.t) {
      case 'hello-ok':
        clearPeerRequestTimeout();
        break;
      case 'joined':
        onJoined(msg);
        if (state.conn.readyCb) { const cb = state.conn.readyCb; state.conn.readyCb = null; cb(null); }
        break;
      case 'error':
        if (msg.code === 'join') {
          state.conn.joining = null;
          if (state.conn.readyCb) { state.conn.readyCb = null; }
          state.joinError = msg.message;
          renderJoinModalError();
          toast(msg.message);
          if (!state.room) {
            state.conn.status = 'offline';
            try { state.conn.ws && state.conn.ws.close(); } catch { /* ignore */ }
          }
        } else {
          toast(msg.message);
        }
        break;
      case 'member-joined':
        state.others.set(msg.member.id, msg.member);
        renderPeople();
        spikeEdge();
        break;
      case 'member-updated':
        state.others.set(msg.member.id, msg.member);
        renderPeople();
        break;
      case 'member-left':
        state.others.delete(msg.id);
        if (!msg.pending) state.peersOffline.delete(msg.id);
        if (msg.pending) state.others.set(msg.id, { ...state.others.get(msg.id), id: msg.id, name: msg.name, online: false });
        renderPeople();
        break;
      case 'paper':
        applyPaperState({ ...state.paper, ...msg.paper }, msg.by ? state.others.get(msg.by)?.name : null);
        break;
      case 'stroke':
        if (msg.stroke && msg.stroke.by !== state.self.id) {
          const st = deserializeStroke(msg.stroke);
          st.size = remoteSize(st.size, st.paperW);
          state.strokes.push(st);
          state.dirty = true;
          updateProgress();
          if (msg.stroke.tool === 'watercolor') spikeEdge(0.6);
        }
        break;
      case 'erased': {
        const set = new Set(msg.ids);
        state.strokes = state.strokes.filter((s) => !set.has(s.id));
        state.dirty = true;
        updateProgress();
        break;
      }
      case 'stroke-update': {
        const s = state.strokes[msg.index];
        if (s) { s.points = ptsArrayToObjs(msg.points); state.dirty = true; }
        break;
      }
      case 'cursor':
        state.othersCursor.set(msg.id, { x: msg.x, y: msg.y, last: performance.now() });
        break;
      case 'chat':
        pushChat(msg.msg);
        break;
      case 'chat-ack':
        pushChat(msg.msg, true);
        break;
      case 'exchange-incoming':
        receiveExchange(msg.request);
        break;
      case 'exchange-offer':
        modalExchangeOffer(msg.offer);
        break;
      case 'exchange-sent':
        toast(`交換請求已送出給 ${msg.toName}，等待對方回禮 ✨`, { gold: true });
        break;
      case 'exchange-accepted':
        toast(`${msg.name} 收下了你的色紙 🎉`, { gold: true });
        systemChat(`${msg.name} 收下了交換的色紙`);
        break;
      case 'exchange-declined':
        toast(`${msg.name} 這次婉拒了交換`);
        break;
      case 'exchange-cancelled':
        toast(`${msg.name} 取消了交換`);
        if (els.incomingModal.hidden === false) closeModal('incomingModal');
        break;
      case 'gallery-saved':
        toast(`已收藏 ${msg.items.length} 張色紙到畫廊`, { gold: true });
        setGalleries([...getGalleries(), ...msg.items.map(toLocalGallery)]);
        switchTab('gallery');
        break;
      case 'gallery-reviewed':
        setGalleries([...getGalleries(), ...msg.items.map(toLocalGallery)]);
        break;
      case 'left':
        onLeftRoom();
        break;
      default:
        break;
    }
  }

  function clearPeerRequestTimeout() { clearTimeout(state.conn.reqTimer); }

  function clearRoomUi() {
    clearCursorEls();
    state.othersCursor.clear();
    state.incoming.clear();
    renderIncoming();
    $$('.modal.open').forEach((m) => { if (m.id === 'incomingModal') closeModal('incomingModal'); });
  }

  function onJoined(msg) {
    state.conn.joining = null;
    if (!msg.rejoin) clearRoomUi();
    state.room = { code: msg.room.code };
    state.self = { ...state.self, name: msg.self.name, color: msg.self.color };
    saveSelf();
    state.others.clear();
    state.othersCursor.clear();
    for (const m of msg.room.members) if (m.id !== state.self.id) state.others.set(m.id, m);
    // 如果自己還沒畫東西，就沿用房間的紙張設定
    if (!state.strokes.length && msg.room.strokes && msg.room.strokes.length) {
      state.strokes = msg.room.strokes.map(deserializeStroke);
    } else if (msg.room.strokes && msg.room.strokes.length) {
      // 合併：避免重複
      const have = new Set(state.strokes.map((s) => s.id));
      for (const s of msg.room.strokes) if (!have.has(s.id)) state.strokes.push(deserializeStroke(s));
    }
    if (msg.room.paper) applyPaperState({ ...state.paper, ...msg.room.paper });
    // 聊天室歷史
    const log = els.chatLog;
    for (const m of msg.room.history || []) pushChat(m);
    state.dirty = true;
    updateProgress();
    updateUndoButtons();
    const url = new URL(location.href);
    url.searchParams.set('room', msg.room.code);
    history.replaceState(null, '', url);
    state.conn.status = 'online';
    updateConnUI();
    renderPeople();
    renderRoomCard();
    switchTab('friends');
    flushPending();
    if (msg.isNew) toast(`房間 ${msg.room.code} 已建立，複製邀請連結給朋友吧！`, { gold: true });
    else toast(`已加入房間 ${msg.room.code}`);
    state.lastChatCount = (state.room && msg.room.history ? msg.room.history.length : 0);
  }

  function onLeftRoom() {
    state.room = null;
    state.conn.status = 'offline';
    if (state.conn.ws) { try { state.conn.ws.onclose = null; state.conn.ws.close(); } catch { /* ignore */ } state.conn.ws = null; }
    state.others.clear();
    clearRoomUi();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    updateConnUI();
    renderPeople();
    renderRoomCard();
    toast('已離開房間，現在是離線模式');
  }

  /* ============================================================
   * 7. UI
   * ============================================================ */
  /* ---- 深色 / 淺色模式 ---- */
  function getTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';
  }
  function applyTheme(theme, { save = true } = {}) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    if (els.themeLabel) els.themeLabel.textContent = t === 'dark' ? '深色' : '淺色';
    if (els.themeBtn) els.themeBtn.title = t === 'dark' ? '目前是深色模式，點一下切換成淺色' : '目前是淺色模式，點一下切換成深色';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#17151c' : '#f4ede2');
    if (save) STORE.set('theme', t);
  }
  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    toast(next === 'dark' ? '🌙 已切換到深色模式' : '☀️ 已切換到淺色模式');
    // 紙邊的柔光跟紙張本身不變，但外框陰影要跟著調整
    state.sparkDirty = true;
  }

  function saveSelf() {
    STORE.set('self', { id: state.self.id, name: state.self.name, color: state.self.color });
  }

  /* ---- 左側：色紙 ---- */
  function renderPaperGrid() {
    els.paperGrid.innerHTML = '';
    for (const p of PAPERS) {
      const b = document.createElement('button');
      b.className = 'paper-chip' + (state.paper.bg === p.id ? ' active' : '');
      b.style.setProperty('--c1', p.c1);
      b.style.setProperty('--c2', p.c2);
      b.dataset.id = p.id;
      b.dataset.edge = state.paper.edge;
      b.title = p.name;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', p.name);
      b.innerHTML = `<span class="sheet"></span>` + (state.paper.edge !== 'plain' ? `<span class="flag">${state.paper.edge === 'gold' ? '金' : '雷'}</span>` : '');
      b.addEventListener('click', () => selectPaper(p.id));
      els.paperGrid.appendChild(b);
    }
    $('.paper-chip-label')?.remove();
    const lbl = document.createElement('p');
    lbl.className = 'paper-chip-label';
    lbl.textContent = `${paperOf(state.paper.bg).name} · ${PAPER_SIZES[state.paper.size].label}`;
    els.paperGrid.appendChild(lbl);
  }

  function selectPaper(id) {
    if (state.paper.bg === id) return;
    state.paper.bg = id;
    $$('.paper-chip').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
    $$('.paper-chip .flag').forEach((el) => el.remove());
    if (state.paper.edge !== 'plain') {
      const active = $('.paper-chip.active');
      if (active) active.insertAdjacentHTML('beforeend', `<span class="flag">${state.paper.edge === 'gold' ? '金' : '雷'}</span>`);
    }
    const lbl = $('.paper-chip-label');
    if (lbl) lbl.textContent = `${paperOf(id).name} · ${PAPER_SIZES[state.paper.size].label}`;
    savePaper();
    renderPaper();
    buildSparks(state.render.W, state.render.H, state.paper, state.render.rad);
    renderFx(state.t);
    pushPaper();
    // 換紙時給一點小小的動畫
    els.paperHost.animate(
      [{ transform: 'scale(0.985)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1.2)' }
    );
  }

  function selectEdge(edge) {
    state.paper.edge = edge;
    $$('.paper-chip').forEach((el) => { el.dataset.edge = edge; });
    $$('.edge-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.edge === edge)));
    els.hueRow.hidden = edge !== 'laser';
    els.hueShiftBtn.textContent = state.hueShifting ? '■ 停止' : '▶ 流動';
    buildSparks(state.render.W, state.render.H, state.paper, state.render.rad);
    renderFx(state.t);
    renderPaperGrid();
    savePaper();
    pushPaper();
    if (edge !== 'plain') spikeEdge(2);
  }

  function selectSize(size) {
    if (!PAPER_SIZES[size]) return;
    state.paper.size = size;
    savePaper();
    layout();
    renderPaperGrid();
    pushPaper();
  }

  function applyPaperState(paper, byName) {
    const changed = paper.bg !== state.paper.bg || paper.edge !== state.paper.edge || paper.size !== state.paper.size;
    state.paper = { ...state.paper, ...paper };
    $$('.paper-chip').forEach((el) => { el.classList.toggle('active', el.dataset.id === state.paper.bg); el.dataset.edge = state.paper.edge; });
    $$('.edge-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.edge === state.paper.edge)));
    els.hueRow.hidden = state.paper.edge !== 'laser';
    els.edgeHue.value = state.paper.hue;
    els.hueOut.textContent = Math.round(state.paper.hue) + '°';
    savePaper();
    if (changed) {
      layout();
      renderPaperGrid();
    }
    if (byName) spikeEdge(2);
  }

  function savePaper() {
    STORE.set('paper', state.paper);
  }

  function pushPaper() {
    if (state.room && state.conn.status === 'online') {
      wsSend('paper', state.paper);
      state.pendingPaper = false;
    } else {
      state.pendingPaper = true;
    }
  }

  function spikeEdge(mult = 1) {
    edgeMotion.speed = Math.max(edgeMotion.speed, 40 * mult);
    if (Math.random() > 0.5) edgeMotion.dir = edgeMotion.speed;
  }

  let hueTimer = null;
  function bindLeftPanel() {
    $$('.edge-card').forEach((btn) => btn.addEventListener('click', () => selectEdge(btn.dataset.edge)));
    els.edgeHue.addEventListener('input', () => {
      state.paper.hue = Number(els.edgeHue.value);
      els.hueOut.textContent = state.paper.hue + '°';
      renderFx(state.t);
      savePaper();
      clearTimeout(hueTimer);
      hueTimer = setTimeout(pushPaper, 250);
    });
    els.hueShiftBtn.addEventListener('click', () => {
      state.hueShifting = !state.hueShifting;
      els.hueShiftBtn.textContent = state.hueShifting ? '■ 停止' : '▶ 流動';
      if (state.hueShifting && state.paper.edge !== 'laser') selectEdge('laser');
    });
    setInterval(() => {
      if (!state.hueShifting) return;
      state.paper.hue = (state.paper.hue - 0.8 + 360) % 360;
      els.edgeHue.value = state.paper.hue;
      els.hueOut.textContent = Math.round(state.paper.hue) + '°';
      pushPaper();
    }, 120);
    els.undoBtn.addEventListener('click', undo);
    els.redoBtn.addEventListener('click', redo);
    els.clearBtn.addEventListener('click', clearMine);
  }

  /* ---- 工具列 ---- */
  function setTool(tool) {
    state.tool = tool;
    $$('.tool').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.tool === tool)));
    const o = state.toolOpts[tool];
    els.sizeInput.value = o.size;
    els.sizeOut.textContent = tool === 'eraser' ? Math.round(o.size) : o.size;
    els.alphaInput.value = Math.round(o.alpha * 100);
    els.alphaOut.textContent = Math.round(o.alpha * 100) + '%';
    els.alphaInput.disabled = tool === 'eraser';
    els.inkCanvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
    if (tool === 'eraser') hideSelection();
  }

  function setColor(color) {
    state.color = color;
    els.colorInput.value = color;
    els.colorWellFill.style.setProperty('--cc', color);
    $$('.swatch').forEach((el) => el.classList.toggle('active', el.dataset.color.toLowerCase() === color.toLowerCase()));
    if (!state.recent.includes(color)) {
      state.recent = [color, ...state.recent].slice(0, 5);
      STORE.set('recent', state.recent);
      renderRecent();
    }
  }

  function renderSwatches() {
    els.swatches.innerHTML = '';
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.color = c;
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => setColor(c));
      els.swatches.appendChild(b);
    }
    els.colorInput.addEventListener('input', () => {
      setColor(els.colorInput.value);
    });
    const r = STORE.get('recent', []);
    state.recent = Array.isArray(r) ? r.slice(0, 5) : [];
    renderRecent();
  }

  function renderRecent() {
    els.recentColors.innerHTML = '';
    for (const c of state.recent) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => setColor(c));
      els.recentColors.appendChild(b);
    }
  }

  function bindDock() {
    $$('.tool').forEach((el) => el.addEventListener('click', () => setTool(el.dataset.tool)));
    els.sizeInput.addEventListener('input', () => {
      const o = state.toolOpts[state.tool];
      o.size = Number(els.sizeInput.value);
      els.sizeOut.textContent = o.size;
    });
    els.alphaInput.addEventListener('input', () => {
      const o = state.toolOpts[state.tool];
      o.alpha = Number(els.alphaInput.value) / 100;
      els.alphaOut.textContent = els.alphaInput.value + '%';
    });
    // 記錄 shortcut 提示文字
    const keys = { pencil: '1', watercolor: '2', highlight: '3', pen: '4', eraser: '5' };
    $$('.tool').forEach((el) => {
      const k = document.createElement('kbd');
      k.textContent = keys[el.dataset.tool];
      el.appendChild(k);
    });
  }

  function updateProgress() {
    const n = state.strokes.length;
    els.progressText.textContent = `${n} 筆`;
    const pct = clamp(Math.round((n % 40) / 40 * 100) + (n >= 40 ? 100 : 0), 0, 100);
    els.progressBar.style.width = Math.min(100, Math.max(2, pct)) + '%';
    updateUndoButtons();
  }

  function updateUndoButtons() {
    const mine = state.strokes.some((s) => s.by === state.self.id);
    els.undoBtn.disabled = !mine;
    els.redoBtn.disabled = !state.undone.length;
  }

  /* ---- 復原 / 重做 / 清空 ---- */
  function undo() {
    const idx = state.strokes.map((s) => s.by).lastIndexOf(state.self.id);
    if (idx < 0) { toast('目前沒有可以復原的筆畫'); return; }
    const [s] = state.strokes.splice(idx, 1);
    state.undone.push(s);
    state.dirty = true;
    updateProgress();
    if (state.room && state.conn.status === 'online') wsSend('undo', {});
    else state.pending.push({ t: 'undo', body: {} });
  }

  function redo() {
    const s = state.undone.pop();
    if (!s) return;
    state.strokes.push(s);
    state.dirty = true;
    updateProgress();
    if (state.room && state.conn.status === 'online') wsSend('redo', { stroke: serializeStroke(s) });
    else state.pending.push({ t: 'redo', body: { stroke: serializeStroke(s) } });
  }

  function clearMine() {
    const mine = state.strokes.filter((s) => s.by === state.self.id);
    if (!mine.length) { toast('你還沒有畫任何東西'); return; }
    if (!confirm(`要清空你自己畫的 ${mine.length} 筆嗎？（別人的筆畫不會被刪掉）`)) return;
    const ids = mine.map((s) => s.id);
    state.strokes = state.strokes.filter((s) => s.by !== state.self.id);
    state.undone = [];
    state.dirty = true;
    updateProgress();
    if (state.room && state.conn.status === 'online') wsSend('clear', {});
    else state.pending.push({ t: 'erase', body: { ids } });
  }

  /* ---- 選取搬移 ---- */
  function showSelection(ids) {
    state.selection.ids = new Set(ids);
    els.selBar.classList.add('show');
    els.selBar.innerHTML = `<span>已選取 <b>${ids.length}</b> 筆</span>
      <button class="btn btn-sm" id="selMoveBtn">✥ 搬移</button>
      <button class="btn btn-ghost btn-sm" id="selCancelBtn">取消</button>`;
    $('#selMoveBtn').addEventListener('click', beginMoveSelection);
    $('#selCancelBtn').addEventListener('click', () => {
      state.selection.moving = false;
      els.inkCanvas.style.cursor = state.tool === 'eraser' ? 'cell' : 'crosshair';
      hideSelection();
    });
  }
  function hideSelection() {
    state.selection.ids = null;
    els.selBar.classList.remove('show');
  }
  function beginMoveSelection() {
    state.selection.moving = true;
    els.inkCanvas.style.cursor = 'move';
    toast('拖曳紙面就可以搬移選取的筆跡');
  }
  function endMoveSelection() {
    state.selection.moving = false;
    els.inkCanvas.style.cursor = state.tool === 'eraser' ? 'cell' : 'crosshair';
    const moveBtn = $('#selMoveBtn');
    if (moveBtn) moveBtn.textContent = '✥ 搬移';
  }

  function bindSelection() {
    // 按住 Alt，拖曳框選自己畫的筆跡
    let seldrag = null;
    els.inkCanvas.addEventListener('pointerdown', (e) => {
      if (!e.altKey || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      seldrag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      els.inkCanvas.style.cursor = 'crosshair';
      const box = document.createElement('div');
      box.className = 'sel-box';
      box.style.cssText = 'position:absolute;border:1.5px dashed #e8c269;background:rgba(232,194,105,.12);pointer-events:none;z-index:4;';
      els.cursorLayer.appendChild(box);
      seldrag.box = box;
      $('.sel-bar') && hideSelection();
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!seldrag) return;
      seldrag.x1 = e.clientX;
      seldrag.y1 = e.clientY;
      const r = els.cursorLayer.getBoundingClientRect();
      const x = Math.min(seldrag.x0, seldrag.x1) - r.left;
      const y = Math.min(seldrag.y0, seldrag.y1) - r.top;
      seldrag.box.style.left = x + 'px';
      seldrag.box.style.top = y + 'px';
      seldrag.box.style.width = Math.abs(seldrag.x1 - seldrag.x0) + 'px';
      seldrag.box.style.height = Math.abs(seldrag.y1 - seldrag.y0) + 'px';
    });
    window.addEventListener('pointerup', () => {
      if (!seldrag) return;
      seldrag.box.remove();
      const a = toNorm({ clientX: seldrag.x0, clientY: seldrag.y0 });
      const b = toNorm({ clientX: seldrag.x1, clientY: seldrag.y1 });
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      seldrag = null;
      if (Math.abs(x1 - x0) < 0.02 && Math.abs(y1 - y0) < 0.02) return;
      const ids = state.strokes.filter((s) => {
        if (s.by !== state.self.id) return false;
        let inside = 0;
        for (const p of s.points) if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) inside++;
        return inside / s.points.length > 0.6;
      }).map((s) => s.id);
      if (!ids.length) { toast('框內沒有你自己畫的筆跡'); return; }
      showSelection(ids);
    });

    // 搬移
    let moveDrag = null;
    els.inkCanvas.addEventListener('pointerdown', (e) => {
      if (!state.selection.moving || !state.selection.ids) return;
      if (elAt(e) !== els.inkCanvas) return;
      e.preventDefault();
      e.stopPropagation();
      moveDrag = { start: toNorm(e), last: toNorm(e), moved: false };
      capturePointer(els.inkCanvas, e.pointerId);
    }, true);
    els.inkCanvas.addEventListener('pointermove', (e) => {
      if (!moveDrag) return;
      const p = toNorm(e);
      const dx = p.x - moveDrag.last.x;
      const dy = p.y - moveDrag.last.y;
      moveDrag.last = p;
      if (!moveDrag.moved && Math.hypot(p.x - moveDrag.start.x, p.y - moveDrag.start.y) < 0.004) return;
      moveDrag.moved = true;
      for (const s of state.strokes) {
        if (!state.selection.ids.has(s.id)) continue;
        for (const pt of s.points) { pt.x += dx; pt.y += dy; }
      }
      state.dirty = true;
    });
    const stop = () => {
      if (!moveDrag) return;
      if (moveDrag.moved) toast('筆跡已搬到新的位置（只會顯示在你的畫面上）');
      moveDrag = null;
    };
    els.inkCanvas.addEventListener('pointerup', stop);
    els.inkCanvas.addEventListener('pointercancel', stop);
  }

  /* ---- 右側面板 ---- */
  function switchTab(name) {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'chat') {
      els.chatBadge.hidden = true;
      trainSeen = chatItems.length;
      scrollChat();
    }
    if (name === 'gallery') {
      setGalleries(getGalleries());
    }
  }

  function bindTabs() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  }

  /* ---- 房間卡片 ---- */
  function renderRoomCard() {
    const online = !!state.room && state.conn.status === 'online';
    if (!els.roomCardTitle || !els.roomCardDesc) return;
    if (online) {
      const count = state.others.size + 1;
      els.roomCardTitle.textContent = `雙人房間 ${state.room.code}`;
      els.roomCardDesc.textContent = count >= 2
        ? '你們兩個都在同一個房間裡了，可以一起畫、聊天，或交換色紙。'
        : `目前只有你在這裡（${count}/2）。把房間號 ${state.room.code} 或邀請連結傳給朋友，對方就能進來一起畫。`;
      if (els.twoPersonNote) {
        els.twoPersonNote.textContent = count >= 2
          ? '🔒 雙人房間已滿（2/2）。'
          : '🔒 雙人房間：只有拿到房間號的人才能進入，最多 2 個人。';
      }
      els.roomForm.hidden = true;
      els.roomActions.hidden = false;
      els.roomShare.hidden = false;
      els.shareLinkInput.value = shareUrl(state.room.code);
    } else {
      els.roomCardTitle.textContent = state.room ? '正在重新連線…' : '聯機一起畫';
      els.roomCardDesc.textContent = state.room
        ? '連線中斷了，正在嘗試恢復。你的夥伴們也在等你回來。'
        : HAS_BACKEND
          ? '建立一間雙人房間後，把 6 位房間號或邀請連結傳給朋友。對方輸入房間號就能進來，房間最多 2 個人。'
          : '目前是 GitHub Pages 靜態版：畫畫、紙邊、存圖都可用，但聯機與交換色紙需要另外的伺服器（在本機跑 `node server.js` 就會開啟）。';
      els.roomForm.hidden = false;
      els.roomActions.hidden = true;
      els.roomShare.hidden = true;
    }
  }

  function bindRoom() {
    els.joinBtn.addEventListener('click', () => joinFromInput());
    els.joinCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); joinFromInput(); }
    });
    els.landingRoom.addEventListener('click', () => openJoinModal());
    els.landingNew.addEventListener('click', () => hideLanding());
    els.copyCodeBtn.addEventListener('click', async () => {
      if (!state.room) return;
      const ok = await copyText(state.room.code);
      toast(ok ? `房間代碼 ${state.room.code} 已複製` : '複製失敗，請手動記下代碼');
    });
    els.copyLinkBtn.addEventListener('click', copyShareLink);
    els.copyShareBtn.addEventListener('click', copyShareLink);
    els.leaveRoomBtn.addEventListener('click', () => {
      if (state.room && state.conn.status === 'online') wsSend('leave-room');
      else onLeftRoom();
      // 離開後回到離線模式，想再一起畫就輸入新的房間號或再開一間
    });
    els.joinConfirmBtn.addEventListener('click', joinFromModal);
    els.themeBtn.addEventListener('click', toggleTheme);
    els.createRoomBtn.addEventListener('click', () => {
      if (state.room) {
        if (!confirm('你已經在房間裡了，要離開並建立新的雙人房間嗎？')) return;
        if (state.conn.status === 'online') wsSend('leave-room');
        else onLeftRoom();
      }
      state.pendingJoin = '';
      createRoomFlow();
    });
    els.joinCodeInput.addEventListener('input', () => {
      els.joinCodeInput.value = els.joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    if (els.chatJoinBtn) els.chatJoinBtn.addEventListener('click', () => openJoinModal());
    els.fitBtn.addEventListener('click', () => {
      layout();
      hideLanding();
    });
    els.nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromModal(); });
    els.joinCodeInput2.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromModal(); });
  }

  async function copyShareLink() {
    if (!state.room) return;
    const link = shareUrl(state.room.code);
    const ok = await copyText(link);
    toast(ok ? '邀請連結已複製，傳給朋友吧！' : link, { gold: true });
  }

  function joinFromInput() {
    const code = els.joinCodeInput.value.trim().toUpperCase();
    if (!code) { toast('想開房間的話，按下面的「建立雙人房間」'); els.createRoomBtn.focus(); return; }
    if (code.length !== 6) { toast('房間號是 6 位英數字，例如 K3M7QF'); return; }
    // 還沒有暱稱就先問暱稱（房間號會被記住，確認後直接加入）
    if (!state.self.name) { openJoinModal(code); return; }
    joinRoom(code);
  }

  /**
   * 開房 / 加入前一律先確認暱稱，這樣名單才看得出誰是誰。
   * pendingJoin：使用者已經輸入好的房間號，確認暱稱後就直接用它加入。
   */
  function openJoinModal(pendingJoin = '') {
    state.joinError = '';
    state.pendingJoin = /^[A-Z0-9]{6}$/i.test(pendingJoin || '') ? pendingJoin.toUpperCase() : '';
    els.nickInput.value = state.self.name || STORE.get('nick', '');
    els.joinCodeInput2.value = state.pendingJoin;
    els.joinCodeField.hidden = !state.pendingJoin;
    $('#joinTitle').textContent = state.pendingJoin ? `加入房間 ${state.pendingJoin}` : '和朋友一起畫';
    renderJoinModalError();
    openModal('joinModal');
    setTimeout(() => (state.pendingJoin ? els.joinConfirmBtn : els.nickInput).focus(), 50);
  }
  function renderJoinModalError() {
    els.joinError.textContent = state.joinError || '';
    els.joinError.style.color = '#f18f96';
  }

  function validNick() {
    const nick = els.nickInput.value.trim().slice(0, 16);
    if (!nick) { state.joinError = '先取一個暱稱吧'; renderJoinModalError(); return null; }
    state.self.name = nick;
    STORE.set('nick', nick);
    saveSelf();
    return nick;
  }

  function joinFromModal() {
    const entered = els.nickInput.value.trim().slice(0, 16);
    if (entered) {
      state.self.name = entered;
      STORE.set('nick', entered);
      saveSelf();
    }
    if (!state.self.name && !validNick()) return;
    state.joinError = '';
    const typed = els.joinCodeField.hidden ? '' : els.joinCodeInput2.value.trim().toUpperCase();
    const code = typed || state.pendingJoin || '';
    state.pendingJoin = '';
    closeModal('joinModal');
    if (code) joinRoom(code);
    else createRoomFlow();
  }

  function createRoomFlow() {
    if (!HAS_BACKEND) { backendMissing(); return; }
    if (!state.self.name) { openJoinModal(); return; }
    state.conn.joining = 'new';
    els.landingNote.textContent = '正在開房間…';
    connect({
      createRoom: true,
      onReady: (err) => {
        if (err) { toast(err); els.landingNote.textContent = '無法連上伺服器'; return; }
        els.landingNote.textContent = '';
        hideLanding();
      },
    });
  }

  function joinRoom(code) {
    if (!HAS_BACKEND) { backendMissing(); return; }
    if (!state.self.name) { openJoinModal(); return; }
    hideLanding();
    state.conn.joining = code;
    els.roomLabel.textContent = `正在加入 ${code}…`;
    connect({
      joinCode: code,
      onReady: (err) => { if (err) toast(err); },
    });
  }

  function checkRoomInUrl() {
    const url = new URL(location.href);
    return url.searchParams.get('room');
  }

  /* ---- 夥伴列表 ---- */
  function renderPeople() {
    const list = els.peopleList;
    list.innerHTML = '';
    const online = !!state.room && state.conn.status === 'online';
    els.peerCount.textContent = online ? String(state.others.size + 1) : String(1);
    const selfLi = personLi({ id: state.self.id, name: state.self.name || '你', color: state.self.color, strokeCount: state.strokes.filter((s) => s.by === state.self.id).length, online: true, self: true });
    list.appendChild(selfLi);
    if (online) {
      const sorted = [...state.others.values()].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      for (const m of sorted) {
        const p = personLi({ ...m, self: false });
        if (m.online) {
          const gift = document.createElement('button');
          gift.className = 'gift';
          gift.textContent = '🎁 交換';
          gift.addEventListener('click', () => openExchange(m.id));
          p.appendChild(gift);
        }
        list.appendChild(p);
      }
    } else {
      const li = document.createElement('li');
      li.className = 'person';
      li.innerHTML = `<div class="avatar" style="background:#444">+</div><div class="who"><b>邀請朋友</b><small>開啟房間或輸入代碼</small></div>`;
      list.appendChild(li);
    }
    renderExchangePeople();
    renderIncoming();
  }

  function personLi(m) {
    const li = document.createElement('li');
    li.className = 'person';
    const name = m.name || '未命名';
    const total = state.strokes.length || 1;
    const pct = m.self ? Math.round((state.strokes.filter((s) => s.by === state.self.id).length / total) * 100) : Math.round(((m.strokeCount || 0) / total) * 100);
    li.innerHTML = `
      <div class="avatar" style="background:${m.color}">${initial(name)}</div>
      <div class="who">
        <b>${escapeHtml(name)}${m.self ? '（你）' : ''}</b>
        <small>${m.online ? '線上' : '暫時離開'}${!m.self ? ` · ${pct}% 的筆跡` : ''}</small>
        <div class="done" style="--c:${m.color}"><i style="width:${clamp(pct, 2, 100)}%"></i></div>
      </div>`;
    return li;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---- 遠端游標 ---- */
  const cursorEls = new Map();
  function clearCursorEls() {
    for (const el of cursorEls.values()) el.remove();
    cursorEls.clear();
  }
  function updateRemoteCursors() {
    const now = performance.now();
    for (const [id, c] of state.othersCursor) {
      const m = state.others.get(id);
      if (!m || now - c.last > 5000) {
        const el = cursorEls.get(id);
        if (el) { el.remove(); cursorEls.delete(id); }
        state.othersCursor.delete(id);
        continue;
      }
      let el = cursorEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'cursor-flag';
        el.style.setProperty('--c', m.color);
        el.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1.5l11 6-5 1.3-2.4 4.7z" fill="${m.color}" stroke="#1b1720" stroke-width="1.1" stroke-linejoin="round"/></svg><span>${escapeHtml(m.name)}</span>`;
        els.cursorLayer.appendChild(el);
        cursorEls.set(id, el);
      }
      el.style.left = (c.x * 100).toFixed(2) + '%';
      el.style.top = (c.y * 100).toFixed(2) + '%';
    }
  }

  /* ---- 聊天室 ---- */
  const chatItems = [];
  let trainSeen = 0;
  function pushChat(msg, mine = false) {
    if (!msg) return;
    if (chatItems.some((m) => m.id === msg.id)) return;
    chatItems.push({ ...msg, mine: mine || msg.by === state.self.id });
    if (chatItems.length > 300) chatItems.shift();
    els.chatEmpty.hidden = true;
    const log = els.chatLog;
    const el = document.createElement('div');
    if (msg.kind === 'sys') {
      el.className = 'msg system';
      el.innerHTML = `<div class="bubble">${escapeHtml(msg.text)}</div>`;
    } else {
      el.className = 'msg' + (msg.by === state.self.id ? ' mine' : '');
      el.innerHTML = `<div class="avatar" style="background:${msg.color || '#999'}">${initial(msg.name)}</div>
        <div class="bubble-wrap"><div class="meta">${escapeHtml(msg.name || '')} · ${timeStr(msg.ts)}</div><div class="bubble">${escapeHtml(msg.text)}</div></div>`;
    }
    log.appendChild(el);
    while (log.children.length > 300) log.firstChild.remove();
    const active = $('.tab-panel[data-panel="chat"]').classList.contains('active');
    if (active) {
      scrollChat();
      trainSeen = chatItems.length;
    } else if (msg.kind !== 'sys' && msg.by !== state.self.id) {
      const badge = els.chatBadge;
      badge.hidden = false;
      badge.textContent = String(chatItems.length - trainSeen);
    }
  }
  function systemChat(text) {
    pushChat({ kind: 'sys', id: uid('sys'), text, ts: Date.now() });
  }
  function scrollChat() {
    requestAnimationFrame(() => { els.chatLog.scrollTop = els.chatLog.scrollHeight; });
  }
  function timeStr(ts) {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function sendChat(text) {
    text = String(text || '').trim().slice(0, 300);
    if (!text) return;
    if (state.room && state.conn.status === 'online') {
      wsSend('chat', { text });
    } else {
      pushChat({ kind: 'user', id: uid('c'), by: state.self.id, name: state.self.name || '你', color: state.self.color, text, ts: Date.now() }, true);
      if (!state.room) systemChat('目前是離線模式，開啟房間後朋友才看得到你的訊息。');
    }
  }

  function bindChat() {
    els.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat(els.chatInput.value);
      els.chatInput.value = '';
    });
    els.chatInput.addEventListener('focus', () => { els.chatBadge.hidden = true; });
    for (const emoji of QUICK_EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.addEventListener('click', () => {
        els.chatInput.value += emoji;
        els.chatInput.focus();
      });
      els.quickEmojis.appendChild(b);
    }
  }

  /* ---- 畫廊 ---- */
  function getGalleries() {
    const g = STORE.get('gallery', []);
    return Array.isArray(g) ? g : [];
  }
  function setGalleries(list) {
    const g = list.filter(Boolean).slice(0, 30);
    STORE.set('gallery', g);
    renderGallery();
  }
  function toLocalGallery(it) {
    return {
      id: it.id, image: it.image, title: it.title, by: it.by, from: it.from || '',
      ts: it.ts, paper: it.paper,
    };
  }
  function renderGallery() {
    const list = getGalleries();
    if (state.offerTo) {
      els.galleryDesc.innerHTML = `請挑一張回禮給 <b style="color:#f2d48a">${escapeHtml(state.offerTo.name)}</b>（點一下縮圖就會送出）`;
      els.galleryDesc.dataset.offer = '1';
    } else if (els.galleryDesc.dataset.offer) {
      els.galleryDesc.textContent = '你與朋友的作品會收藏在這裡，可以隨時拿回來看或下載。';
      delete els.galleryDesc.dataset.offer;
    }
    els.galleryGrid.innerHTML = '';
    els.galleryEmpty.hidden = list.length > 0;
    els.galleryBadge.hidden = true;
    for (const it of list) {
      const li = document.createElement('li');
      li.className = 'g-item';
      const from = it.from || (it.by !== state.self.name ? it.by : '');
      li.innerHTML = `
        <div class="g-thumb" title="點一下拿回畫布重畫">
          <img alt="${escapeHtml(it.title)}" src="${it.image}" />
          <span class="tag ${from ? 'from' : ''}">${from ? '🎁 ' + escapeHtml(from) : '🖼 我的'}</span>
        </div>
        <p class="g-name">${escapeHtml(it.title)}</p>
        <p class="g-by">${escapeHtml(it.by)} · ${new Date(it.ts).toLocaleDateString()}</p>
        <button class="g-del" title="刪除">✕</button>`;
      li.querySelector('.g-thumb').addEventListener('click', () => loadFromGallery(it));
      li.querySelector('.g-del').addEventListener('click', () => {
        setGalleries(list.filter((x) => x.id !== it.id));
        toast('已從畫廊移除');
      });
      els.galleryGrid.appendChild(li);
    }
  }

  function loadFromGallery(it) {
    if (state.offerTo) {
      const to = state.offerTo;
      state.offerTo = null;
      sendOffer(to.id, it);
      switchTab('friends');
      return;
    }
    openExchangePreview(it);
  }

  /* ============================================================
   * 8. 匯出 / 交換
   * ============================================================ */
  function exportCanvas() {
    const { W, H } = state.render;
    const c = makeCanvas(W, H);
    const x = c.getContext('2d');
    ctxPaper.setTransform(1, 0, 0, 1, 0, 0);
    ctxFx.setTransform(1, 0, 0, 1, 0, 0);
    ctxInk.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(els.paperCanvas, 0, 0);
    x.drawImage(els.fxCanvas, 0, 0);
    x.drawImage(els.inkCanvas, 0, 0);
    // 落款的燙金字
    const name = state.self.name || STORE.get('nick', '') || '';
    x.save();
    const fontPx = Math.max(10, W * 0.018);
    x.font = `700 ${fontPx}px "Noto Serif TC", serif`;
    x.textAlign = 'right';
    x.textBaseline = 'bottom';
    const pad = state.render.pad;
    const gold = x.createLinearGradient(W - pad * 3, H - pad * 2, W - pad, H - pad * 0.5);
    gold.addColorStop(0, '#fff3c4');
    gold.addColorStop(0.4, '#e8c269');
    gold.addColorStop(0.6, '#a87c1f');
    gold.addColorStop(1, '#ffeaaa');
    x.shadowColor = 'rgba(0,0,0,0.25)';
    x.shadowBlur = fontPx * 0.25;
    x.shadowOffsetY = 1;
    x.fillStyle = gold;
    const sealText = name ? `✦ ${name} · 彩紙屋` : '✦ 彩紙屋';
    x.fillText(sealText, W - pad * 1.6, H - pad * 1.4);
    x.restore();
    return c;
  }

  function exportPng(maxWidth = 0) {
    const full = exportCanvas();
    if (!maxWidth || full.width <= maxWidth) return full.toDataURL('image/png');
    const scale = maxWidth / full.width;
    const c = makeCanvas(full.width * scale, full.height * scale);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(full, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  function saveImage() {
    try {
      const url = exportPng();
      const a = document.createElement('a');
      a.href = url;
      a.download = `彩紙屋_${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已下載你的色紙 PNG');
    } catch (err) {
      toast('下載失敗：' + err.message);
    }
  }

  async function publishToGallery(items) {
    if (!(state.room && state.conn.status === 'online')) {
      const local = items.map((it) => toLocalGallery({ ...it, id: uid('g'), ts: Date.now() }));
      setGalleries([...local, ...getGalleries()]);
      return true;
    }
    wsSend('gallery-save', { items, name: state.self.name });
    return true;
  }

  /* ---- 交換色紙 ---- */
  function openExchange(toId) {
    hideLanding();
    if (!HAS_BACKEND) { backendMissing(); return; }
    if (!state.room || state.conn.status !== 'online') {
      toast('要先和朋友在同一間房間，才能交換色紙');
      return;
    }
    const others = [...state.others.values()].filter((m) => m.online);
    if (!others.length) {
      toast('房間裡還沒有其他人，先邀請朋友加入吧');
      switchTab('friends');
      return;
    }
    state.exchangeTarget = toId || (others.length === 1 ? others[0].id : null);
    const preview = exportPng(360);
    els.exchangePreview.innerHTML = `<img alt="你的色紙" src="${preview}" />`;
    els.exchangeMeta.textContent = `你要送出：${paperOf(state.paper.bg).name}《${state.self.name || '你的'}色紙》`;
    els.exchangeSub.textContent = '送出後，你會收到一張對方從畫廊挑選的色紙作為回禮。';
    renderExchangePeople();
    openModal('exchangeModal');
  }

  function renderExchangePeople() {
    if (!els.exchangePeople) return;
    const list = [...state.others.values()].filter((m) => m.online);
    els.exchangePeople.innerHTML = '';
    for (const m of list) {
      const li = document.createElement('li');
      li.className = 'person selectable' + (state.exchangeTarget === m.id ? ' sel' : '');
      li.innerHTML = `<div class="avatar" style="background:${m.color}">${initial(m.name)}</div>
        <div class="who"><b>${escapeHtml(m.name)}</b><small>${m.strokeCount || 0} 筆</small></div>`;
      li.addEventListener('click', () => {
        state.exchangeTarget = m.id;
        renderExchangePeople();
      });
      els.exchangePeople.appendChild(li);
    }
    els.exchangeSendBtn.disabled = !state.exchangeTarget;
    els.exchangeHint.textContent = list.length ? '' : '目前沒有其他人在線。';
  }

  function sendExchange() {
    const to = state.exchangeTarget;
    if (!to) return;
    const image = exportPng(480);
    wsSend('exchange-request', { to, fromImage: image });
    closeModal('exchangeModal');
  }

  function receiveExchange(req) {
    state.incoming.set(req.id, { ...req, status: 'pending' });
    renderIncoming();
    if ($('.tab-panel[data-panel="friends"]').classList.contains('active')) switchTab('friends');
    else toast(`${req.fromName} 想和你交換色紙 🎁`, { gold: true });
    const overlay = state.room && state.conn.status === 'online';
    if (overlay && state.incoming.size === 1) openIncomingModal(req.id);
  }

  function renderIncoming() {
    const list = els.incomingList;
    list.innerHTML = '';
    let n = 0;
    for (const [id, req] of state.incoming) {
      if (req.status !== 'pending') continue;
      n++;
      const li = document.createElement('li');
      li.className = 'request';
      li.innerHTML = `<p><b style="color:${req.fromColor}">${escapeHtml(req.fromName)}</b> 想用一張色紙和你交換。</p>
        <div class="actions"><button class="btn btn-sm">先看看</button><button class="btn btn-ghost btn-sm">婉拒</button></div>`;
      const [view, decline] = li.querySelectorAll('button');
      view.addEventListener('click', () => openIncomingModal(id));
      decline.addEventListener('click', () => declineRequest(id));
      list.appendChild(li);
    }
    els.incomingCount.textContent = String(n);
    els.incomingBox.hidden = n === 0;
  }

  function openIncomingModal(id) {
    const req = state.incoming.get(id);
    if (!req) return;
    state.currentIncoming = id;
    els.incomingTitle.textContent = `${req.fromName} 想和你交換色紙`;
    els.incomingBody.innerHTML = `
      <div class="offer-card">
        <div class="preview-wrap">${req.fromImage ? `<img alt="對方送的色紙" src="${req.fromImage}" />` : '<div style="display:grid;place-items:center;height:100%;color:#888;font-size:12px">（無預覽）</div>'}</div>
        <div class="preview-meta">
          <p><b>${escapeHtml(req.fromName)}</b> 送你一張色紙。</p>
          <p class="muted">收下之後，系統會請你從自己的畫廊挑一張回禮；對方想要的其實是「你自己畫的東西」。</p>
        </div>
      </div>`;
    openModal('incomingModal');
  }

  function acceptIncoming() {
    const id = state.currentIncoming;
    const req = state.incoming.get(id);
    if (!req) return;
    // 1. 收下對方的色紙
    const mine = getGalleries().filter((g) => !g.from);
    const pick = mine.length ? mine[0] : null;
    if (req.fromImage) {
      publishToGallery([{ image: req.fromImage, title: `${req.fromName}的交換色紙`, by: req.fromName, from: req.fromName, to: state.self.name }]);
      floatPaper(req.fromImage);
    }
    // 2. 挑一張回禮
    req.status = 'accepted';
    state.incoming.delete(id);
    renderIncoming();
    wsSend('exchange-accept', { to: req.from });
    closeModal('incomingModal');
    if (pick) {
      sendOffer(req.from, pick);
    } else {
      state.offerTo = { id: req.from, name: req.fromName };
      switchTab('gallery');
      toast(`你的畫廊還是空的。先畫一張，或從畫廊挑一張回禮給 ${req.fromName}。`, { gold: true });
    }
  }

  function sendOffer(to, item) {
    const image = item.image;
    wsSend('exchange-offer', { to, image, title: item.title });
    toast(`已把「${item.title}」作為回禮送出 ✨`, { gold: true });
  }

  function declineRequest(id) {
    const req = state.incoming.get(id);
    if (!req) return;
    state.incoming.delete(id);
    renderIncoming();
    wsSend('exchange-decline', { to: req.from });
    if (els.incomingModal.classList.contains('open')) closeModal('incomingModal');
    toast('已婉拒交換');
  }

  function modalExchangeOffer(offer) {
    if (!offer) return;
    const html = `
      <div class="offer-card">
        <div class="preview-wrap">${offer.image ? `<img alt="回禮色紙" src="${offer.image}" />` : '<div style="display:grid;place-items:center;height:100%;color:#888;font-size:12px">（無圖片）</div>'}</div>
        <div class="preview-meta">
          <p><b style="color:${offer.fromColor}">${escapeHtml(offer.fromName)}</b> 回了你一張色紙：<br/><b>《${escapeHtml(offer.title || '未命名')}》</b></p>
          <p class="muted">這張會直接放進你的畫廊收藏。</p>
        </div>
      </div>`;
    els.incomingTitle.textContent = `${offer.fromName} 的回禮`;
    els.incomingBody.innerHTML = html;
    els.acceptOfferedBtn.textContent = '收下回禮';
    els.declineOfferedBtn.textContent = '關閉';
    els.acceptOfferedBtn.onclick = async () => {
      await publishToGallery([{ image: offer.image, title: offer.title || '交換來的色紙', by: offer.fromName, from: offer.fromName, to: state.self.name }]);
      if (offer.image) floatPaper(offer.image);
      closeModal('incomingModal');
      switchTab('gallery');
    };
    els.declineOfferedBtn.onclick = () => closeModal('incomingModal');
    openModal('incomingModal');
  }

  function openExchangePreview(it) {
    els.incomingTitle.textContent = it.title;
    els.incomingBody.innerHTML = `<div class="offer-card"><div class="preview-wrap"><img alt="" src="${it.image}" /></div>
      <div class="preview-meta"><p>${escapeHtml(it.from ? `來自 ${it.from} 的交換色紙` : '你的收藏')}</p><p class="muted">${new Date(it.ts).toLocaleString()}</p></div></div>`;
    els.acceptOfferedBtn.textContent = '下載這張';
    els.declineOfferedBtn.textContent = '關閉';
    els.acceptOfferedBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = it.image;
      a.download = `${it.title}.png`;
      a.click();
    };
    els.declineOfferedBtn.onclick = () => closeModal('incomingModal');
    openModal('incomingModal');
  }

  function floatPaper(dataUrl) {
    const el = document.createElement('div');
    el.className = 'float-paper';
    el.innerHTML = `<img alt="" src="${dataUrl}" />`;
    const wrap = els.canvasWrap.getBoundingClientRect();
    el.style.left = 50 + (Math.random() * 20 - 10) + '%';
    el.style.top = '40%';
    el.style.transform = 'translate(-50%, -50%)';
    els.canvasWrap.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function bindExchange() {
    els.exchangeOpenBtn.addEventListener('click', () => openExchange());
    els.exchangeSendBtn.addEventListener('click', sendExchange);
    els.acceptOfferedBtn.addEventListener('click', () => {
      if (state.currentIncoming && state.incoming.has(state.currentIncoming)) acceptIncoming();
    });
    els.declineOfferedBtn.addEventListener('click', () => {
      if (state.currentIncoming && state.incoming.get(state.currentIncoming)?.status === 'pending') declineRequest(state.currentIncoming);
      else closeModal('incomingModal');
    });
    els.saveBtn.addEventListener('click', saveImage);
  }

  /* ---- 彈窗 ---- */
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    m.classList.add('open');
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = true;
    m.classList.remove('open');
    if (id === 'incomingModal') state.currentIncoming = null;
  }
  function bindModals() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close]');
      if (btn) closeModal(btn.dataset.close);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal.open').forEach((m) => closeModal(m.id));
      }
    });
  }

  /* ---- 鍵盤 ---- */
  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if ($$('.modal.open').length) return;
      if (e.key === '1') setTool('pencil');
      else if (e.key === '2') setTool('watercolor');
      else if (e.key === '3') setTool('highlight');
      else if (e.key === '4') setTool('pen');
      else if (e.key === '5') setTool('eraser');
      else if (e.key === '[' || e.key === ']') {
        const o = state.toolOpts[state.tool];
        o.size = clamp(o.size + (e.key === ']' ? 1 : -1), 1, 40);
        els.sizeInput.value = o.size;
        els.sizeOut.textContent = o.size;
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selection.ids) { clearMine(); }
      }
      if (state.selection.ids && e.key === 'Escape') hideSelection();
    });
  }

  /* ---- 開始畫面 ---- */
  let landingHidden = false;
  function hideLanding() {
    if (landingHidden) return;
    landingHidden = true;
    els.landing.classList.add('hide');
    setTimeout(() => { els.landing.hidden = true; }, 380);
  }

  /* ---- 視窗大小 ---- */
  let resizeTimer = null;
  function bindResize() {
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        layout();
        updateRemoteCursors();
      }, 120);
    };
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(els.canvasWrap);
  }

  /* ============================================================
   * 9. 啟動
   * ============================================================ */
  function initState() {
    // 記錄「真的有選過」的主題；沒選過就依系統偏好
    state.savedTheme = STORE.get('theme', null);
    state.themeChosen = state.savedTheme === 'light' || state.savedTheme === 'dark';
    const savedSelf = STORE.get('self', null);
    if (savedSelf && savedSelf.id) state.self = { ...state.self, ...savedSelf };
    state.self.name = STORE.get('nick', '') || (savedSelf && savedSelf.name) || '';
    state.self.color = state.self.color || '#9cc3f0';
    const savedPaper = STORE.get('paper', null);
    if (savedPaper && typeof savedPaper === 'object') state.paper = { ...state.paper, ...savedPaper };
    if (!PAPER_SIZES[state.paper.size]) state.paper.size = 'B4';
    if (!PAPERS.some((p) => p.id === state.paper.bg)) state.paper.bg = 'sakura';
    state.tool = STORE.get('tool', 'pen');
    if (!TOOLS[state.tool]) state.tool = 'pen';
    const savedOpts = STORE.get('toolOpts', null);
    if (savedOpts && typeof savedOpts === 'object') {
      for (const k of Object.keys(state.toolOpts)) if (savedOpts[k]) state.toolOpts[k] = { ...state.toolOpts[k], ...savedOpts[k] };
    }
    state.color = STORE.get('color', state.tool === 'eraser' ? '#1d1c2b' : state.color);
    state.self.color = state.self.color || paletteColor(state.self.id);
  }

  function paletteColor(id) {
    const p = ['#f2a7b5', '#e8c269', '#9fd4b0', '#9cc3f0', '#c9a7f0', '#f5b98b', '#8de0dc', '#f5f0e6'];
    return p[hashStr(id) % p.length];
  }

  function persistPrefs() {
    STORE.set('tool', state.tool);
    STORE.set('toolOpts', state.toolOpts);
    STORE.set('color', state.color);
    saveSelf();
  }

  function tickAll() { persistPrefs(); }
  setInterval(tickAll, 3000);

  async function init() {
    initState();
    // 選過就沿用；沒選過時，跟隨系統的深色 / 淺色設定
    const prefersLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    applyTheme(state.themeChosen ? state.savedTheme : (prefersLight ? 'light' : 'dark'), { save: false });
    bindLeftPanel();
    // 尺寸選擇（放在色紙格下方）
    const sizeRow = document.createElement('div');
    sizeRow.className = 'hue-row';
    sizeRow.style.marginTop = '12px';
    sizeRow.innerHTML = `<label style="grid-column:1/-1"><span>紙張尺寸</span></label><div class="sizes" style="grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap"></div>`;
    const sizes = sizeRow.querySelector('.sizes');
    for (const [key, v] of Object.entries(PAPER_SIZES)) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm' + (state.paper.size === key ? ' btn-primary' : ' btn-ghost');
      b.textContent = v.label;
      b.dataset.size = key;
      b.addEventListener('click', () => {
        selectSize(key);
        $$('.sizes .btn').forEach((x) => {
          x.classList.toggle('btn-primary', x.dataset.size === key);
          x.classList.toggle('btn-ghost', x.dataset.size !== key);
        });
      });
      sizes.appendChild(b);
    }
    document.querySelectorAll('.section')[0].appendChild(sizeRow);

    els.edgeHue.value = state.paper.hue;
    els.hueOut.textContent = Math.round(state.paper.hue) + '°';
    els.hueRow.hidden = state.paper.edge !== 'laser';
    $$('.edge-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.edge === state.paper.edge)));

    renderSwatches();
    bindDock();
    setTool(state.tool);
    setColor(state.color);
    bindDrawing();
    bindSelection();
    bindTabs();
    bindRoom();
    bindChat();
    bindExchange();
    bindModals();
    bindKeys();
    bindResize();
    warmAtlas();
    layout();
    renderPaperGrid();
    renderPeople();
    renderRoomCard();
    renderGallery();
    updateProgress();
    requestAnimationFrame(frame);

    // 進入房間？
    // 網址裡的 ?room= 只在「這次開啟」自動加入一次；之後（例如手動輸入其他房號）就不要再自動搶房間
    if (!sessionStorage.getItem('cp:autoJoin')) {
      sessionStorage.setItem('cp:autoJoin', '1');
      const roomCode = checkRoomInUrl();
      if (roomCode && /^[A-Z0-9]{6}$/i.test(roomCode)) {
        if (state.self.name) {
          hideLanding();
          setTimeout(() => joinRoom(roomCode.toUpperCase()), 120);
        } else {
          els.landingNote.textContent = `朋友邀請你加入房間 ${roomCode.toUpperCase()}，先取一個暱稱吧！`;
          setTimeout(() => openJoinModal(roomCode.toUpperCase()), 300);
        }
      } else {
        els.landingNote.textContent = !HAS_BACKEND
        ? '這是靜態展示版：可以選紙、塗鴉、存圖；聯機與交換色紙需要另外的伺服器。'
        : state.self.name ? `歡迎回來，${state.self.name}！` : '先選一張色紙，再決定要不要和朋友一起畫。';
      }
    }

    // 直接開房的簡便入口：網址加 ?new=1
    if (new URL(location.href).searchParams.get('new') === '1' && state.self.name) {
      hideLanding();
      setTimeout(() => createRoomFlow(), 100);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 給自動化測試用的小 API
  window.__coloredPaper = { state, exportPng, renderFx, PAPERS, paintStroke, get ctxInk() { return ctxInk; }, get liveBuf() { return liveBuf; }, get draw() { return draw; }, renderInk };
})();
