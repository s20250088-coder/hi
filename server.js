#!/usr/bin/env node
/**
 * 彩紙屋 (Color Paper Studio)
 * ------------------------------------------------------------------
 * 零依賴的多使用者色紙彩繪伺服器：
 *   - 靜態檔案服務（index.html / styles.css / app.js）
 *   - 手寫 RFC 6455 WebSocket 實作：房間、線上筆刷同步、游標、聊天室、交換色紙
 *   - 持久化：成品會存到 ./data/gallery.json，重開伺服器仍在
 *
 * 啟動： node server.js  [--port 8787] [--host 0.0.0.0]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(argOf('port', process.env.PORT || 8787));
const HOST = argOf('host', process.env.HOST || '0.0.0.0');

const LIMITS = {
  maxMessage: 9 * 1024 * 1024, // 9MB：剛好可容納 8MB 的色紙快照
  maxSnapshot: 8 * 1024 * 1024,
  maxGallery: 12 * 1024 * 1024,
  maxStroke: 16000,
  maxChat: 400,
  maxPeers: 24,
  chatHistory: 120,
};

/* ----------------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------------- */
const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const clampNum = (v, min, max, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb;
};
const cleanText = (v, n) => clampStr(v, n).replace(/[\u0000-\u0008\u000b-\u001f]/g, '');

const PALETTE = ['#f2a7b5', '#e8c269', '#9fd4b0', '#9cc3f0', '#c9a7f0', '#f5b98b', '#8de0dc', '#f5f0e6', '#2f3542'];
function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return rooms.has(s) ? newRoomCode() : s;
}

/* ----------------------------------------------------------------
 * 持久化展廳
 * ---------------------------------------------------------------- */
let galleryStore = [];
function loadGallery() {
  try {
    const raw = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8'));
    galleryStore = Array.isArray(raw) ? raw.slice(0, 60) : [];
  } catch {
    galleryStore = [];
  }
}
let saveTimer = null;
function saveGallery() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(GALLERY_FILE + '.tmp', JSON.stringify(galleryStore));
      fs.renameSync(GALLERY_FILE + '.tmp', GALLERY_FILE);
    } catch (err) {
      console.error('[彩紙屋] 無法儲存展廳：', err.message);
    }
  }, 400);
}
function galleryId() {
  return 'g' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ----------------------------------------------------------------
 * 線上狀態：房間 / 會員
 * ---------------------------------------------------------------- */
const rooms = new Map(); // code -> room
const members = new Map(); // memberId -> member

const sidOf = (m) => (m.conn ? m.conn.sid : null);

function publicMember(m) {
  return {
    id: m.id,
    name: m.name,
    color: m.color,
    joinedAt: m.joinedAt,
    strokeCount: m.strokeCount,
    online: !!m.conn,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    created: room.created,
    paper: room.paper,
    strokes: room.strokes,
    history: room.history,
    members: [...room.members.values()].map(publicMember),
  };
}

function send(m, msg) {
  if (m && m.conn) m.conn.send(msg);
}
function broadcast(room, msg, exceptSid) {
  const data = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (m.conn && m.conn.sid !== exceptSid) m.conn.sendRaw(data);
  }
}

function systemMessage(room, text) {
  const msg = { kind: 'sys', id: 's' + crypto.randomBytes(4).toString('hex'), text, ts: Date.now() };
  room.history.push(msg);
  if (room.history.length > LIMITS.chatHistory) room.history.shift();
  broadcast(room, { t: 'sys', msg });
}

function joinRoom(member, roomCode, makeNew) {
  let room;
  if (makeNew) {
    const code = newRoomCode();
    room = {
      code,
      created: Date.now(),
      paper: { bg: 'white', edge: member.paper && member.paper.edge ? member.paper.edge : 'gold', hue: member.paper ? member.paper.hue : 210, size: member.paper ? member.paper.size : 'B4' },
      strokes: [],
      history: [],
      members: new Map(),
    };
    rooms.set(code, room);
  } else {
    room = rooms.get(roomCode);
    if (!room) return { error: '找不到這個房間，確認一下房間代碼吧。' };
    if (room.members.size >= LIMITS.maxPeers) return { error: '這間房間已經滿了。' };
  }
  room.members.set(member.id, member);
  member.roomCode = room.code;
  return { room, isNew: !!makeNew };
}

