// 端對端測試：用兩/三個 WebSocket 當「假的人」，驗證房間、筆刷同步、聊天室、交換色紙
// 執行： node test/e2e.mjs [http://127.0.0.1:8787]
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 透明 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function client(name) {
  const id = 'test-' + name + '-' + Math.random().toString(36).slice(2, 7);
  const c = { name, id, inbox: [], ws: null };
  c.open = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS);
      c.ws = ws;
      ws.onerror = (e) => reject(new Error('ws error ' + name));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        c.inbox.push(msg);
      };
      ws.onopen = () => {
        send(c, 'hello', {});
        waitFor(c, 'hello-ok').then((m) => { c.serverId = m.self.id; resolve(c); }, reject);
      };
    });
  c.close = () => c.ws && c.ws.close();
  return c;
}

function send(c, t, body = {}) {
  c.ws.send(JSON.stringify({ t, body: { ...body, memberId: c.id, name: c.name, color: '#9cc3f0', strokeCount: 0, paper: { bg: 'sakura', edge: 'gold', hue: 210 } } }));
}

async function waitFor(c, t, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const idx = c.inbox.findIndex((m) => m.t === t);
    if (idx >= 0) return c.inbox.splice(idx, 1)[0];
    await sleep(15);
  }
  throw new Error(`${c.name} 等不到 ${t}（收到：${c.inbox.map((m) => m.t).join(',')}）`);
}
function clearInbox(c) { c.inbox.length = 0; }

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['✅', name]);
    console.log('✅', name);
  } catch (e) {
    results.push(['❌', name, e.message]);
    console.log('❌', name, '\n   ', e.message);
  }
}

const alice = client('Alice');
const bob = client('Bob');
let roomCode = '';

await alice.open();
await bob.open();

await test('開房間會拿到 6 位房間代碼', async () => {
  send(alice, 'create-room');
  const joined = await waitFor(alice, 'joined');
  assert.match(joined.room.code, /^[A-Z0-9]{6}$/);
  assert.equal(joined.isNew, true);
  roomCode = joined.room.code;
});

await test('第二個人可以加入同一間房', async () => {
  send(bob, 'join-room', { code: roomCode });
  const joined = await waitFor(bob, 'joined');
  assert.equal(joined.room.code, roomCode);
  assert.equal(joined.room.members.length, 2);
  const mj = await waitFor(alice, 'member-joined');
  assert.equal(mj.member.name, 'Bob');
  let sys;
  for (;;) {
    sys = await waitFor(alice, 'sys');
    if (/Bob 加入了房間/.test(sys.msg.text)) break;
  }
});

await test('畫筆即時同步到另一端', async () => {
  clearInbox(bob);
  send(alice, 'stroke', { stroke: { id: 's1', tool: 'watercolor', color: '#e8747c', size: 0.02, alpha: 0.5, points: [0.1, 0.1, 0.2, 0.25, 0.3, 0.15] } });
  const got = await waitFor(bob, 'stroke');
  assert.equal(got.stroke.tool, 'watercolor');
  assert.equal(got.stroke.by, alice.id);
  assert.deepEqual(got.stroke.points, [0.1, 0.1, 0.2, 0.25, 0.3, 0.15]);
  assert.ok(!alice.inbox.some((m) => m.t === 'stroke'), '自己不會收到自己的筆畫');
});

await test('五種筆都能過伺服器（鉛筆/水彩/螢光筆/原子筆/燙金筆）', async () => {
  clearInbox(bob);
  for (const tool of ['pencil', 'watercolor', 'highlight', 'pen', 'goldpen']) {
    send(bob, 'stroke', { stroke: { id: 't-' + tool, tool, color: '#123456', size: 6, alpha: 1, points: [0.5, 0.5, 0.6, 0.6], paperW: 534 } });
    const got = await waitFor(alice, 'stroke');
    assert.equal(got.stroke.tool, tool);
    // 筆寬換算用的紙張寬度也要一起去 / 回來
    assert.ok(got.stroke.paperW > 0, 'paperW 應為正數');
  }
});

