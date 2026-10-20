'use strict';
/* =========================================================
 * 小龙庄园 v0.1（MVP）
 * 核心闭环：种牧草 → 饲料机加工 → 喂鸡 → 收蛋 → 交订单 → 升级解锁小麦
 * 时间系统：一切生产基于真实时间戳（start + duration），离线照常生长
 * 渲染策略：玩家操作才全量重绘；每秒只原位更新倒计时/徽标，避免节点重建吞点击
 * ========================================================= */

/* ---------- 配置（DEMO 时长，正式版数值见注释） ---------- */
const CROPS = {
  grass: { name: '牧草', seedCost: 2, growMs: 30e3,  sell: 3,  xp: 1, unlockLv: 1, stages: ['🌱', '🌿', '🌿'] }, // 正式版：5分钟
  wheat: { name: '小麦', seedCost: 8, growMs: 120e3, sell: 14, xp: 3, unlockLv: 2, stages: ['🌱', '🌿', '🌾'] }, // 正式版：30分钟
};
const ITEMS = {
  grass: { name: '牧草', emoji: '🌿', sell: CROPS.grass.sell },
  wheat: { name: '小麦', emoji: '🌾', sell: CROPS.wheat.sell },
  feed:  { name: '饲料', emoji: '🌽', sell: 8 },
  egg:   { name: '鸡蛋', emoji: '🥚', sell: 15 },
};
const MILL = { inKey: 'grass', inQty: 3, ms: 20e3, outKey: 'feed', outQty: 1, xp: 1 }; // 正式版：30分钟
const EGG_MS = 90e3;            // 正式版：6小时
const REFILL_MS = 30e3;         // 订单槽拒单/交付后的补充时间
const OFFLINE_CAP = 8 * 3600e3; // 离线收益上限（原则性保留）
const LV = { 1: 0, 2: 20, 3: 50, 4: 100, 5: 180 }; // 各等级所需累计经验，MVP 封顶 Lv5
const SAVE_KEY = 'morning-breeze-farm-v01';

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
function ri(n) { return Math.floor(Math.random() * n); }
function fmt(ms) {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return h + '时' + (m % 60) + '分';
  if (m > 0) return m + '分' + (s % 60) + '秒';
  return s + '秒';
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let x = Math.imul(a ^ a >>> 15, 1 | a);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 2800);
}
function floatNum(text, x, y) {
  const f = document.createElement('div');
  f.className = 'float-num';
  f.textContent = text;
  f.style.left = Math.max(10, x - 20) + 'px';
  f.style.top = (y - 30) + 'px';
  document.body.append(f);
  setTimeout(() => f.remove(), 1000);
}

/* ---------- 存档 ---------- */
function newGame() {
  return {
    v: 1,
    coins: 30,
    xp: 0,
    plots: Array.from({ length: 10 }, () => ({ crop: null, readyAt: 0 })), // 8 块初始 + 2 块 Lv3 解锁
    chickens: Array.from({ length: 4 }, () => ({ fed: false, eggReadyAt: 0 })),
    mill: { run: null, queue: 0 }, // run = { startAt, ms }
    inv: { grass: 0, wheat: 0, feed: 2, egg: 0 },
    orders: [null, null, null],
    refill: [0, 0, 0],
    lastSeen: Date.now(),
  };
}
function save() {
  S.lastSeen = Date.now();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* 隐私模式等场景忽略 */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && s.v === 1 && Array.isArray(s.plots) && Array.isArray(s.chickens)) return s;
  } catch (e) { /* 损坏存档当新档 */ }
  return null;
}

/* ---------- 等级 ---------- */
function lvOf(xp) {
  let l = 1;
  for (let k = 2; k <= 5; k++) if (xp >= LV[k]) l = k;
  return l;
}
function lv() { return lvOf(S.xp); }
function plotUnlocked(i) { return i < 8 || lv() >= 3; }
function gainXp(n) {
  const before = lv();
  S.xp += n;
  const after = lv();
  if (after > before) {
    let msg = '🎉 升级！当前 Lv' + after;
    if (after === 2) msg += '，解锁新作物：小麦 🌾';
    if (after === 3) msg += '，解锁 2 块新耕地！';
    toast(msg);
  }
}