function leaveRoom(member, reason) {
  if (!member.roomCode) return;
  const room = rooms.get(member.roomCode);
  member.roomCode = null;
  if (!room) return;
  room.members.delete(member.id);
  broadcast(room, { t: 'member-left', id: member.id, name: member.name });
  if (reason) systemMessage(room, `${member.name} 離開了房間`);
  if (room.members.size === 0) rooms.delete(room.code);
}

/* ----------------------------------------------------------------
 * WebSocket 實作（RFC 6455，最小可用子集：文字訊息、ping/pong、close）
 * ---------------------------------------------------------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Connection {
  constructor(socket, req) {
    this.socket = socket;
    this.sid = 's' + crypto.randomBytes(6).toString('hex');
    this.member = null;
    this.alive = true;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.url = new URL(req.url, 'http://localhost');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('end', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  sendRaw(data) {
    if (this.closed) return;
    try {
      this.socket.write(frame(Buffer.from(data, 'utf8'), 0x1));
    } catch {
      this.onClose();
    }
  }
  send(obj) {
    this.sendRaw(JSON.stringify(obj));
  }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(frame(payload, 0x8));
      this.socket.end();
    } catch { /* ignore */ }
    this.onClose();
  }
  onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.member && this.member.conn === this) {
      // 斷線時先保留會員與房間位置 60 秒，讓重連 / 重新整理可以回到原位
      const m = this.member;
      m.conn = null;
      if (m.roomCode) {
        const room = rooms.get(m.roomCode);
        if (room) {
          broadcast(room, { t: 'member-left', id: m.id, name: m.name, pending: true });
          systemMessage(room, `${m.name} 的連線中斷了（60 秒內重連會保留位置）`);
        }
      }
      scheduleCleanup(m);
    }
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (!this.closed) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      // 注意：JavaScript 的 & 會先轉成 32 位元有號整數，
      // 必須先用 >>> 0 把符號位清掉，否則 126/127 會被讀成負數。
      let len = (buf[1] & 0x7f) >>> 0;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(LIMITS.maxMessage)) return this.close(1009, 'message too big');
        len = Number(big);
        offset = 10;
      }
      if (len > LIMITS.maxMessage) return this.close(1009, 'message too big');
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = buf.subarray(offset + maskLen + len);
      this.alive = true;

      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) {
        try { this.socket.write(frame(payload, 0xa)); } catch { /* ignore */ }
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        if (opcode !== 0x0) this.fragments = [];
        if (!this.fragments) continue;
        this.fragments.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(this.fragments);
        this.fragments = null;
        try {
          this.onMessage(JSON.parse(full.toString('utf8')));
        } catch (err) {
          console.error('[彩紙屋] 處理訊息時發生錯誤：', err);
          this.send({ t: 'error', message: '訊息格式錯誤' });
        }
      }
    }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    handleMessage(this, msg);
  }
}

function frame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

/* ----------------------------------------------------------------
 * 訊息處理
 * ---------------------------------------------------------------- */
function findMember(body, conn) {
  // 以連線握手時綁定的會員為準，避免有人冒用別人的 memberId
  const bound = conn.member;
  if (!bound) return null;
  if (typeof body.memberId === 'string' && body.memberId && body.memberId !== bound.id) return null;
  return bound;
}

function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const tool = ['pencil', 'watercolor', 'highlight', 'pen', 'goldpen'].includes(s.tool) ? s.tool : 'pen';
  const points = Array.isArray(s.points)
    ? s.points.slice(0, LIMITS.maxStroke).map((v) => clampNum(v, -0.5, 1.5, 0))
    : [];
  if (points.length < 4) return null;
  return {
    id: clampStr(s.id, 40) || 'k' + crypto.randomBytes(5).toString('hex'),
    tool,
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#333333',
    // 筆寬單位是 CSS 像素（0.6 ~ 40）；舊版客戶端送比例值，也允許通過
    size: clampNum(s.size, 0.001, 200, 3),
    // 送出者當時的紙張寬度（CSS 像素），讓不同螢幕看到一樣粗細
    paperW: Math.round(clampNum(s.paperW, 0, 4000, 0)),
    alpha: clampNum(s.alpha, 0.05, 1, 1),
    points,
    by: typeof s.by === 'string' ? s.by : '',
  };
}