await test('紙張工藝（燙金/燙雷射）與色相同步', async () => {
  clearInbox(bob);
  send(alice, 'paper', { bg: 'mizu', edge: 'laser', hue: 123, size: 'B4' });
  const got = await waitFor(bob, 'paper');
  assert.equal(got.paper.edge, 'laser');
  assert.equal(got.paper.hue, 123);
  assert.equal(got.paper.bg, 'white', '底色一律是白紙');
});

await test('聊天訊息送到房間，並記錄歷史', async () => {
  clearInbox(alice);
  clearInbox(bob);
  send(bob, 'chat', { text: '  你好呀！這張紙真漂亮 ✨ ' });
  const got = await waitFor(alice, 'chat');
  assert.equal(got.msg.text, '你好呀！這張紙真漂亮 ✨');
  assert.equal(got.msg.name, 'Bob');
  assert.equal(got.msg.kind, 'user');
  const ack = await waitFor(bob, 'chat-ack');
  assert.equal(ack.msg.text, '你好呀！這張紙真漂亮 ✨');
});

await test('新的加入者會拿到筆畫 + 聊天歷史', async () => {
  const carol = client('Carol');
  await carol.open();
  send(carol, 'join-room', { code: roomCode });
  const joined = await waitFor(carol, 'joined');
  assert.ok(joined.room.strokes.length >= 5, '有之前的筆畫');
  assert.ok(joined.room.history.some((h) => h.text && h.text.includes('你好呀')), '有聊天歷史');
  assert.equal(joined.room.members.length, 3);
  carol.close();
  await waitFor(alice, 'member-left');
});

await test('交換色紙：請求 → 收下 → 回禮 → 收進畫廊', async () => {
  clearInbox(bob);
  clearInbox(alice);
  send(alice, 'exchange-request', { to: bob.id, fromImage: PNG });
  const inc = await waitFor(bob, 'exchange-incoming');
  assert.equal(inc.request.fromName, 'Alice');
  assert.equal(inc.request.fromImage, PNG);
  await waitFor(alice, 'exchange-sent');

  send(bob, 'exchange-accept', { to: alice.id });
  await waitFor(alice, 'exchange-accepted');
  send(bob, 'exchange-offer', { to: alice.id, image: PNG, title: 'Bob 的櫻花色紙' });
  const off = await waitFor(alice, 'exchange-offer');
  assert.equal(off.offer.title, 'Bob 的櫻花色紙');
  assert.equal(off.offer.fromName, 'Bob');

  send(alice, 'gallery-save', { items: [{ image: off.offer.image, title: off.offer.title, by: off.offer.fromName, from: off.offer.fromName, to: 'Alice' }] });
  const saved = await waitFor(alice, 'gallery-saved');
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].from, 'Bob');
  assert.match(saved.items[0].id, /^g/);
});

await test('交換被婉拒會通知對方', async () => {
  clearInbox(alice);
  send(alice, 'exchange-request', { to: bob.id, fromImage: PNG });
  await waitFor(bob, 'exchange-incoming');
  send(bob, 'exchange-decline', { to: alice.id });
  const dec = await waitFor(alice, 'exchange-declined');
  assert.equal(dec.name, 'Bob');
});

await test('不能修改別人的筆畫（undo 只會復原自己的）', async () => {
  clearInbox(bob);
  send(alice, 'undo');
  const erased = await waitFor(bob, 'erased');
  assert.equal(erased.by, alice.id);
  // Alice 最後一筆是 watercolor s1
  assert.deepEqual(erased.ids, ['s1']);
});

await test('橡皮擦/清空只刪自己的筆畫', async () => {
  clearInbox(alice);
  send(bob, 'erase', { ids: ['t-pencil', 's1'] }); // s1 是 Alice 的，不能被 Bob 刪
  const erased = await waitFor(alice, 'erased');
  assert.deepEqual(erased.ids, ['t-pencil']);
});

await test('紙張一律是白紙（送其他顏色也會被忽略）', async () => {
  clearInbox(bob);
  send(alice, 'paper', { bg: '#ff0000', edge: 'plain', hue: 30 });
  const got = await waitFor(bob, 'paper');
  assert.equal(got.paper.bg, 'white');
  assert.equal(got.paper.edge, 'plain');
});