/* ---------- 地图（12×12，玩家区居中；草原上散落雏菊/石块/蘑菇） ---------- */
const GRID = 12;
const TILES = buildTiles();
function buildTiles() {
  const t = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => ({ t: 'wild', e: '' })));
  const rnd = mulberry32(20261019);
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const x = rnd();
    if (x < 0.10) {
      // 雏菊：随机摇曳节奏/朝向/大小/花色
      t[r][c] = {
        t: 'wild', daisy: {
          dur: 2.4 + rnd() * 1.5,
          delay: -(rnd() * 4),
          w: 38 + rnd() * 34,
          rot: rnd() * 22,
          cream: rnd() < 0.35,
        },
      };
    } else if (x < 0.128) t[r][c] = { t: 'wild', e: '🪨' };
    else if (x < 0.148) t[r][c] = { t: 'wild', e: '🍄' };
  }
  t[4][3] = { t: 'coop' };
  t[5][3] = { t: 'mill' };
  t[6][3] = { t: 'board' };
  const plotPos = [[4, 4], [4, 5], [4, 6], [4, 7], [5, 4], [5, 5], [5, 6], [5, 7]];
  plotPos.forEach(([r, c], i) => { t[r][c] = { t: 'plot', i }; });
  t[6][4] = { t: 'plot', i: 8, lock3: true };
  t[6][5] = { t: 'plot', i: 9, lock3: true };
  return t;
}

/* 雏菊 SVG：花茎+叶片+8 瓣白色（或奶白）花瓣+黄芯，sway 动画参数由内联样式控制 */
function daisySvg(d) {
  let petals = '';
  for (let a = 0; a < 8; a++) {
    petals += '<ellipse cx="12" cy="5.8" rx="2.7" ry="5.2" fill="' + (d.cream ? '#fff7e9' : '#ffffff') +
      '" transform="rotate(' + (a * 45 + d.rot) + ' 12 12)"/>';
  }
  return '<svg class="daisy" viewBox="0 0 24 34" style="width:' + d.w + '%;animation-duration:' + d.dur +
    's;animation-delay:' + d.delay + 's">' +
    '<path d="M12 33 C 11.3 27 12.7 22.5 12 17" fill="none" stroke="#3f7d2f" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M12 27 C 9.6 25.2 7.4 25.4 5.8 27.2" fill="none" stroke="#4a8a38" stroke-width="1.6" stroke-linecap="round"/>' +
    petals + '<circle cx="12" cy="12" r="3.4" fill="#ffd23f"/></svg>';
}

/* ---------- 游戏行为 ---------- */
function plant(i, key) {
  const c = CROPS[key];
  if (!plotUnlocked(i)) return;
  if (S.coins < c.seedCost) return toast('金币不够啦，先交个订单吧');
  S.coins -= c.seedCost;
  S.plots[i] = { crop: key, readyAt: Date.now() + c.growMs };
  touch();
}
function harvest(i) {
  const p = S.plots[i];
  if (!p.crop || Date.now() < p.readyAt) return;
  S.inv[p.crop] += 1;
  gainXp(CROPS[p.crop].xp);
  floatNum('+1 ' + ITEMS[p.crop].emoji, lastClick.x, lastClick.y);
  S.plots[i] = { crop: null, readyAt: 0 };
  touch();
}
function feedChicken(i) {
  const ch = S.chickens[i];
  if (ch.fed) return;
  if (S.inv.feed < 1) return toast('没有饲料了：牧草×3 → 饲料机加工');
  S.inv.feed -= 1;
  S.chickens[i] = { fed: true, eggReadyAt: Date.now() + EGG_MS };
  touch();
}
function collectEgg(i) {
  const ch = S.chickens[i];
  if (!ch.fed || Date.now() < ch.eggReadyAt) return;
  S.inv.egg += 1;
  gainXp(4);
  floatNum('+1 🥚', lastClick.x, lastClick.y);
  S.chickens[i] = { fed: false, eggReadyAt: 0 };
  touch();
}
function millGo() {
  if (S.mill.run && S.mill.queue >= 1) return toast('加工队列已满（完成收取后自动开始下一个）');
  if (S.inv.grass < MILL.inQty) return toast('需要牧草×' + MILL.inQty);
  S.inv.grass -= MILL.inQty;
  if (!S.mill.run) S.mill.run = { startAt: Date.now(), ms: MILL.ms };
  else S.mill.queue += 1;
  touch();
}
function millTake() {
  const r = S.mill.run;
  if (!r || Date.now() < r.startAt + r.ms) return;
  S.inv[MILL.outKey] += MILL.outQty;
  gainXp(MILL.xp);
  floatNum('+1 🌽', lastClick.x, lastClick.y);
  if (S.mill.queue > 0) { S.mill.queue -= 1; S.mill.run = { startAt: Date.now(), ms: MILL.ms }; }
  else S.mill.run = null;
  touch();
}