function broadcastStroke(room, stroke, exceptSid) {
  const msg = JSON.stringify({ t: 'stroke', stroke });
  for (const mm of room.members.values()) {
    if (mm.conn && mm.conn.sid !== exceptSid) mm.conn.sendRaw(msg);
  }
}

function newStrokeId() {
  return 'k' + crypto.randomBytes(7).toString('hex');
}

function reviewGallery(body) {
  const items = [];
  const list = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const image = typeof it.image === 'string' ? it.image : '';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) continue;
    if (image.length > LIMITS.maxGallery) continue;
    items.push({
      id: galleryId(),
      image,
      title: cleanText(it.title || '未命名色紙', 40) || '未命名色紙',
      by: cleanText(it.by || body.name, 24) || '朋友',
      from: cleanText(it.from, 24),
      to: cleanText(it.to, 24),
      paper: it.paper && typeof it.paper === 'object'
        ? { bg: clampStr(it.paper.bg, 16), edge: clampStr(it.paper.edge, 8), hue: clampNum(it.paper.hue, 0, 360, 0) }
        : null,
      ts: Date.now(),
    });
  }
  return items;
}

function handleMessage(conn, msg) {
  const body = msg.body && typeof msg.body === 'object' ? msg.body : {};

  /* ---- hello：註冊會員，可能同時進房 ---- */
  if (msg.t === 'hello') {
    // 沿用瀏覽器自己產生的 ID（重開頁面也能保住房間與畫廊），
    // 只有在格式不對時才由伺服器產生一個新的。
    const wantedId = typeof body.memberId === 'string' && /^[A-Za-z0-9_-]{6,48}$/.test(body.memberId) ? body.memberId : null;
    let member = wantedId ? members.get(wantedId) : null;
    if (member && member.conn && member.conn !== conn && !member.conn.closed) {
      // 同一個人從別的視窗用同一身分登入，舊連線直接踢掉
      member.conn.close(4001, 'replaced');
    }
    if (!member) {
      let id = wantedId || 'm' + crypto.randomBytes(6).toString('hex');
      while (members.has(id)) id = 'm' + crypto.randomBytes(6).toString('hex');
      member = { id, name: '', color: '', roomCode: null, conn: null };
      members.set(member.id, member);
    }
    member.name = cleanText(body.name, 16) || '旅人' + crypto.randomInt(100, 999);
    member.color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : colorFor(member.id);
    member.joinedAt = member.joinedAt || Date.now();
    member.strokeCount = Number.isFinite(body.strokeCount) ? body.strokeCount : 0;
    if (body.paper && typeof body.paper === 'object') member.paper = body.paper;
    clearTimeout(member.cleanupTimer);
    member.conn = conn;
    conn.member = member;

    // 注意：把 memberId 同時放在 body 內與連線本身，之後每個指令都要帶回同一個 id
    conn.send({ t: 'hello-ok', self: publicMember(member) });

    // 重連：回到原本的房間
    if (body.rejoin && member.roomCode && rooms.has(member.roomCode)) {
      const room = rooms.get(member.roomCode);
      member.expires = 0;
      conn.send({ t: 'joined', self: publicMember(member), room: publicRoom(room), rejoin: true });
      broadcast(room, { t: 'member-updated', member: publicMember(member) }, conn.sid);
      systemMessage(room, `${member.name} 回來了`);
      return;
    }
    // 開一間新房間
    if (body.createRoom) {
      member.roomCode = null;
      const res = joinRoom(member, null, true);
      const r = res.room;
      conn.send({ t: 'joined', self: publicMember(member), room: publicRoom(r), isNew: true });
      systemMessage(r, `${member.name} 開了一間新的房間`);
      return;
    }
    // 用連結直接進房
    if (typeof body.joinCode === 'string' && /^[A-Z0-9]{6}$/i.test(body.joinCode.trim())) {
      joinVia(conn, member, body.joinCode.trim().toUpperCase(), false);
    }
    return;
  }

  const member = findMember(body, conn);
  if (!member) {
    conn.send({ t: 'error', code: 'auth', message: '尚未登入，請重新整理頁面' });
    return;
  }
  member.name = cleanText(body.name, 16) || member.name;
  member.strokeCount = Number.isFinite(body.strokeCount) ? body.strokeCount : member.strokeCount;
  if (body.paper && typeof body.paper === 'object') member.paper = body.paper;
  const room = member.roomCode ? rooms.get(member.roomCode) : null;

  switch (msg.t) {
    /* ---- 開房 / 加入 ---- */
    case 'create-room': {
      if (room) leaveRoom(member, `${member.name} 離開了房間`);
      const res = joinRoom(member, null, true);
      if (res.error) return conn.send({ t: 'error', message: res.error });
      const r = res.room;
      conn.send({ t: 'joined', self: publicMember(member), room: publicRoom(r), isNew: true });
      systemMessage(r, `${member.name} 開了一間新的房間`);
      break;
    }
    case 'join-room': {
      const code = clampStr(body.code, 8).toUpperCase().trim();
      if (room && room.code === code) {
        return conn.send({ t: 'joined', self: publicMember(member), room: publicRoom(room), rejoin: true });
      }
      joinVia(conn, member, code, false);
      break;
    }
    case 'leave-room': {
      if (!room) return;
      leaveRoom(member, `${member.name} 離開了房間`);
      conn.send({ t: 'left' });
      break;
    }

    /* ---- 紙張設定 ---- */
    case 'paper': {
      if (!room) return;
      // 紙張顏色可以是預設色票的 id（如 sakura），或是任意 #rrggbb
      room.paper = {
        // 紙張只有白紙，其他顏色一律忽略
        bg: 'white',
        edge: ['plain', 'gold', 'laser'].includes(body.edge) ? body.edge : room.paper.edge,
        hue: clampNum(body.hue, 0, 360, room.paper.hue || 210),
      };
      broadcast(room, { t: 'paper', paper: room.paper, by: member.id }, conn.sid);
      break;
    }

    /* ---- 畫筆 ---- */
    case 'stroke': {
      if (!room) return;
      const stroke = sanitizeStroke(body.stroke);
      if (!stroke) return;
      stroke.by = member.id;
      room.strokes.push(stroke);
      member.strokeCount = room.strokes.length;
      broadcastStroke(room, stroke, conn.sid);
      break;
    }
    case 'stroke-many': {
      if (!room) return;
      const list = Array.isArray(body.strokes) ? body.strokes.slice(0, 400) : [];
      for (const raw of list) {
        const stroke = sanitizeStroke(raw);
        if (!stroke) continue;
        stroke.by = member.id;
        room.strokes.push(stroke);
        broadcastStroke(room, stroke, conn.sid);
      }
      break;
    }
    case 'stroke-update': {
      if (!room) return;
      const idx = Number(body.index);
      const stroke = room.strokes[idx];
      if (!stroke || stroke.by !== member.id) return;
      const points = Array.isArray(body.points)
        ? body.points.slice(0, LIMITS.maxStroke).map((v) => clampNum(v, -0.5, 1.5, 0))
        : [];
      stroke.points = points;
      broadcast(room, { t: 'stroke-update', index: idx, points }, conn.sid);
      break;
    }
    case 'erase': {
      if (!room) return;
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 2000) : [];
      const mine = ids.filter((_id, i) => room.strokes[i] && room.strokes[i].id === _id && room.strokes[i].by === member.id);
      if (!mine.length) return;
      room.strokes = room.strokes.filter((s) => !(mine.includes(s.id) && s.by === member.id));
      member.strokeCount = room.strokes.length;
      broadcast(room, { t: 'erased', ids: mine, by: member.id }, conn.sid);
      break;
    }
    case 'undo': {
      if (!room) return;
      for (let i = room.strokes.length - 1; i >= 0; i--) {
        if (room.strokes[i].by === member.id) {
          const [removed] = room.strokes.splice(i, 1);
          member.strokeCount = room.strokes.length;
          broadcast(room, { t: 'erased', ids: [removed.id], by: member.id }, conn.sid);
          return;
        }
      }
      break;
    }
    case 'redo': {
      if (!room) return;
      const stroke = sanitizeStroke(body.stroke);
      if (!stroke) return;
      stroke.by = member.id;
      room.strokes.push(stroke);
      member.strokeCount = room.strokes.length;
      broadcastStroke(room, stroke, conn.sid);
      break;
    }
    case 'clear-all': {
      // 「重置」：清空整張色紙（房間內所有人都會同步）
      if (!room) return;
      if (!room.strokes.length) return;
      room.strokes = [];
      for (const mm of room.members.values()) mm.strokeCount = 0;
      broadcast(room, { t: 'cleared', by: member.id, name: member.name });
      systemMessage(room, `${member.name} 重置了整張色紙`);
      break;
    }
    case 'clear': {
      if (!room) return;
      const ids = room.strokes.filter((s) => s.by === member.id).map((s) => s.id);
      if (!ids.length) return;
      room.strokes = room.strokes.filter((s) => s.by !== member.id);
      member.strokeCount = room.strokes.length;
      broadcast(room, { t: 'erased', ids, by: member.id }, conn.sid);
      break;
    }
    case 'cursor': {
      if (!room || !body.x || typeof body.x !== 'object') return;
      broadcast(room, {
        t: 'cursor', id: member.id,
        x: clampNum(body.x.x, 0, 1), y: clampNum(body.x.y, 0, 1),
      }, conn.sid);
      break;
    }

    /* ---- 聊天室 ---- */
    case 'chat': {
      const text = cleanText(body.text, LIMITS.maxChat).trim();
      const msg = { kind: 'user', id: 'c' + crypto.randomBytes(4).toString('hex'), by: member.id, name: member.name, color: member.color, text, ts: Date.now() };
      if (!text) return;
      if (room) {
        room.history.push(msg);
        if (room.history.length > LIMITS.chatHistory) room.history.shift();
        broadcast(room, { t: 'chat', msg }, conn.sid);
        conn.send({ t: 'chat-ack', msg });
      } else {
        conn.send({ t: 'chat-ack', msg });
        conn.send({ t: 'chat', msg: { ...msg, text: text } });
        conn.send({ t: 'chat', msg: { ...msg, id: 'sys' + msg.id, kind: 'sys', text: '（目前是離線模式，訊息只會顯示在你這裡）' } });
      }
      break;
    }

    /* ---- 交換色紙 ---- */
    case 'exchange-request': {
      const to = members.get(clampStr(body.to, 40));
      if (!to || !to.conn) return conn.send({ t: 'error', message: '對方不在線上了' });
      if (to.id === member.id) return conn.send({ t: 'error', message: '不能和自己交換喔' });
      const fromImage = typeof body.fromImage === 'string' && /^data:image\/png;base64,/.test(body.fromImage) ? body.fromImage.slice(0, LIMITS.maxSnapshot) : '';
      const req = {
        id: 'x' + crypto.randomBytes(6).toString('hex'),
        from: member.id, fromName: member.name, fromColor: member.color,
        to: to.id,
        fromImage,
        createdAt: Date.now(),
      };
      send(to, { t: 'exchange-incoming', request: { id: req.id, from: req.from, fromName: req.fromName, fromColor: req.fromColor, fromImage, createdAt: req.createdAt } });
      conn.send({ t: 'exchange-sent', requestId: req.id, to: to.id, toName: to.name });
      break;
    }
    case 'exchange-offer': {
      // 被邀請方挑選回禮
      const to = members.get(clampStr(body.to, 40));
      if (!to || !to.conn) return conn.send({ t: 'error', message: '對方不在線上了' });
      const image = typeof body.image === 'string' && /^data:image\/png;base64,/.test(body.image) ? body.image.slice(0, LIMITS.maxSnapshot) : '';
      send(to, {
        t: 'exchange-offer',
        offer: { from: member.id, fromName: member.name, fromColor: member.color, image, title: cleanText(body.title, 40) },
      });
      break;
    }
    case 'exchange-accept': {
      sendToId(body.to, { t: 'exchange-accepted', by: member.id, name: member.name });
      break;
    }
    case 'exchange-decline': {
      sendToId(body.to, { t: 'exchange-declined', by: member.id, name: member.name });
      break;
    }
    case 'exchange-cancel': {
      sendToId(body.to, { t: 'exchange-cancelled', by: member.id, name: member.name });
      break;
    }

    /* ---- 畫廊同步 ---- */
    case 'gallery-save': {
      const items = reviewGallery(body);
      if (!items.length) return;
      galleryStore = [...items, ...galleryStore].slice(0, 60);
      saveGallery();
      conn.send({ t: 'gallery-saved', items });
      if (room) {
        for (const it of items) {
          if (it.from) systemMessage(room, `🎁 ${member.name} 收藏了 ${it.from} 交換來的色紙「${it.title}」`);
        }
      }
      break;
    }
    case 'gallery-review': {
      const items = reviewGallery(body);
      conn.send({ t: 'gallery-reviewed', items });
      break;
    }

    default:
      conn.send({ t: 'error', message: '未知的指令：' + msg.t });
  }
}