await test('游標位置廣播給其他人（不含自己）', async () => {
  clearInbox(bob);
  send(alice, 'cursor', { x: { x: 0.42, y: 0.58 } });
  const cur = await waitFor(bob, 'cursor');
  assert.equal(cur.id, alice.id);
  assert.equal(cur.x, 0.42);
  assert.equal(cur.y, 0.58);
});

await test('加入不存在的房間會得到友善錯誤', async () => {
  const dave = client('Dave');
  await dave.open();
  send(dave, 'join-room', { code: 'ZZZZZZ' });
  const err = await waitFor(dave, 'error');
  assert.equal(err.code, 'join');
  assert.match(err.message, /找不到/);
  dave.close();
});

await test('離開房間會通知其他人，其他人還在', async () => {
  clearInbox(alice);
  send(bob, 'leave-room');
  await waitFor(bob, 'left');
  const left = await waitFor(alice, 'member-left');
  assert.equal(left.id, bob.id);
});

await test('重新連線可回到原本的房間（60 秒保留期）', async () => {
  // Carol 加入後直接斷線（模擬重新整理頁面），再用同一個身份回來
  const carol = client('Carol');
  await carol.open();
  send(carol, 'join-room', { code: roomCode });
  await waitFor(carol, 'joined');
  clearInbox(alice);
  carol.ws.close();
  const left = await waitFor(alice, 'member-left');
  assert.equal(left.pending, true, '斷線時只是暫時離開');

  const ws = new WebSocket(WS);
  const msgs = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(ev.data));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'hello', body: { memberId: carol.id, name: 'Carol', rejoin: true } }));
  const start2 = Date.now();
  while (!msgs.some((m) => m.t === 'joined') && Date.now() - start2 < 3000) await sleep(15);
  const joined = msgs.find((m) => m.t === 'joined');
  assert.ok(joined, '沒有 rejoin：' + JSON.stringify(msgs.map((m) => m.t)));
  assert.equal(joined.room.code, roomCode);
  assert.equal(joined.rejoin, true);
  assert.ok(joined.room.strokes.length > 0, '回來後仍有大家的筆跡');
  ws.close();
});

await test('「重置」會清空整張色紙並通知房間裡的人', async () => {
  // 先確保紙上還有東西（前面的 undo / 清空可能已經把筆跡清光）
  // 同一張紙的兩個人在這裡是 Alice 和 Eve（Bob 已離開），所以用 Eve 收訊息
  const carol = client('Carol');
  await carol.open();
  send(carol, 'join-room', { code: roomCode });
  await waitFor(carol, 'joined');
  await waitFor(alice, 'member-joined');
  send(alice, 'stroke', { stroke: { id: 'reset-me', tool: 'pen', color: '#123456', size: 5, alpha: 1, points: [0.1, 0.1, 0.2, 0.2], paperW: 534 } });
  await waitFor(carol, 'stroke');
  clearInbox(carol);
  send(alice, 'clear-all');
  const cleared = await waitFor(carol, 'cleared');
  assert.equal(cleared.name, 'Alice');
  carol.close();
  await waitFor(alice, 'member-left');
  // 新的加入者看到的是空的紙
  const eve = client('Eve');
  await eve.open();
  send(eve, 'join-room', { code: roomCode });
  const joined = await waitFor(eve, 'joined');
  assert.equal(joined.room.strokes.length, 0, '重置後房間應該是空的');
  eve.close();
  await waitFor(alice, 'member-left');
});

await test('同一 memberId 從新連線登入會踢掉舊連線', async () => {
  const c1 = client('Eve');
  await c1.open();
  const closed = new Promise((r) => (c1.ws.onclose = (e) => r(e.code)));
  const ws2 = new WebSocket(WS);
  await new Promise((r) => (ws2.onopen = r));
  ws2.send(JSON.stringify({ t: 'hello', body: { memberId: c1.id, name: 'Eve' } }));
  const code = await Promise.race([closed, sleep(2000).then(() => 'timeout')]);
  assert.notEqual(code, 'timeout', '舊連線應被關閉');
  ws2.close();
});

alice.close();
bob.close();
await sleep(100);
const failed = results.filter((r) => r[0] === '❌');
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