/* ---------- 订单 ---------- */
function weighted(pool) {
  let s = 0; for (const [, w] of pool) s += w;
  let r = Math.random() * s;
  for (const [k, w] of pool) { r -= w; if (r < 0) return k; }
  return pool[0][0];
}
function genOrder() {
  const l = lv();
  const pool = [['grass', 40], ['egg', 25], ['feed', 10]];
  if (l >= 2) pool.push(['wheat', 25]);
  const qtyMap = { grass: 2 + ri(3), wheat: 1 + ri(2), egg: 1 + ri(2), feed: 1 + ri(1) };
  const first = weighted(pool);
  const items = { [first]: qtyMap[first] };
  if (l >= 2 && Math.random() < 0.35) {
    const rest = pool.filter(([k]) => !(k in items));
    if (rest.length) { const sec = weighted(rest); items[sec] = qtyMap[sec]; }
  }
  let val = 0;
  for (const [k, n] of Object.entries(items)) val += ITEMS[k].sell * n;
  const coins = Math.max(5, Math.round(val * 1.8 / 5) * 5);
  const xp = Math.max(4, Math.round(coins / 6));
  return { items, coins, xp };
}
function canDeliver(o) {
  return Object.entries(o.items).every(([k, n]) => S.inv[k] >= n);
}
function deliver(i) {
  const o = S.orders[i];
  if (!o || !canDeliver(o)) return;
  for (const [k, n] of Object.entries(o.items)) S.inv[k] -= n;
  S.coins += o.coins;
  gainXp(o.xp);
  floatNum('+' + o.coins + ' 🪙', lastClick.x, lastClick.y);
  S.orders[i] = null;
  S.refill[i] = Date.now() + REFILL_MS;
  toast('✅ 交付成功 +' + o.coins + '金币 +' + o.xp + '经验');
  touch();
}
function reject(i) {
  if (!S.orders[i]) return;
  S.orders[i] = null;
  S.refill[i] = Date.now() + REFILL_MS;
  toast('已拒绝，新订单马上就来');
  touch();
}
function sell(key, n) {
  n = Math.min(n, S.inv[key]);
  if (n <= 0) return;
  S.inv[key] -= n;
  const got = ITEMS[key].sell * n;
  S.coins += got;
  floatNum('+' + got + ' 🪙', lastClick.x, lastClick.y);
  toast('卖出 ' + ITEMS[key].name + '×' + n + '，订单价更高哦');
  touch();
}

/* ---------- UI 状态 ---------- */
const ui = { panel: null, seedIdx: 0, sellItem: null };
const lastClick = { x: 0, y: 0 };
let lastPanelSig = null;

function touch() { save(); render(); }

/* ---------- 地块/建筑的内层 HTML（全量渲染与秒级刷新共用） ---------- */
function plotInner(i, now) {
  const p = S.plots[i];
  if (!p.crop) return '<span class="em">➕</span><small>播种</small>';
  const c = CROPS[p.crop];
  const left = p.readyAt - now;
  if (left <= 0) return '<span class="em">' + c.stages[2] + '</span><small>可收获</small>';
  const prog = 1 - left / c.growMs;
  const stage = prog < 0.5 ? 0 : 1;
  return '<span class="em">' + c.stages[stage] + '</span><small>' + fmt(left) + '</small>';
}
function plotClass(i, now) {
  const p = S.plots[i];
  if (p.crop && now >= p.readyAt) return 'tile soil ready';
  return 'tile soil';
}
function coopInner(now) {
  const ready = S.chickens.filter(ch => ch.fed && now >= ch.eggReadyAt).length;
  const hungry = S.chickens.filter(ch => !ch.fed).length;
  let badge = '';
  if (ready > 0) badge = '<span class="badge green bounce">🥚' + ready + '</span>';
  else if (hungry > 0) badge = '<span class="badge amber">🍽' + hungry + '</span>';
  return '<span class="em">🛖</span><small>鸡舍</small>' + badge;
}
function millInner(now) {
  let badge = '', label = '饲料机';
  if (S.mill.run) {
    const left = S.mill.run.startAt + S.mill.run.ms - now;
    if (left <= 0) { badge = '<span class="badge green bounce">✅</span>'; label = '可收取'; }
    else badge = '<span class="badge">⏱' + fmt(left) + '</span>';
  }
  return '<span class="em">🏭</span><small>' + label + '</small>' + badge;
}
function boardInner() {
  const ok = S.orders.filter(o => o && canDeliver(o)).length;
  const badge = ok > 0 ? '<span class="badge green bounce">📦' + ok + '</span>' : '';
  return '<span class="em">📋</span><small>订单板</small>' + badge;
}

