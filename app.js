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
  // 共享給展示站 / 線上試玩使用（同一份渲染程式，避免另外維護一套）
  const CP_ENGINE = (window.CP_ENGINE = window.CP_ENGINE || {});

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
    el.textContent = opts.key ? $I(opts.key, opts.vars) : tMsg(String(text), opts.vars);
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

  // 只提供白紙（紙張本身不再變色；燙金 / 燙雷射的邊框仍然保留）
  const WHITE_PAPER = { id: 'white', c1: '#fdfcf9', c2: '#f2ede3', name: '白紙' };
  const PAPERS = [WHITE_PAPER];
  const LEGACY_PAPER_IDS = ['sakura', 'peach', 'lemon', 'matcha', 'mizu', 'lilac', 'beige', 'coral', 'sage', 'sky',
    'rose', 'cream', 'teal', 'apricot', 'graphite', 'night', 'ink', 'moss', 'linen', 'lotus', ''];


  // 站台設定：GitHub Pages 版由 scripts/build-pages.mjs 產生 app.config.js
  // apiBase    → 聯機 / 交換色紙用的雲端 WebSocket 伺服器（空字串 = 只有本機伺服器）
  // staticHost → 目前是純靜態空間（GitHub Pages），沒有 Node 後端
  const SITE = Object.assign({ apiBase: '', staticHost: false }, window.COLORPAPER_CONFIG || {});
  const HAS_BACKEND = !!SITE.apiBase || !SITE.staticHost;
  if (SITE.apiBase) SITE.staticHost = false;

  const $I = (key, vars) => (window.CP_I18N ? window.CP_I18N.t(key, vars) : key);
  const isEN = () => !!(window.CP_I18N && window.CP_I18N.current() === 'en');

  /** 動態訊息：把中文原文對應到字典 key（沒有對應就原樣顯示） */
  const MSG_KEYS = new Map(Object.entries({
    '這個網站是 GitHub Pages 的靜態版，聯機與交換色紙需要另外的伺服器。想和朋友一起畫，請在本機跑 `node server.js`。': 'toast.staticHost',
    '請用 node server.js 啟動伺服器，才能和朋友一起畫': 'toast.noServer',
    '連線中斷了，正在重新連線…': 'toast.disconnected',
    '已離開房間，現在是離線模式': 'toast.leftRoom',
    '已還原重置前的畫': 'toast.resetRestored',
    '目前沒有可以復原的筆畫': 'toast.noUndo',
    '目前沒有可以重做的筆畫': 'toast.noRedo',
    '你還沒有畫任何東西': 'toast.noStroke',
    '拖曳紙面就可以搬移選取的筆跡': 'toast.moved',
    '框內沒有你自己畫的筆跡': 'toast.noStrokeSel',
    '筆跡已搬到新的位置（只會顯示在你的畫面上）': 'toast.moved',
    '已重置畫布，可以重新開始了': 'toast.resetDone',
    '想開房間的話，按下面的「建立雙人房間」': 'toast.needCode',
    '房間號是 6 位英數字，例如 K3M7QF': 'toast.codeLength',
    '已從畫廊移除': 'toast.galleryRemoved',
    '已下載你的色紙 PNG': 'toast.downloaded',
    '要先和朋友在同一間房間，才能交換色紙': 'toast.noRoom',
    '房間裡還沒有其他人，先邀請朋友加入吧': 'toast.noOthers',
    '已婉拒交換': 'toast.declined',
    '目前是離線模式，開啟房間後朋友才看得到你的訊息。': 'chat.offlineNote',
    '目前沒有其他人在線。': 'room.empty',
    '（目前是離線模式，訊息只會顯示在你這裡）': 'sys.offlineOnly',
    '已收藏到畫廊': 'toast.gallerySavedShort',
    '圖片太大，無法收藏（單張上限 8MB）': 'toast.tooBig',
    '目前沒有可以回禮的作品': 'toast.emptyGalleryLocal',
    '請先在視窗中輸入暱稱': 'toast.needNick',
  }));

  function tMsg(text, vars) {
    if (!window.CP_I18N) return text;
    if (!isEN()) return text;
    const key = MSG_KEYS.get(text);
    if (key) return $I(key, vars);
    return text;
  }

  const TOOLS = {
    pencil: { label: '鉛筆', size: 3, alpha: 0.9, color: '#43413f' },
    watercolor: { label: '水彩', size: 18, alpha: 0.55, color: '#e8747c' },
    highlight: { label: '螢光筆', size: 22, alpha: 0.45, color: '#ffe045' },
    pen: { label: '原子筆', size: 2.4, alpha: 1, color: '#1d1c2b' },
    goldpen: { label: '燙金筆', size: 6, alpha: 1, color: '#e8c269' },
    eraser: { label: '橡皮擦', size: 26, alpha: 1, color: '#ffffff' },
  };

  const SWATCHES = [
    '#1d1c2b', '#4a4a55', '#ffffff', '#e8747c', '#d24a5b', '#a8325a',
    '#f2a86f', '#e8c269', '#f5e07a', '#8fbf6a', '#2f8f7a', '#6fc3c9',
    '#4f86d9', '#2c4a9e', '#9a7be0', '#c9a7f0', '#8b5a3c', '#c67b5c',
  ];

  // 色碼 → 好看的名字（最近似者），讓自選顏色也有名字
  const COLOR_NAMES = [
    ['#1d1c2b', '墨黑'], ['#4a4a55', '石墨灰'], ['#ffffff', '純白'], ['#e8747c', '珊瑚紅'], ['#d24a5b', '朱紅'],
    ['#a8325a', '胭脂'], ['#f2a86f', '杏橙'], ['#e8c269', '燙金'], ['#f5e07a', '檸檬黃'], ['#8fbf6a', '草綠'],
    ['#2f8f7a', '孔雀綠'], ['#6fc3c9', '水藍'], ['#4f86d9', '晴空藍'], ['#2c4a9e', '群青'], ['#9a7be0', '薰衣草'],
    ['#c9a7f0', '丁香紫'], ['#8b5a3c', '可可棕'], ['#c67b5c', '陶土'], ['#f6d0d8', '櫻花'], ['#bcd5a0', '抹茶'],
    ['#a9cfdf', '霧藍'], ['#e3c3db', '藕粉'], ['#3d3a42', '炭黑'], ['#c9a227', '古金'],
  ];
  const EN_COLOR_NAMES = {
    墨黑: 'Ink black', 石墨灰: 'Graphite', 純白: 'Pure white', 珊瑚紅: 'Coral', 朱紅: 'Vermilion',
    胭脂: 'Carmine', 杏橙: 'Apricot', 燙金: 'Gold', 檸檬黃: 'Lemon', 草綠: 'Grass', 孔雀綠: 'Peacock',
    水藍: 'Aqua', 晴空藍: 'Sky blue', 群青: 'Ultramarine', 薰衣草: 'Lavender', 丁香紫: 'Lilac',
    可可棕: 'Cocoa', 陶土: 'Terracotta', 櫻花: 'Sakura', 抹茶: 'Matcha', 霧藍: 'Misty blue',
    藕粉: 'Lotus', 炭黑: 'Charcoal', 古金: 'Antique gold',
  };

  function colorName(hex) {
    const [r, g, b] = hexToRgb(hex);
    let best = null;
    let bestD = Infinity;
    for (const [c, name] of COLOR_NAMES) {
      const [r2, g2, b2] = hexToRgb(c);
      const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (d < bestD) { bestD = d; best = name; }
    }
    const fallback = $I('picker.name');
    if (bestD >= 900) return fallback;
    // 英文介面回傳英文色名（找不到就回中文）
    if (isEN()) return EN_COLOR_NAMES[best] || best;
    return best;
  }
  const normalizeHex = (v) => {
    let t = String(v || '').trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(t)) t = t.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/.test(t) ? '#' + t : null;
  };

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
      goldpen: { size: 6, alpha: 1 },
      eraser: { size: 26, alpha: 1 },
    },
    recent: [],
    paper: { bg: 'white', edge: 'gold', hue: 210, size: 'B4' },
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
    'pickerBtn', 'pickerModal', 'pickerPreview', 'pickerName', 'pickerHex', 'pickerHexInput', 'pickerNative', 'pickerPresets', 'pickerApply',
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
    return WHITE_PAPER;
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

  /** mix() 回傳 #rrggbb，這裡轉成 "r,g,b" 好用在 rgba() 裡 */
  function mixHex(a, b, t) {
    return hexToRgb(mix(a, b, t)).join(',');
  }

  /** 沿線的總長（CSS 像素） */
  function pathLength(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return total;
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
    // canvas 尺寸：畫布寬高（某些實作沒有 ctx.canvas，退回用畫筆範圍估一個足夠大的值）
    let cw = (ctx.canvas && ctx.canvas.width) || 0;
    let ch = (ctx.canvas && ctx.canvas.height) || 0;
    if (!cw || !ch) {
      let maxX = 0, maxY = 0;
      for (const p of pts) { if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
      cw = Math.ceil(maxX) + 64;
      ch = Math.ceil(maxY) + 64;
    }
    const lw = Math.max(0.6, size);
    ctx.save();
    // 防禦：重設裁切區、濾鏡、陰影與虛線，
    // 避免先前哪一筆漏了 restore，就讓之後的筆跡整片消失或被陰影蓋住
    ctx.beginPath();
    if (cw && ch) ctx.rect(0, 0, cw, ch);
    ctx.clip();
    ctx.filter = 'none';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
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

    /* --- 鉛筆 / 炭筆 --- */
    if (tool === 'pencil') {
      // 炭黑紙紋：讓線條裡有留白與顆粒，像炭筆擦過粗紙
      const grain = getGrainTex('p' + seed);
      const charcoal = luminance(color) < 0.2;
      const deep = charcoal ? mix(color, '#000000', 0.35) : mix(color, '#000000', 0.25);
      // 1. 石墨粉：被紙磨開的柔邊
      ctx.filter = `blur(${Math.max(0.5, lw * 0.12)}px)`;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.28;
      ctx.globalAlpha = alpha * 0.3;
      if (n >= 2) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      ctx.filter = 'none';
      // 2. 筆身 + 紙紋（炭筆會透出更多紙的白，線條較「毛」）
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = lw * (charcoal ? 1.06 : 1.0);
      ctx.strokeStyle = color;
      if (n >= 2) { ctx.beginPath(); smoothPath(ctx, pts); ctx.stroke(); }
      // 注意：createPattern 會把當下的 filter 烘進圖樣，濾鏡重設後才建立
      ctx.globalAlpha = alpha * (charcoal ? 0.97 : 0.9);
      ctx.strokeStyle = ctx.createPattern(grain, 'repeat');
      if (n >= 2) ctx.stroke();
      // 3. 炭筆特有的側面寬筆觸：沿線條拖出扁平的灰帶
      if (charcoal && n >= 3) {
        ctx.save();
        ctx.lineCap = 'round';
        const band = new Path2D();
        smoothPath(band, pts);
        ctx.globalAlpha = alpha * 0.12;
        ctx.strokeStyle = mix(color, '#000000', 0.1);
        ctx.lineWidth = lw * 1.36;
        ctx.stroke(band);
        ctx.restore();
      }
      // 4. 邊緣的炭粉碎屑與細長刮痕
      ctx.lineCap = 'butt';
      const stride = Math.max(1, Math.round(lw / 3));
      const shreds = charcoal ? 2 : 1;
      for (let i = 0; i + stride < n; i += stride) {
        const a = pts[i];
        const b = pts[i + stride];
        const [tx, ty] = normalAt(pts, i);
        for (let k = 0; k < shreds; k++) {
          const off = (rnd() - 0.5) * lw * (charcoal ? 1.35 : 0.95);
          ctx.globalAlpha = alpha * (0.08 + rnd() * (charcoal ? 0.42 : 0.3));
          ctx.lineWidth = Math.max(0.35, lw * (charcoal ? 0.08 + rnd() * 0.2 : 0.12 + rnd() * 0.18));
          ctx.strokeStyle = rnd() > 0.8 ? deep : color;
          ctx.beginPath();
          ctx.moveTo(a.x + tx * off, a.y + ty * off);
          ctx.lineTo(b.x + tx * off + (rnd() - 0.5) * lw * 0.3, b.y + ty * off + (rnd() - 0.5) * lw * 0.3);
          ctx.stroke();
        }
      }
      // 5. 炭筆的擦抹痕：邊緣會暈開一點
      if (charcoal) {
        ctx.lineCap = 'round';
        ctx.globalAlpha = alpha * 0.06;
        ctx.strokeStyle = '#000';
        for (let i = 0; i < 6; i++) {
          const [tx, ty] = normalAt(pts, Math.floor(rnd() * n));
          ctx.lineWidth = lw * (0.5 + rnd() * 0.8);
          const p = pts[Math.floor(rnd() * n)];
          ctx.beginPath();
          ctx.moveTo(p.x + tx * lw * 0.9, p.y + ty * lw * 0.9);
          ctx.lineTo(p.x + tx * lw * (0.9 + rnd()), p.y + ty * lw * (0.9 + rnd()));
          ctx.stroke();
        }
      }
      // 6. 重壓處
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

    /* --- 燙金筆 --- */
    if (tool === 'goldpen') {
      // 燙金筆：像拿金箔／金屬漆在紙上壓過，有立體金屬高光與閃亮金粉（每幀重新閃爍）
      const [cr, cg, cb] = hexToRgb(color);
      const flick = state.t;
      const key = color + ':' + seed;
      const path = new Path2D();
      if (n < 3) {
        path.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
      } else {
        smoothPath(path, pts);
      }
      // 1. 壓在紙上的暗邊（讓金線「浮」起來）
      ctx.save();
      ctx.strokeStyle = 'rgba(40, 24, 4, 0.55)';
      ctx.lineWidth = lw * 1.25;
      ctx.globalAlpha = alpha * 0.5;
      ctx.save();
      ctx.translate(lw * 0.08, lw * 0.1);
      ctx.stroke(path);
      ctx.restore();
      // 2. 金屬底：斜向金箔漸層
      const g = ctx.createLinearGradient(
        pts[0].x - lw, pts[0].y - lw,
        pts[n - 1].x + lw, pts[n - 1].y + lw
      );
      g.addColorStop(0, `rgba(${mixHex(color, '#fff6c8', 0.55)},${alpha})`);
      g.addColorStop(0.25, `rgba(${mixHex(color, '#c8901e', 0.35)},${alpha})`);
      g.addColorStop(0.5, `rgba(${mixHex(color, '#fffbe0', 0.75)},${alpha})`);
      g.addColorStop(0.72, `rgba(${mixHex(color, '#8a5a10', 0.3)},${alpha})`);
      g.addColorStop(1, `rgba(${mixHex(color, '#ffe9a0', 0.65)},${alpha})`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.strokeStyle = g;
      ctx.lineWidth = lw;
      ctx.stroke(path);
      if (n < 3) ctx.fill(path);
      // 3. 中心的一道白光（凸面反射）
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = '#fff8dc';
      ctx.lineWidth = Math.max(0.5, lw * 0.22);
      ctx.stroke(path);
      // 4. 右上角的一道窄高光
      ctx.globalAlpha = alpha * 0.3;
      ctx.translate(-lw * 0.16, -lw * 0.16);
      ctx.stroke(path);
      ctx.translate(lw * 0.16, lw * 0.16);
      ctx.globalCompositeOperation = 'source-over';
      // 5. 金粉亮點：每幀閃爍，沿著筆畫撒金箔
      const dust = clamp(Math.round((n + pathLength(pts)) / 26), 3, 60);
      const rndGold = mulberry32(hashStr(key));
      for (let i = 0; i < dust; i++) {
        const p = pts[Math.floor(rndGold() * n)];
        const [tx, ty] = normalAt(pts, Math.floor(rndGold() * n));
        const off = (rndGold() - 0.5) * lw * 0.85;
        const x = p.x + tx * off;
        const y = p.y + ty * off;
        const tw = 0.55 + 0.45 * Math.sin(flick * (3 + rndGold() * 4) + rndGold() * 6.28);
        const r = lw * (0.07 + rndGold() * 0.09) * (0.7 + tw * 0.6);
        const gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        gg.addColorStop(0, `rgba(255, 255, 240, ${alpha * tw})`);
        gg.addColorStop(0.5, `rgba(255, 214, 120, ${alpha * tw * 0.55})`);
        gg.addColorStop(1, 'rgba(255, 200, 90, 0)');
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(x, y, r * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      void cr; void cg; void cb;
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
    // 只在尺寸真的改變時才重設：canvas.width 一旦被寫入，即使數字相同，
    // 部分瀏覽器（尤其 headless Chromium）也會把畫布內容清掉
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
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
    const sameSize = state.render && state.render.W === W && state.render.H === H && state.render.dpr === dpr;
    state.render = { dpr, W, H, rad, pad: getPad(rad), cssW: w, cssH: h, live: state.render.live };
    if (!sameSize || !ctxInk) {
      // 重設畫布尺寸會清空內容：進行中的筆先收好，重畫時才不會消失
      const live = draw.active && draw.stroke;
      if (live && draw.stroke.points && draw.stroke.points.length < 2) {
        draw.stroke.points.push({ x: draw.stroke.points[0].x + 0.0006, y: draw.stroke.points[0].y + 0.0006 });
      }
      ctxPaper = sizeLayer(els.paperCanvas, W, H, dpr);
      ctxSoft = sizeLayer(els.fxSoft, W, H, dpr);
      ctxFx = sizeLayer(els.fxCanvas, W, H, dpr);
      ctxInk = sizeLayer(els.inkCanvas, W, H, dpr);
    } else {
      // 尺寸沒變就只重設轉換，不要重設 canvas.width（那會把整張畫布清掉）
      for (const c of [ctxPaper, ctxSoft, ctxFx, ctxInk]) c && c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
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
    // 每完成一整輪重畫，都要把繪圖狀態歸零，下一個筆畫才不會被殘留的濾鏡 / 透明度影響
    resetPaintCtxOnce();
    for (const st of state.strokes) {
      const { cssW, cssH } = state.render;
      const px = st.points.map((p) => ({ x: p.x * cssW, y: p.y * cssH }));
      paintStroke(ctxInk, px, st.tool, st.color, st.size, st.alpha, strokeSeed(st.id));
    }
    for (const l2 of liveBuf.values()) if (l2 !== exceptLive) paintLive(l2);
  }

  let ctxResetNeeded = false;
  function resetPaintCtxOnce() {
    if (!ctxResetNeeded) return;
    ctxResetNeeded = false;
    resetPaintCtx();
  }

  /** 紙上有燙金筆的線條嗎？（金粉會隨時間閃爍，需要每幀重畫） */
  function hasShimmer() {
    if (state.shimmer === undefined || state.shimmerDirty) {
      state.shimmer = state.strokes.some((s) => s.tool === 'goldpen');
      state.shimmerDirty = false;
    }
    return state.shimmer;
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
    state.shimmerDirty = true;
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
    // 紙上有燙金筆時要每幀重畫（金粉會閃爍），否則只在有變動時重畫
    if (state.dirty || hasShimmer()) renderInk();
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
      draw.erased = null;
      draw.erasedTouched = false;
      draw.lastErase = null;
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
    if (!stroke) return;
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

  /* ---- 局部擦除：只抹掉筆畫經過的地方，線的其餘部分保留 ---- */

  /**
   * 把一筆切掉橡皮擦掃過的部分。
   * cut 是「本次擦除」的軌跡（CSS 像素），radius 是橡皮擦半徑。
   * 回傳一組新筆畫（可能 0 號 ~ 數段），id 都用 `原id#段號`，方便日後還原。
   */
  function subtractErase(stroke, cut, radius) {
    const { cssW, cssH } = state.render;
    const pts = stroke.points;
    const lw = stroke.size || 3;
    if (!cut.length) return [stroke];
    // 先做粗略包圍盒檢查，擦不到的話直接原樣返回（完全不改動）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cut) { if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x; if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y; }
    const rp = radius + lw / 2 + 2;
    let bHit = false;
    for (const p of pts) {
      const x = p.x * cssW, y = p.y * cssH;
      if (x >= minX - rp && x <= maxX + rp && y >= minY - rp && y <= maxY + rp) { bHit = true; break; }
    }
    if (!bHit) return [stroke];
    const thr = radius + lw * 0.45;
    const thr2 = thr * thr;
    // 沿著筆畫的每一小段取樣，標記被擦到的點
    const removed = new Uint8Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const ax = pts[i].x * cssW, ay = pts[i].y * cssH;
      const bx = (i + 1 < pts.length ? pts[i + 1].x : pts[i].x) * cssW;
      const by = (i + 1 < pts.length ? pts[i + 1].y : pts[i].y) * cssH;
      const segLen = Math.hypot(bx - ax, by - ay);
      const sub = Math.max(1, Math.ceil(segLen / 2));
      for (let k = 0; k <= sub; k++) {
        const t = k / sub;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        for (const c of cut) {
          const dx = x - c.x, dy = y - c.y;
          if (dx * dx + dy * dy <= thr2) { removed[i] = 1; break; }
        }
        if (removed[i]) break;
      }
    }
    if (!removed.some((v) => v === 1)) return [stroke];
    // 把沒被擦到的點收成一段一段
    const segs = [];
    let cur = [];
    for (let i = 0; i < pts.length; i++) {
      if (!removed[i]) { cur.push(pts[i]); continue; }
      if (cur.length >= 1) segs.push(cur);
      cur = [];
    }
    if (cur.length) segs.push(cur);
    const out = [];
    segs.forEach((seg, idx) => {
      const copy = { ...stroke, points: seg, id: `${stroke.id}#${idx}` };
      if (seg.length < 2) {
        // 只留下一個點：畫成小圓點，保留原本的筆觸感
        copy.points = [{ ...seg[0] }, { x: seg[0].x + 0.0006, y: seg[0].y + 0.0006 }];
      }
      out.push(copy);
    });
    return out;
  }

  function eraseHits(p) {
    // 只有自己畫的筆跡才擦得掉
    const mine = [];
    for (const s of state.strokes) if (s.by === state.self.id) mine.push(s);
    if (!mine.length) return;
    // 擦除軌跡（從上一次位置到現在，避免兩點之間有間隙漏擦）
    const prev = draw.lastErase || p;
    draw.lastErase = p;
    const { cssW, cssH } = state.render;
    const cut = [];
    const ax = prev.x * cssW, ay = prev.y * cssH, bx = p.x * cssW, by = p.y * cssH;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let i = 0; i <= steps; i++) cut.push({ x: ax + (bx - ax) * i / steps, y: ay + (by - ay) * i / steps });
    const radius = (draw.stroke ? draw.stroke.size : currentStyle().size) / 2;
    let changed = false;
    const next = [];
    for (const st of state.strokes) {
      if (st.by !== state.self.id) { next.push(st); continue; }
      const parts = subtractErase(st, cut, radius);
      if (parts.length !== 1 || parts[0] !== st) changed = true;
      next.push(...parts);
    }
    if (!changed) return;
    state.strokes = next;
    draw.erasedTouched = true;
    updateProgress();
  }

  function endStroke() {
    if (!draw.active) return;
    const stroke = draw.stroke;
    draw.active = false;
    draw.stroke = null;
    draw.startedAt = 0;

    if (draw.tool === 'eraser') {
      liveBuf.delete(stroke.id);
      clearFxLive();
      draw.lastErase = null;
      state.dirty = true;
      if (!draw.erasedTouched) return;
      draw.erasedTouched = false;
      // 同步給房間：送出「我自己的筆畫現在長這樣」（別人的筆畫不受影響）
      const mine = state.strokes.filter((s) => s.by === state.self.id).map((s) => serializeStroke(s));
      if (state.room && state.conn.status === 'online') wsSend('sync-mine', { strokes: mine });
      else { /* 離線時不需要同步 */ }
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
      // 正在畫的時候，第二根手指不要插進來亂
      if (draw.active) return;
      if (state.selection.ids) {
        if (state.selection.moving && elAt(e) !== ink) return; // 交給搬移處理
        hideSelection();
        if (elAt(e) !== ink) return;
      }
      e.preventDefault();
      hideLanding();
      capturePointer(ink, e.pointerId);
      draw.pointerId = e.pointerId;
      draw.startedAt = performance.now();
      const p = toNorm(e);
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') ensureSizeForTouch();
      startStroke(p);
      sendCursor(p, true);
    });

    const move = (e) => {
      const p = toNorm(e);
      if (draw.active && draw.startedAt && performance.now() - draw.startedAt > 1500 && draw.stroke && draw.stroke.points && draw.stroke.points.length < 2) {
        // 按住太久卻沒有移動：視為放棄這一筆，避免繪圖狀態卡住
        endStroke();
        draw.pointerId = null;
      }
      if (!draw.active) {
        setEdgeMotion(p);
        state.lastPointer = p;
        sendCursor(p, false);
        return;
      }
      // 進行中卻沒有筆畫物件（例如剛按過重置）：直接收掉這一筆
      if (!draw.stroke) {
        draw.active = false;
        draw.pointerId = null;
        sendCursor(p, false);
        return;
      }
      // 第一根手指開始畫之後，其他指標的移動一律忽略
      if (draw.pointerId !== null && draw.pointerId !== e.pointerId) return;
      // 只有「真的由瀏覽器產生的同一個指標」才展開合併事件；合成事件沒有座標，不能用
      let events = [e];
      if (e.getCoalescedEvents && e.isTrusted) {
        try {
          const list = e.getCoalescedEvents();
          if (list && list.length) events = list;
        } catch { /* 忽略 */ }
      }
      for (const ev of events) {
        try { addPoint(toNorm(ev)); } catch (err) { console.error('addPoint 失敗', err); clearActiveStroke(); break; }
      }
      setEdgeMotion(p);
      sendCursor(p, false);
    };
    ink.addEventListener('pointermove', move);
    window.addEventListener('pointermove', (e) => {
      if (e.target === ink) return;
      if (state.lastPointer) sendCursor(toNorm(e), false);
    });

    const up = (e) => {
      // 放手時只要還在畫就結束這一筆；不要用 pointerId 比對，
      // 否則某些裝置 / 事件的 id 對不上時，整筆就會一直被當成「進行中」而消失。
      if (!draw.active) return;
      try {
        endStroke();
      } catch (err) {
        console.error('結束筆畫時發生錯誤', err);
        clearActiveStroke();
      }
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

  let connLabelKey = null;
  let connLabelVars = null;
  function updateConnUI() {
    const s = state.conn.status;
    els.connDot.parentElement.classList.toggle('online', s === 'online');
    // 記住目前的狀態對應哪一個字典 key，語言切換時才能重新翻譯
    let key = 'mode.offline';
    let vars = null;
    if (s === 'online' && state.room) {
      key = 'mode.online';
      els.roomIdLabel.hidden = false;
      els.roomIdLabel.textContent = state.room.code;
      els.copyLinkBtn.hidden = false;
    } else if (s === 'connecting') {
      if (state.room) key = 'mode.reconnecting';
      else if (state.conn.joining) { key = 'mode.joining'; vars = { code: state.conn.joining }; }
      else key = 'mode.connecting';
      els.roomIdLabel.hidden = !state.room;
    } else {
      key = state.room ? 'mode.dropped' : (HAS_BACKEND ? 'mode.offline' : 'mode.single');
      els.roomIdLabel.hidden = true;
      els.copyLinkBtn.hidden = true;
    }
    connLabelKey = key;
    connLabelVars = vars;
    els.roomLabel.dataset.i18n = key;
    els.roomLabel.textContent = $I(key, vars);
    // 登入後的回呼（例如建立房間的按鈕會等到連線成功才顯示結果）
    if (s === 'online' || s === 'offline') fireConnReady();
    renderRoomCard();
  }

  /* ---- 連線完成回呼：createRoomFlow / joinRoom 用「等連線成功」而不是固定等待 ---- */
  let readyWaiters = [];
  function fireConnReady() {
    if (!readyWaiters.length) return;
    const cbs = readyWaiters;
    readyWaiters = [];
    const ok = state.conn.status === 'online';
    for (const cb of cbs) { try { cb(ok, null); } catch (e) { console.warn(e); } }
  }
  function waitForConnection(timeout = 6000) {
    return new Promise((resolve) => {
      if (state.conn.status === 'online') return resolve(true);
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); readyWaiters = readyWaiters.filter((c) => c !== cb); resolve(ok); };
      const cb = (ok) => finish(ok);
      readyWaiters.push(cb);
      const timer = setTimeout(() => finish(false), timeout);
    });
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
      case 'cleared':
        state.strokes = [];
        state.undone = [];
        state.dirty = true;
        updateProgress();
        hideSelection();
        toast(isEN() ? `${msg.name || 'Partner'} reset this sheet` : `${msg.name || '夥伴'} 重置了這張色紙`);
        break;
      case 'erased': {
        const set = new Set(msg.ids);
        state.strokes = state.strokes.filter((s) => !set.has(s.id));
        state.dirty = true;
        updateProgress();
        break;
      }
      case 'sync-mine': {
        if (!msg.by || msg.by === state.self.id) break;
        // 某個夥伴擦掉了自己一部分：只替換他的筆畫，其他人的原樣保留
        const others = state.strokes.filter((s) => s.by !== msg.by);
        const mine = (msg.strokes || []).map(deserializeStroke);
        state.strokes = others.concat(mine);
        state.dirty = true;
        state.shimmerDirty = true;
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
        toast($I('toast.sentTo', { name: msg.toName }), { gold: true });
        break;
      case 'exchange-accepted':
        toast(isEN() ? `${msg.name} accepted your paper 🎉` : `${msg.name} 收下了你的色紙 🎉`, { gold: true });
        systemChat(`${msg.name} 收下了交換的色紙`);
        break;
      case 'exchange-declined':
        toast($I('toast.declinedBy', { name: msg.name }));
        break;
      case 'exchange-cancelled':
        toast($I('toast.cancelledBy', { name: msg.name }));
        if (els.incomingModal.hidden === false) closeModal('incomingModal');
        break;
      case 'gallery-saved':
        toast($I('toast.gallerySaved', { n: msg.items.length }), { gold: true });
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
    if (msg.isNew) toast($I('toast.roomNew', { code: msg.room.code }), { gold: true });
    else toast($I('toast.roomJoined', { code: msg.room.code }));
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
    if (els.themeLabel) els.themeLabel.textContent = t === 'dark' ? $I('theme.dark') : $I('theme.light');
    if (els.themeBtn) els.themeBtn.title = t === 'dark' ? $I('theme.toLight') : $I('theme.toDark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#17151c' : '#f4ede2');
    if (save) STORE.set('theme', t);
  }
  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    toast(next === 'dark' ? '🌙 已切換到深色模式' : '☀️ 已切換到淺色模式', { key: next === 'dark' ? 'toast.themeDark' : 'toast.themeLight' });
    // 紙邊的柔光跟紙張本身不變，但外框陰影要跟著調整
    state.sparkDirty = true;
  }

  function saveSelf() {
    STORE.set('self', { id: state.self.id, name: state.self.name, color: state.self.color });
  }

  /* ---- 左側：色紙 ---- */
  function renderPaperGrid() {
    els.paperGrid.innerHTML = '';
    // 只使用白紙：不再提供其他顏色的色紙
    const p = paperOf(state.paper.bg);
    if (p) {
      const b = document.createElement('button');
      b.className = 'paper-chip' + ' active';
      b.style.setProperty('--c1', p.c1);
      b.style.setProperty('--c2', p.c2);
      b.dataset.id = p.id;
      b.dataset.edge = state.paper.edge;
      b.title = $I('paper.white');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', p.name);
      b.innerHTML = `<span class="sheet"></span>` + (state.paper.edge !== 'plain'
        ? `<span class="flag" title="${escapeHtml($I(state.paper.edge === 'gold' ? 'edge.gold' : 'edge.laser'))}">${state.paper.edge === 'gold' ? 'Au' : 'Holo'}</span>`
        : '');
      els.paperGrid.appendChild(b);
    }
    $('.paper-chip-label')?.remove();
    const lbl = document.createElement('p');
    lbl.className = 'paper-chip-label';
    lbl.textContent = `${$I('paper.white')} · ${PAPER_SIZES[state.paper.size].label}`;
    els.paperGrid.appendChild(lbl);
  }

  function selectEdge(edge) {
    state.paper.edge = edge;
    $$('.paper-chip').forEach((el) => {
      el.dataset.edge = edge;
      const flag = el.querySelector('.flag');
      if (flag) flag.textContent = edge === 'gold' ? 'Au' : 'Holo';
    });
    $$('.edge-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.edge === edge)));
    els.hueRow.hidden = edge !== 'laser';
    els.hueShiftBtn.textContent = state.hueShifting ? $I('edge.stop') : $I('edge.flow');
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
    if (changed) layout();
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
      els.hueShiftBtn.textContent = state.hueShifting ? $I('edge.stop') : $I('edge.flow');
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
    els.alphaInput.disabled = tool === 'eraser' || tool === 'goldpen';
    els.alphaInput.title = tool === 'goldpen' ? '燙金筆是金屬漆，固定不透明' : '';
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

  /* ---- 自選顏色 ---- */
  let pickerHex = '#000000';
  function refreshPicker(hex) {
    pickerHex = hex;
    els.pickerPreview.style.background = hex;
    els.pickerPreview.style.setProperty('--c', hex);
    els.pickerName.textContent = colorName(hex);
    els.pickerHex.textContent = hex.toUpperCase();
    els.pickerHexInput.value = hex.toUpperCase();
    els.pickerNative.value = hex;
    $$('.swatch').forEach((el) => el.classList.toggle('active', el.dataset.color === hex));
  }
  function openColorPicker() {
    const start = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color.toLowerCase() : '#000000';
    refreshPicker(start);
    els.pickerPresets.innerHTML = '';
    for (const c of SWATCHES.concat(['#e8c269', '#d4af37', '#f0c55a', '#b8860b'])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = c;
      b.title = colorName(c) + ' ' + c;
      b.addEventListener('click', () => refreshPicker(c));
      els.pickerPresets.appendChild(b);
    }
    openModal('pickerModal');
    setTimeout(() => els.pickerHexInput.select(), 60);
  }
  function applyPickedColor() {
    const typed = normalizeHex(els.pickerHexInput.value);
    const hex = typed || normalizeHex(pickerHex) || '#000000';
    setColor(hex);
    closeModal('pickerModal');
    toast($I('toast.picked', { name: colorName(hex), hex: hex.toUpperCase() }));
  }
  function bindColorPicker() {
    els.pickerBtn.addEventListener('click', openColorPicker);
    els.pickerHexInput.addEventListener('input', () => {
      const v = els.pickerHexInput.value.trim();
      els.pickerHexInput.classList.toggle('invalid', !!v && !normalizeHex(v));
      const hex = normalizeHex(v);
      if (hex) refreshPicker(hex);
    });
    els.pickerHexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyPickedColor(); }
    });
    els.pickerNative.addEventListener('input', () => refreshPicker(els.pickerNative.value));
    els.pickerApply.addEventListener('click', applyPickedColor);
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
    bindColorPicker();
    els.colorWellFill.parentElement.addEventListener('click', (e) => {
      // 點色塊本身除了開系統調色盤，也順便記住「自選」是按鈕流程
      void e;
    });
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
    const keys = { pencil: '1', watercolor: '2', highlight: '3', pen: '4', goldpen: '6', eraser: '5' };
    const keyOfTool = { pencil: 'tool.pencil', watercolor: 'tool.watercolor', highlight: 'tool.highlight', pen: 'tool.pen', goldpen: 'tool.goldpen', eraser: 'tool.eraser' };
    const refreshToolTitles = () => {
      $$('.tool').forEach((el) => {
        el.setAttribute('title', $I('title.tool', { name: $I(keyOfTool[el.dataset.tool]), n: keys[el.dataset.tool] }));
      });
    };
    refreshToolTitles();
    document.addEventListener('cp:langchange', refreshToolTitles);
    $$('.tool').forEach((el) => {
      const k = document.createElement('kbd');
      k.textContent = keys[el.dataset.tool];
      el.appendChild(k);
    });
  }

  function updateProgress() {
    const n = state.strokes.length;
    els.progressText.textContent = isEN() ? `${n} stroke${n === 1 ? '' : 's'}` : `${n} 筆`;
    const pct = clamp(Math.round((n % 40) / 40 * 100) + (n >= 40 ? 100 : 0), 0, 100);
    els.progressBar.style.width = Math.min(100, Math.max(2, pct)) + '%';
    updateUndoButtons();
  }

  function updateUndoButtons() {
    const mine = state.strokes.some((s) => s.by === state.self.id);
    // 剛剛按過重置時，「復原」要能把重置前的畫救回來
    const canUndoReset = !!(state.lastReset && state.lastReset.length && state.strokes.length === 0);
    els.undoBtn.disabled = !mine && !canUndoReset;
    els.undoBtn.title = canUndoReset ? $I('title.undoReset') : $I('title.undo');
    els.redoBtn.disabled = !state.undone.length;
  }

  /* ---- 復原 / 重做 / 清空 ---- */
  function undo() {
    // 剛剛按過「重置」→ 先把重置前的畫還原
    if (state.lastReset && state.lastReset.length && state.strokes.length === 0) {
      const restored = state.lastReset;
      state.lastReset = null;
      state.strokes = restored;
      state.dirty = true;
      state.shimmerDirty = true;
      updateProgress();
      renderInk();
      toast('已還原重置前的畫');
      return;
    }
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
    els.selBar.innerHTML = `<span>${isEN() ? 'Selected' : '已選取'} <b>${ids.length}</b> ${isEN() ? 'stroke(s)' : '筆'}</span>
      <button class="btn btn-sm" id="selMoveBtn">${escapeHtml($I('select.move'))}</button>
      <button class="btn btn-ghost btn-sm" id="selCancelBtn">${escapeHtml($I('modal.cancel'))}</button>`;
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
    if (moveBtn) moveBtn.textContent = $I('select.move');
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
      els.roomCardTitle.textContent = isEN() ? `Two-person room ${state.room.code}` : `雙人房間 ${state.room.code}`;
      els.roomCardDesc.textContent = count >= 2
        ? $I('room.bothHere')
        : $I('room.onlyYou', { n: count, code: state.room.code });
      if (els.twoPersonNote) {
        els.twoPersonNote.textContent = count >= 2 ? $I('room.full') : $I('room.lock');
      }
      els.roomForm.hidden = true;
      els.roomActions.hidden = false;
      els.roomShare.hidden = false;
      els.shareLinkInput.value = shareUrl(state.room.code);
    } else {
      els.roomCardTitle.textContent = state.room ? $I('mode.reconnecting') : $I('room.title');
      els.roomCardDesc.textContent = state.room
        ? $I('room.reconnecting')
        : HAS_BACKEND
          ? $I('room.desc')
          : $I('toast.staticHost');
      els.roomForm.hidden = false;
      els.roomActions.hidden = true;
      els.roomShare.hidden = true;
    }
  }

  function bindRoom() {
    els.joinBtn.addEventListener('click', () => { state.pendingIntent = 'join'; joinFromInput(); });
    els.joinCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); joinFromInput(); }
    });
    els.landingRoom.addEventListener('click', () => { state.pendingIntent = 'create'; openJoinModal(); });
    els.landingNew.addEventListener('click', () => hideLanding());
    els.copyCodeBtn.addEventListener('click', async () => {
      if (!state.room) return;
      const ok = await copyText(state.room.code);
      if (ok) toast($I('toast.copiedCode', { code: state.room.code }), { key: 'toast.copiedCode', vars: { code: state.room.code } });
      else toast('複製失敗，請手動記下房間號', { key: 'toast.copyFail' });
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
    els.createRoomBtn.addEventListener('click', async () => {
      // 純靜態版（GitHub Pages）沒有伺服器可以開房間，先清楚告訴使用者
      if (!HAS_BACKEND) { backendMissing(); return; }
      // 暱稱視窗還開著：使用者應該先在視窗裡確認，不要在背後又開一間房
      if (!els.joinModal.hidden) return;
      if (state.room) {
        if (!confirm('你已經在房間裡了，要離開並建立新的雙人房間嗎？')) return;
        if (state.conn.status === 'online') {
          wsSend('leave-room');
          await new Promise((r) => setTimeout(r, 250));
        } else {
          onLeftRoom();
        }
      }
      state.pendingJoin = '';
      createRoomFlow();
    });
    els.joinCodeInput.addEventListener('input', () => {
      els.joinCodeInput.value = els.joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    if (els.chatJoinBtn) els.chatJoinBtn.addEventListener('click', () => { state.pendingIntent = 'join'; openJoinModal(); });
    els.fitBtn.addEventListener('click', () => resetCanvas());
    els.nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromModal(); });
    els.joinCodeInput2.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromModal(); });
  }

  /**
   * 把繪圖相關的 canvas 狀態（濾鏡、透明度、裁切、混色、虛線、陰影…）全部歸零。
   * 任何一個漏掉都會讓「之後畫的筆」看起來完全沒反應（例如淡到看不見、被裁掉、陰影蓋住）。
   * 注意：不能用 canvas.width = width 來重設，那會把畫布內容一起清掉。
   */
  function resetPaintCtx() {
    const dpr = state.render.dpr || 1;
    for (const c of [ctxPaper, ctxSoft, ctxFx, ctxInk]) {
      if (!c) continue;
      try {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.filter = 'none';
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
        c.shadowBlur = 0;
        c.shadowColor = 'rgba(0,0,0,0)';
        c.shadowOffsetX = 0;
        c.shadowOffsetY = 0;
        c.setLineDash([]);
        c.lineDashOffset = 0;
        c.lineWidth = 1;
        c.lineCap = 'butt';
        c.lineJoin = 'miter';
        c.miterLimit = 10;
        c.lineDashOffset = 0;
        c.beginPath();
        c.rect(0, 0, c.canvas.width, c.canvas.height);
        c.clip();
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.globalAlpha = 1;
      } catch (e) {
        console.warn('resetPaintCtx', e);
      }
    }
  }

  /** 把「進行中」的繪畫狀態徹底歸零（重置、離開頁面前都要做，否則之後的指標事件會接到已失效的物件） */
  function clearActiveStroke() {
    if (!draw.active && !draw.stroke) return;
    liveBuf.clear();
    draw.active = false;
    draw.stroke = null;
    draw.pointerId = null;
    draw.tool = null;
    draw.erased = null;
    draw.erasedTouched = false;
    draw.lastErase = null;
    draw.last = null;
    draw.startedAt = 0;
    state.dirty = true;
    if (ctxFx) renderFx(state.t);
  }

  /** 只要橡皮擦可以擦除自己的筆畫，就不會影響其他人的圖層 */
  function refreshEraserCursor() {
    els.inkCanvas.style.cursor = state.tool === 'eraser' ? 'cell' : 'crosshair';
  }

  /** 重置：清空畫布上所有筆跡、把選取 / 搬移等狀態歸零，工具列立刻可以再畫 */
  function resetCanvas() {
    const n = state.strokes.length;
    if (n && !confirm(`要把這張色紙上的 ${n} 筆全部清掉，重新開始嗎？`)) return;
    // 中斷進行中的繪畫 / 搬移 / 框選
    clearActiveStroke();
    state.selection.ids = null;
    state.selection.moving = false;
    state.selection.start = null;
    els.selBar.classList.remove('show');
    // 重置前的畫保留起來，誤按時可以用「復原」救回來
    state.lastReset = state.strokes.slice();
    state.strokes = [];
    state.undone = [];
    state.pending = [];
    state.dirty = true;
    resetPaintCtx();
    // 立刻把畫布重畫成空白（不等下一幀），避免重畫前又被復原填回舊圖層
    renderInk();
    hideSelection();
    refreshEraserCursor();
    updateProgress();
    updateUndoButtons();
    // 通知房間裡的人一起清空
    if (state.room && state.conn.status === 'online') wsSend('clear-all');
    else state.pending.push({ t: 'clear-all', body: {} });
    layout();
    hideLanding();
    toast('已重置畫布，可以重新開始了');
  }

  /** 暱稱視窗開著時，鎖住背後的「建立雙人房間」按鈕，避免重複開房 / 被誤按 */
  function lockCreateButtons(locked) {
    const btn = document.getElementById('createRoomBtn');
    if (!btn) return;
    btn.disabled = locked;
    btn.title = locked ? '請先在視窗中輸入暱稱' : '';
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
    state.pendingIntent = 'join';
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
    // 使用者按的是「建立雙人房間」還是「加入」？確認暱稱後照原本的意圖做
    // 有指定房間號就是「加入」；否則依呼叫端設定的意圖（建立房間 / 加入），預設「建立房間」
    state.pendingIntent = state.pendingJoin ? 'join' : (state.pendingIntent || 'create');
    els.nickInput.value = state.self.name || STORE.get('nick', '');
    els.joinCodeInput2.value = state.pendingJoin;
    els.joinCodeField.hidden = !state.pendingJoin;
    $('#joinTitle').textContent = state.pendingJoin
      ? (isEN() ? `Join room ${state.pendingJoin}` : `加入房間 ${state.pendingJoin}`)
      : $I('modal.join.title');
    renderJoinModalError();
    openModal('joinModal');
    lockCreateButtons(true);
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
    const intent = state.pendingIntent || (code ? 'join' : 'create');
    state.pendingJoin = '';
    state.pendingIntent = '';
    closeModal('joinModal');
    lockCreateButtons(false);
    if (code) joinRoom(code);
    else if (intent === 'create') createRoomFlow(state.self.name);
    else openJoinModal();
  }

  function createRoomFlow(confirmedName) {
    if (!HAS_BACKEND) { backendMissing(); return; }
    // 點擊的當下就核對暱稱，而不是等 async 之後才檢查（避免「先開一間、回來又開一間」）
    const name = String(confirmedName || '').trim() || String(state.self.name || '').trim();
    if (!name) {
      state.pendingIntent = 'create';
      openJoinModal();
      return;
    }
    state.self.name = name.slice(0, 16);
    STORE.set('nick', state.self.name);
    saveSelf();
    state.pendingJoin = '';
    state.conn.joining = 'new';
    els.landingNote.textContent = $I('landing.creating');
    connect({ createRoom: true });
    // 等到真的加入房間（joined）才關掉落地頁
    waitForConnection().then((ok) => {
      els.landingNote.textContent = '';
      if (ok) hideLanding();
      else { toast($I('toast.noServer'), { key: 'toast.noServer' }); els.landingNote.textContent = ''; }
    });
  }

  function joinRoom(code) {
    if (!HAS_BACKEND) { backendMissing(); return; }
    if (!state.self.name) { state.pendingIntent = 'join'; openJoinModal(code); return; }
    hideLanding();
    state.conn.joining = code;
    els.roomLabel.textContent = $I('mode.joining', { code });
    connect({ joinCode: code });
    waitForConnection().then((ok) => {
      if (!ok) toast($I('toast.noServer'), { key: 'toast.noServer' });
    });
  }

  function checkRoomInUrl() {
    return ROOM_FROM_URL || null;
  }

  /* ---- 夥伴列表 ---- */
  function renderPeople() {
    const list = els.peopleList;
    list.innerHTML = '';
    const online = !!state.room && state.conn.status === 'online';
    els.peerCount.textContent = online ? String(state.others.size + 1) : String(1);
    const selfLi = personLi({ id: state.self.id, name: state.self.name || $I('room.you'), color: state.self.color, strokeCount: state.strokes.filter((s) => s.by === state.self.id).length, online: true, self: true });
    list.appendChild(selfLi);
    if (online) {
      const sorted = [...state.others.values()].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      for (const m of sorted) {
        const p = personLi({ ...m, self: false });
        if (m.online) {
          const gift = document.createElement('button');
          gift.className = 'gift';
          gift.textContent = $I('room.gift');
          gift.addEventListener('click', () => openExchange(m.id));
          p.appendChild(gift);
        }
        list.appendChild(p);
      }
    } else {
      const li = document.createElement('li');
      li.className = 'person';
      li.innerHTML = `<div class="avatar" style="background:#444">+</div><div class="who"><b>${escapeHtml($I('room.invite'))}</b><small>${escapeHtml($I('room.invite.desc'))}</small></div>`;
      list.appendChild(li);
    }
    renderExchangePeople();
    renderIncoming();
  }

  function personLi(m) {
    const li = document.createElement('li');
    li.className = 'person';
    const name = m.name || $I('gallery.untitled');
    const total = state.strokes.length || 1;
    const pct = m.self ? Math.round((state.strokes.filter((s) => s.by === state.self.id).length / total) * 100) : Math.round(((m.strokeCount || 0) / total) * 100);
    li.innerHTML = `
      <div class="avatar" style="background:${m.color}">${initial(name)}</div>
      <div class="who">
        <b>${escapeHtml(name)}${m.self ? escapeHtml($I('room.person.self')) : ''}</b>
        <small>${m.online ? escapeHtml($I('room.person.online')) : escapeHtml($I('room.person.away'))}${!m.self ? escapeHtml(' · ' + $I('room.person.strokes', { pct })) : ''}</small>
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
  function rebuildChatLog() {
    if (!els.chatLog) return;
    const log = els.chatLog;
    log.innerHTML = '';
    els.chatEmpty.hidden = chatItems.length > 0;
    for (const msg of chatItems) {
      const el = document.createElement('div');
      if (msg.kind === 'sys') {
        el.className = 'msg system';
        el.innerHTML = `<div class="bubble">${escapeHtml(tMsg(msg.text || ''))}</div>`;
      } else {
        el.className = 'msg' + (msg.by === state.self.id ? ' mine' : '');
        el.innerHTML = `<div class="avatar" style="background:${msg.color || '#999'}">${initial(msg.name)}</div>
          <div class="bubble-wrap"><div class="meta">${escapeHtml(msg.name || '')} · ${timeStr(msg.ts)}</div><div class="bubble">${escapeHtml(msg.text)}</div></div>`;
      }
      log.appendChild(el);
    }
    if (!chatItems.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = $I('chat.empty');
      log.appendChild(empty);
      els.chatEmpty = empty;
    }
    scrollChat();
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
      els.galleryDesc.innerHTML = $I('gallery.pickGift', { name: escapeHtml(state.offerTo.name) });
      els.galleryDesc.dataset.offer = '1';
    } else if (els.galleryDesc.dataset.offer) {
      els.galleryDesc.textContent = $I('gallery.desc');
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
        <div class="g-thumb" title="${escapeHtml($I('gallery.download'))}">
          <img alt="${escapeHtml(it.title)}" src="${it.image}" />
          <span class="tag ${from ? 'from' : ''}">${from ? '🎁 ' + escapeHtml(from) : escapeHtml($I('gallery.mine'))}</span>
        </div>
        <p class="g-name">${escapeHtml(it.title)}</p>
        <p class="g-by">${escapeHtml(it.by)} · ${new Date(it.ts).toLocaleDateString(isEN() ? 'en-GB' : 'zh-HK')}</p>
        <button class="g-del" title="${escapeHtml($I('gallery.delete'))}">✕</button>`;
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
    els.exchangeMeta.textContent = $I('modal.exchange.meta', {
      name: isEN() ? `${state.self.name || 'your'} sheet` : `${paperOf(state.paper.bg).name}《${state.self.name || '你的'}色紙》`,
    });
    els.exchangeSub.textContent = $I('modal.exchange.sub');
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
        <div class="who"><b>${escapeHtml(m.name)}</b><small>${escapeHtml($I('room.person.count', { n: m.strokeCount || 0 }))}</small></div>`;
      li.addEventListener('click', () => {
        state.exchangeTarget = m.id;
        renderExchangePeople();
      });
      els.exchangePeople.appendChild(li);
    }
    els.exchangeSendBtn.disabled = !state.exchangeTarget;
    els.exchangeHint.textContent = list.length ? '' : $I('room.empty');
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
    else toast(isEN() ? `${req.fromName} wants to trade paper 🎁` : `${req.fromName} 想和你交換色紙 🎁`, { gold: true });
    const overlay = state.room && state.conn.status === 'online';
    // 視窗沒開著、而且目前只有這一則請求時，直接跳出來給對方看
    const modalEl = document.getElementById('incomingModal');
    const modalOpen = modalEl && !modalEl.hidden;
    if (overlay && !modalOpen && state.incoming.size === 1) openIncomingModal(req.id);
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
    els.incomingTitle.textContent = isEN()
      ? `${req.fromName} wants to trade paper`
      : `${req.fromName} 想和你交換色紙`;
    els.incomingBody.innerHTML = `
      <div class="offer-card">
        <div class="preview-wrap">${req.fromImage ? `<img alt="paper" src="${req.fromImage}" />` : `<div class="no-preview">${escapeHtml($I('exchange.noPreview'))}</div>`}</div>
        <div class="preview-meta">
          <p><b>${escapeHtml(req.fromName)}</b> ${escapeHtml($I('exchange.sendsYou'))}</p>
          <p class="muted">${escapeHtml($I('exchange.acceptHint'))}</p>
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
      publishToGallery([{ image: req.fromImage, title: isEN() ? `Paper from ${req.fromName}` : `${req.fromName}的交換色紙`, by: req.fromName, from: req.fromName, to: state.self.name }]);
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
      toast($I('toast.noGallery', { name: req.fromName }), { gold: true });
    }
  }

  function sendOffer(to, item) {
    const image = item.image;
    wsSend('exchange-offer', { to, image, title: item.title });
    toast($I('toast.gifted', { title: item.title }), { gold: true });
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
        <div class="preview-wrap">${offer.image ? `<img alt="paper" src="${offer.image}" />` : `<div class="no-preview">${escapeHtml($I('exchange.noPreview'))}</div>`}</div>
        <div class="preview-meta">
          <p><b style="color:${offer.fromColor}">${escapeHtml(offer.fromName)}</b> ${escapeHtml($I('exchange.giftBack'))}<br/><b>《${escapeHtml(offer.title || $I('gallery.untitled'))}》</b></p>
          <p class="muted">${escapeHtml($I('exchange.giftSaved'))}</p>
        </div>
      </div>`;
    els.incomingTitle.textContent = isEN() ? `A return gift from ${offer.fromName}` : `${offer.fromName} 的回禮`;
    els.incomingBody.innerHTML = html;
    els.acceptOfferedBtn.textContent = $I('exchange.acceptGift');
    els.declineOfferedBtn.textContent = $I('modal.close');
    els.acceptOfferedBtn.onclick = async () => {
      await publishToGallery([{ image: offer.image, title: offer.title || $I('exchange.traded'), by: offer.fromName, from: offer.fromName, to: state.self.name }]);
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
      <div class="preview-meta"><p>${escapeHtml(it.from ? $I('exchange.from', { name: it.from }) : $I('exchange.mine'))}</p><p class="muted">${new Date(it.ts).toLocaleString(isEN() ? 'en-GB' : 'zh-HK')}</p></div></div>`;
    els.acceptOfferedBtn.textContent = $I('gallery.download');
    els.declineOfferedBtn.textContent = $I('modal.close');
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
    if (id === 'joinModal') lockCreateButtons(false);
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
      else if (e.key === '6') setTool('goldpen');
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); openColorPicker(); }
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
  // 頁面載入時網址裡的 ?room=（只讀一次；之後就算其他分頁改了網址也不影響這一頁）
  const ROOM_FROM_URL = (() => {
    try {
      const v = new URL(location.href).searchParams.get('room');
      return v && /^[A-Z0-9]{6}$/i.test(v.trim()) ? v.trim().toUpperCase() : '';
    } catch { return ''; }
  })();
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
        // 只在真的不忙的時候重排；重排會重設畫布尺寸，重設尺寸等於是清掉畫布內容
        layout();
        updateRemoteCursors();
      }, 300);
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
    // 這個瀏覽器之前有沒有用過（有暱稱或身分）→ 有就直接沿用，不再每次重問暱稱
    state.self.existed = !!((savedSelf && savedSelf.id) || STORE.get('nick', ''));
    if (savedSelf && savedSelf.id) state.self = { ...state.self, ...savedSelf };
    state.self.name = STORE.get('nick', '') || (savedSelf && savedSelf.name) || '';
    state.self.color = state.self.color || '#9cc3f0';
    const savedPaper = STORE.get('paper', null);
    if (savedPaper && typeof savedPaper === 'object') state.paper = { ...state.paper, ...savedPaper };
    if (!PAPER_SIZES[state.paper.size]) state.paper.size = 'B4';
    state.paper.bg = WHITE_PAPER.id;
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
    sizeRow.innerHTML = `<label style="grid-column:1/-1"><span>${escapeHtml($I('canvas.paperSize'))}</span></label><div class="sizes" style="grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap"></div>`;
    const sizes = sizeRow.querySelector('.sizes');
    for (const [key, v] of Object.entries(PAPER_SIZES)) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm' + (state.paper.size === key ? ' btn-primary' : ' btn-ghost');
      b.dataset.sizeKey = { B4: 'size.B4', A5: 'size.A5', SQ: 'size.SQ', B6: 'size.B6', WL: 'size.WL', L: 'size.L', CD: 'size.CD' }[key] || key;
      b.textContent = $I(b.dataset.sizeKey);
      b.dataset.i18nSizeKey = b.dataset.sizeKey;
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
    // 網址裡的 ?room= 每個「分頁」只在剛開啟時自動加入一次；之後（例如手動輸入其他房號）就不要再自動搶房間。
    // 注意：sessionStorage 在同一瀏覽器的分頁之間是「共用」的，所以不能拿它的旗標當「這個分頁」的標記，
    // 要改用模組變數（每頁各自一份）。
    if (!state.autoJoinDone) {
      state.autoJoinDone = true;
      const roomCode = checkRoomInUrl();
      if (roomCode && /^[A-Z0-9]{6}$/i.test(roomCode)) {
        if (state.self.name) {
          hideLanding();
          setTimeout(() => joinRoom(ROOM_FROM_URL), 120);
        } else if (state.self.existed) {
          // 這個瀏覽器已經用過彩紙屋：直接沿用上次的暱稱進入，不用再問
          hideLanding();
          setTimeout(() => joinRoom(ROOM_FROM_URL), 120);
        } else {
          els.landingNote.textContent = $I('welcome.invite', { code: roomCode.toUpperCase() });
          setTimeout(() => { state.pendingIntent = 'join'; openJoinModal(roomCode.toUpperCase()); }, 300);
        }
      } else {
        els.landingNote.textContent = !HAS_BACKEND
          ? $I('toast.staticHost')
          : state.self.name ? $I('welcome.back', { name: state.self.name }) : $I('welcome.start');
      }
    }

    // 直接開房的簡便入口：網址加 ?new=1
    if (new URL(location.href).searchParams.get('new') === '1' && state.self.name) {
      hideLanding();
      setTimeout(() => createRoomFlow(), 100);
    }
  }

  // 語言切換時重繪所有動態文字
  document.addEventListener('cp:langchange', () => {
    try {
      updateConnUI();
      renderRoomCard();
      renderPeople();
      renderGallery();
      renderIncoming();
      renderPaperGrid();
      applyTheme(getTheme(), { save: false });
      updateProgress();
      updateUndoButtons();
      if (connLabelKey) els.roomLabel.textContent = $I(connLabelKey, connLabelVars);
      $$('.sizes .btn').forEach((b) => { if (b.dataset.i18nSizeKey) b.textContent = $I(b.dataset.i18nSizeKey); });
      els.hueShiftBtn.textContent = state.hueShifting ? $I('edge.stop') : $I('edge.flow');
      if (!landingHidden && els.landingNote) {
        els.landingNote.textContent = state.room || HAS_BACKEND ? '' : $I('toast.staticHost');
      }
      // 聊天紀錄：使用者輸入的內容不翻譯，只重繪系統訊息與時間格式
      rebuildChatLog();
    } catch (err) {
      console.warn('語言切換重繪失敗', err);
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // 初始化完成後，如果目前是英文（或之後被切換），請 site.js 已套用的語言再通知一次，
  // 讓連線狀態等動態文字對到正確語言。
  setTimeout(() => document.dispatchEvent(new CustomEvent('cp:langchange', { detail: { lang: window.CP_I18N ? window.CP_I18N.current() : 'zh' } })), 0);

  // 給自動化測試用的小 API
  window.__coloredPaper = { state, exportPng, renderFx, PAPERS, paintStroke, get ctxInk() { return ctxInk; }, get liveBuf() { return liveBuf; }, get draw() { return draw; }, renderInk };
  // 給 studio.js / site.js 重用的純繪圖函式
  Object.assign(CP_ENGINE, {
    drawEdge, getPaperFill, buildSparks, paintStroke, getPad, resetPaintCtx,
    getSparks: () => state.sparks,
    setSparks: (arr) => { state.sparks = arr; },
    hashStr, mulberry32, mix, hexToRgb, luminance,
  });
})();