function sendToId(id, msg) {
  const m = members.get(String(id || ''));
  if (m && m.conn) m.conn.send(msg);
}

function joinVia(conn, member, code, makeNew) {
  if (!code) return conn.send({ t: 'error', code: 'join', message: '請輸入房間代碼' });
  if (member.roomCode) leaveRoom(member, `${member.name} 離開了房間`);
  const res = joinRoom(member, code, makeNew);
  if (res.error) return conn.send({ t: 'error', code: 'join', message: res.error });
  const room = res.room;
  conn.send({ t: 'joined', self: publicMember(member), room: publicRoom(room), isNew: false });
  broadcast(room, { t: 'member-joined', member: publicMember(member) }, conn.sid);
  systemMessage(room, `${member.name} 加入了房間`);
}

function scheduleCleanup(member) {
  clearTimeout(member.cleanupTimer);
  member.cleanupTimer = setTimeout(() => {
    if (member.conn) return;
    const room = member.roomCode ? rooms.get(member.roomCode) : null;
    if (room && room.members.has(member.id)) {
      room.members.delete(member.id);
      if (room.members.size === 0) rooms.delete(room.code);
    }
    member.roomCode = null;
    members.delete(member.id);
  }, 61_000);
}

/* 展廳小清理：保留最多 60 張 */
setInterval(() => {
  if (galleryStore.length > 60) {
    galleryStore = galleryStore.slice(0, 60);
    saveGallery();
  }
}, 60_000).unref();