/* ---------- 全量渲染（仅在玩家操作后调用） ---------- */
function render() {
  renderTop();
  renderFarm();
  renderInv();
  renderOverlay();
  lastPanelSig = ui.panel ? panelSig(Date.now()) : null;
}

function renderTop() {
  $('coins').textContent = '🪙 ' + S.coins;
  const l = lv();
  const lvbox = $('lvbox');
  lvbox.childNodes[0].textContent = 'Lv' + l;
  const bar = $('xpbar').firstElementChild;
  if (l >= 5) { bar.style.width = '100%'; lvbox.title = '经验 ' + S.xp + '（MVP 封顶 Lv5）'; }
  else {
    const cur = S.xp - LV[l], need = LV[l + 1] - LV[l];
    bar.style.width = Math.min(100, cur / need * 100) + '%';
    lvbox.title = '经验 ' + S.xp + ' / ' + LV[l + 1];
  }
}

function renderFarm() {
  const now = Date.now();
  let h = '';
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const T = TILES[r][c];
    if (T.t === 'wild') {
      const inner = T.daisy ? daisySvg(T.daisy) : '<span class="em">' + T.e + '</span>';
      h += '<button class="tile wild" data-act="wild">' + inner + '</button>';
    } else if (T.t === 'plot') {
      if (!plotUnlocked(T.i)) {
        h += '<button class="tile soil locked" data-act="wild"><span class="em">🔒</span><small>Lv3</small></button>';
      } else {
        h += '<button class="' + plotClass(T.i, now) + '" data-act="plot" data-i="' + T.i + '">' + plotInner(T.i, now) + '</button>';
      }
    } else if (T.t === 'coop') {
      h += '<button class="tile bld" data-act="open-coop">' + coopInner(now) + '</button>';
    } else if (T.t === 'mill') {
      h += '<button class="tile bld" data-act="open-mill">' + millInner(now) + '</button>';
    } else if (T.t === 'board') {
      h += '<button class="tile bld" data-act="open-board">' + boardInner() + '</button>';
    }
  }
  $('farm').innerHTML = h;
}

function renderInv() {
  let h = '';
  for (const [k, it] of Object.entries(ITEMS)) {
    h += '<button class="chip" data-act="sell-open" data-item="' + k + '">' + it.emoji + ' <b>' + S.inv[k] + '</b></button>';
  }
  $('invchips').innerHTML = h;
}

/* ---------- 弹层 ---------- */
function closePanel() { ui.panel = null; }

function renderOverlay() {
  const ov = $('overlay');
  if (!ui.panel) { ov.hidden = true; ov.innerHTML = ''; return; }
  ov.hidden = false;
  ov.innerHTML = panelHtml();
}
function panelHtml() {
  const now = Date.now();
  if (ui.panel === 'seed') {
    let h = '<div class="panel"><h3>🌱 播种</h3>';
    for (const [k, c] of Object.entries(CROPS)) {
      const lvOk = lv() >= c.unlockLv;
      const ok = lvOk && S.coins >= c.seedCost;
      const sub = !lvOk ? '🔒 Lv' + c.unlockLv + ' 解锁' : (c.seedCost + '🪙 · 生长 ' + fmt(c.growMs) + ' · 卖' + c.sell);
      h += '<button class="row" data-act="seed" data-i="' + ui.seedIdx + '" data-crop="' + k + '"' + (ok ? '' : ' disabled') + '>' +
        '<span class="em">' + c.stages[2] + '</span><b>' + c.name + '</b><span class="sub">' + sub + '</span></button>';
    }
    h += '<button class="ghost" data-act="close">取消</button></div>';
    return h;
  }
  if (ui.panel === 'coop') {
    let h = '<div class="panel"><h3>🛖 鸡舍 <span class="sub">' + S.inv.feed + ' 🌽</span></h3>';
    S.chickens.forEach((ch, i) => {
      if (!ch.fed) {
        h += '<button class="row" data-act="feed" data-i="' + i + '"' + (S.inv.feed > 0 ? '' : ' disabled') + '>' +
          '<span class="em">🐔</span><b>饿着呢</b><span class="sub">喂食 🌽×1</span></button>';
      } else if (now >= ch.eggReadyAt) {
        h += '<button class="row" data-act="egg" data-i="' + i + '">' +
          '<span class="em">🐔🥚</span><b>下蛋啦！</b><span class="sub">收取</span></button>';
      } else {
        h += '<button class="row" disabled><span class="em">🐔</span><b>孵蛋中…</b><span class="timer" data-chick="' + i + '">' + fmt(ch.eggReadyAt - now) + '</span></button>';
      }
    });
    h += '<div class="hint">饲料 = 牧草×3 在饲料机加工。鸡蛋别急着卖，留给订单经验更高。</div>' +
      '<button class="ghost" data-act="close">关闭</button></div>';
    return h;
  }
  if (ui.panel === 'mill') {
    let h = '<div class="panel"><h3>🏭 饲料机</h3>';
    h += '<div class="hint">配方：🌿牧草×3 → 🌽饲料×1（耗时 ' + fmt(MILL.ms) + '）</div>';
    if (S.mill.run) {
      const left = S.mill.run.startAt + S.mill.run.ms - now;
      if (left <= 0) {
        h += '<button class="row" data-act="mill-take"><span class="em">🌽</span><b>加工完成</b><span class="sub">收取</span></button>';
      } else {
        const prog = 1 - left / S.mill.run.ms;
        h += '<div class="pbar"><i style="width:' + (prog * 100).toFixed(1) + '%"></i></div>' +
          '<div class="hint mill-hint">加工中… 剩 ' + fmt(left) + (S.mill.queue > 0 ? '（排队中 ×' + S.mill.queue + '）' : '') + '</div>';
      }
    }
    const canGo = S.inv.grass >= MILL.inQty && !(S.mill.run && S.mill.queue >= 1);
    const label = S.mill.run ? (S.mill.queue >= 1 ? '队列已满' : '排队加工 🌿×3') : '开始加工 🌿×3';
    h += '<button class="btn wide" data-act="mill-go"' + (canGo ? '' : ' disabled') + '>' + label + '</button>' +
      '<button class="ghost" data-act="close">关闭</button></div>';
    return h;
  }
  if (ui.panel === 'orders') {
    let h = '<div class="panel"><h3>📋 订单板</h3>';
    for (let i = 0; i < 3; i++) {
      const o = S.orders[i];
      if (!o) {
        const left = Math.max(0, S.refill[i] - now);
        h += '<div class="ocard wait" data-slot="' + i + '">🧺 新订单准备中… ' + fmt(left) + '</div>';
      } else {
        let items = '';
        for (const [k, n] of Object.entries(o.items)) {
          const have = S.inv[k] >= n;
          items += '<span class="' + (have ? 'ok' : 'miss') + '">' + ITEMS[k].emoji + '×' + n + '</span>';
        }
        h += '<div class="ocard"><div class="oitems">' + items + '</div>' +
          '<div class="oreward">报酬：🪙 ' + o.coins + ' · ⭐ ' + o.xp + ' 经验</div>' +
          '<div class="obtns">' +
          '<button class="btn" data-act="deliver" data-i="' + i + '"' + (canDeliver(o) ? '' : ' disabled') + '>交付</button>' +
          '<button class="btn gray" data-act="reject" data-i="' + i + '">拒绝</button>' +
          '</div></div>';
      }
    }
    h += '<div class="hint">订单是经验的主要来源（直接卖货只有钱没有经验）。拒绝无惩罚。</div>' +
      '<button class="ghost" data-act="close">关闭</button></div>';
    return h;
  }
  if (ui.panel === 'sell') {
    const k = ui.sellItem, it = ITEMS[k];
    return '<div class="panel"><h3>' + it.emoji + ' 出售 ' + it.name + '</h3>' +
      '<div class="hint">持有 ' + S.inv[k] + ' 个 · 单价 ' + it.sell + ' 🪙（订单收购价约为市价的 1.8 倍）</div>' +
      '<button class="btn wide" data-act="sell1" data-item="' + k + '"' + (S.inv[k] > 0 ? '' : ' disabled') + '>卖出 1 个</button>' +
      '<button class="btn gold wide" data-act="sellall" data-item="' + k + '"' + (S.inv[k] > 0 ? '' : ' disabled') + '>全部卖出</button>' +
      '<button class="ghost" data-act="close">关闭</button></div>';
  }
  if (ui.panel === 'help') {
    return '<div class="panel"><h3>❔ 玩法说明</h3><div class="hint" style="font-size:13px;line-height:2">' +
      '1. 点棕色耕地播种，作物按<b>真实时间</b>生长，关掉页面也在长<br>' +
      '2. 🌿牧草×3 → 🏭饲料机 → 🌽饲料 → 喂鸡 → 🥚鸡蛋<br>' +
      '3. 📋订单板交货 = 金币 + 大量经验（直接卖货没有经验）<br>' +
      '4. 升级解锁：Lv2 小麦 🌾 · Lv3 新耕地 ×2（MVP 封顶 Lv5）<br>' +
      '5. 仓库点物品可卖出；存档自动保存在本浏览器<br>' +
      '6. ♻️ 重置存档从头开始</div>' +
      '<button class="btn wide" data-act="close">开始务农！</button></div>';
  }
  return '';
}