/* ----------------------------------------------------------------
 * HTTP 靜態檔案
 * ---------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveStatic(req, res) {
  let pathname;
  try {
    // 先取出原始路徑再解碼，避免 WHATWG URL 先把 %2e%2e 正規化掉
    pathname = decodeURIComponent(String(req.url || '/').split(/[?#]/)[0]);
  } catch {
    res.writeHead(400); return res.end('bad request');
  }
  if (!pathname.startsWith('/')) { res.writeHead(400); return res.end('bad request'); }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ rooms: rooms.size, members: members.size, gallery: galleryStore.length }));
  }
  const filePath = path.normalize(path.join(ROOT, pathname));
  const isDataFile = filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep);
  if (!filePath.startsWith(ROOT + path.sep) || isDataFile) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('找不到檔案');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  serveStatic(req, res);
});

/* WebSocket 升級 */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  new Connection(socket, req);
});

/* 心跳：偵測半死連線 */
setInterval(() => {
  for (const m of members.values()) {
    const c = m.conn;
    if (!c) continue;
    if (!c.alive) { try { c.socket.destroy(); } catch {} c.onClose(); continue; }
    c.alive = false;
    try { c.socket.write(frame(Buffer.alloc(0), 0x9)); } catch { c.onClose(); }
  }
}, 30_000).unref();

loadGallery();
server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  ✨ 彩紙屋已啟動： http://${shownHost}:${PORT}\n`);
  console.log(`  同一個 Wi-Fi 下的朋友可以用你的區網 IP（例如 http://192.168.x.x:${PORT}）連進來一起畫。\n`);
});

process.on('SIGINT', () => {
  try { fs.writeFileSync(GALLERY_FILE + '.tmp', JSON.stringify(galleryStore)); fs.renameSync(GALLERY_FILE + '.tmp', GALLERY_FILE); } catch {}
  process.exit(0);
});