/* 面板状态签名：结构变化才重绘面板，否则每秒只改文本 */
function panelSig(now) {
  if (ui.panel === 'coop') return S.chickens.map(ch => !ch.fed ? 'H' : (now >= ch.eggReadyAt ? 'R' : 'G')).join('');
  if (ui.panel === 'mill') return (S.mill.run ? (now >= S.mill.run.startAt + S.mill.run.ms ? 'D' : 'B') : 'N') + S.mill.queue + (S.inv.grass >= MILL.inQty ? 1 : 0);
  if (ui.panel === 'orders') return S.orders.map(o => o ? Object.entries(o.items).map(([k, n]) => k + (S.inv[k] >= n ? '+' : '-')).join('') : 'W').join('|');
  if (ui.panel === 'seed') return lv() + ':' + S.coins;
  return '';
}

/* ---------- 每秒原位刷新（不重建节点，不吞点击） ---------- */
function tickFarm(now) {
  // 耕地：只更新已播种地块的 class 与内层
  document.querySelectorAll('#farm [data-act="plot"]').forEach(btn => {
    const i = +btn.dataset.i;
    if (!S.plots[i].crop) return;
    const cls = plotClass(i, now);
    if (btn.className !== cls) btn.className = cls;
    btn.innerHTML = plotInner(i, now);
  });
  const coopBtn = document.querySelector('[data-act="open-coop"]');
  if (coopBtn) coopBtn.innerHTML = coopInner(now);
  const millBtn = document.querySelector('[data-act="open-mill"]');
  if (millBtn) millBtn.innerHTML = millInner(now);
  const boardBtn = document.querySelector('[data-act="open-board"]');
  if (boardBtn) boardBtn.innerHTML = boardInner();
}
function tickPanel(now) {
  if (!ui.panel) return;
  const sig = panelSig(now);
  if (sig !== lastPanelSig) { lastPanelSig = sig; renderOverlay(); return; }
  // 结构没变，只更新倒计时文本
  if (ui.panel === 'coop') {
    document.querySelectorAll('.panel .timer').forEach(el => {
      const i = +el.dataset.chick;
      const ch = S.chickens[i];
      if (ch.fed && now < ch.eggReadyAt) el.textContent = fmt(ch.eggReadyAt - now);
    });
  } else if (ui.panel === 'mill' && S.mill.run) {
    const left = S.mill.run.startAt + S.mill.run.ms - now;
    if (left > 0) {
      const prog = 1 - left / S.mill.run.ms;
      const bar = document.querySelector('.panel .pbar i');
      if (bar) bar.style.width = (prog * 100).toFixed(1) + '%';
      const hint = document.querySelector('.panel .mill-hint');
      if (hint) hint.textContent = '加工中… 剩 ' + fmt(left) + (S.mill.queue > 0 ? '（排队中 ×' + S.mill.queue + '）' : '');
    }
  } else if (ui.panel === 'orders') {
    document.querySelectorAll('.panel .ocard.wait').forEach(el => {
      const i = +el.dataset.slot;
      el.textContent = '🧺 新订单准备中… ' + fmt(Math.max(0, S.refill[i] - now));
    });
  }
}

/* ---------- 事件（全量委托） ---------- */
document.addEventListener('click', e => {
  lastClick.x = e.clientX; lastClick.y = e.clientY;
  const b = e.target.closest('[data-act]');
  if (!b) {
    if (e.target === $('overlay')) { closePanel(); render(); }
    return;
  }
  const act = b.dataset.act;
  switch (act) {
    case 'wild': toast('这片地还没开垦（扩地功能 v0.2 上线）'); break;
    case 'plot': {
      const i = +b.dataset.i;
      const p = S.plots[i];
      if (!p.crop) { ui.panel = 'seed'; ui.seedIdx = i; render(); }
      else if (Date.now() >= p.readyAt) harvest(i);
      else toast('还有 ' + fmt(p.readyAt - Date.now()) + ' 成熟');
      return;
    }
    case 'seed': plant(+b.dataset.i, b.dataset.crop); closePanel(); break;
    case 'open-coop': ui.panel = 'coop'; render(); return;
    case 'open-mill': ui.panel = 'mill'; render(); return;
    case 'open-board': ui.panel = 'orders'; render(); return;
    case 'feed': feedChicken(+b.dataset.i); break;
    case 'egg': collectEgg(+b.dataset.i); break;
    case 'mill-go': millGo(); break;
    case 'mill-take': millTake(); break;
    case 'deliver': deliver(+b.dataset.i); break;
    case 'reject': reject(+b.dataset.i); break;
    case 'sell-open': ui.panel = 'sell'; ui.sellItem = b.dataset.item; render(); return;
    case 'sell1': sell(b.dataset.item, 1); break;
    case 'sellall': sell(b.dataset.item, Infinity); break;
    case 'help': ui.panel = 'help'; render(); return;
    case 'close': closePanel(); break;
    case 'reset':
      if (confirm('确定重置存档？所有进度将清空。')) {
        try { localStorage.removeItem(SAVE_KEY); } catch (err) { }
        location.reload();
      }
      return;
  }
  render();
});

/* ---------- 离线结算 ---------- */
function settle() {
  const now = Date.now();
  const away = now - S.lastSeen;
  if (away > 120e3) {
    const readyCrops = S.plots.filter(p => p.crop && now >= p.readyAt).length;
    const readyEggs = S.chickens.filter(ch => ch.fed && now >= ch.eggReadyAt).length;
    const millDone = S.mill.run && now >= S.mill.run.startAt + S.mill.run.ms;
    let msg = '欢迎回来！离开了 ' + fmt(away);
    if (readyCrops) msg += '，' + readyCrops + ' 块作物成熟';
    if (readyEggs) msg += '，' + readyEggs + ' 个鸡蛋可收';
    if (millDone) msg += '，饲料加工完成';
    toast(msg);
  }
}

/* ---------- 启动 ---------- */
let S = load();
const isNew = !S;
if (isNew) S = newGame();

// 初始订单
for (let i = 0; i < 3; i++) if (!S.orders[i]) S.orders[i] = genOrder();

settle();
save();
render();
if (isNew) setTimeout(() => toast('欢迎来到小龙庄园！点棕色耕地 ➕ 播种开始 🌱'), 600);

// 每秒：补订单 + 原位刷新倒计时/徽标；每 15 秒兜底存档
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let i = 0; i < 3; i++) {
    if (!S.orders[i] && S.refill[i] && now >= S.refill[i]) {
      S.orders[i] = genOrder();
      S.refill[i] = 0;
      changed = true;
    }
  }
  tickFarm(now);
  tickPanel(now);
  if (changed) save();
}, 1000);
setInterval(save, 15000);
window.addEventListener('beforeunload', save);
