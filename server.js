const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Connection test</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px 18px 60px; background:#0f1115; color:#e8e8ea; font:16px/1.45 -apple-system, system-ui, sans-serif; max-width:640px; margin-inline:auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:#9aa0aa; }
  button { font:inherit; font-weight:600; padding:14px 22px; border-radius:12px; border:0; background:#3b82f6; color:#fff; width:100%; }
  button:disabled { background:#2a3140; color:#8a93a3; }
  #verdict { margin:18px 0 6px; padding:16px; border-radius:12px; background:#1a1e27; display:none; }
  #verdict b { font-size:20px; display:block; margin-bottom:4px; }
  .good { border-left:6px solid #22c55e; } .ok { border-left:6px solid #eab308; } .bad { border-left:6px solid #ef4444; }
  table { width:100%; border-collapse:collapse; margin-top:14px; }
  td { padding:7px 4px; border-bottom:1px solid #232834; }
  td:last-child { text-align:right; font-variant-numeric:tabular-nums; }
  #log { margin-top:16px; font:13px/1.5 ui-monospace, Menlo, monospace; color:#9aa0aa; white-space:pre-wrap; }
  #copy { margin-top:14px; background:#2a3140; display:none; }
</style></head><body>
<h1>Connection test</h1>
<p class="sub">Tap the button and wait about 20 seconds. Keep this page open and on screen.</p>
<button id="go">Run test</button>
<div id="verdict"></div>
<table id="tbl"></table>
<button id="copy">Copy results</button>
<div id="log"></div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var logEl = $('log'), lines = [];
  function log(s) { lines.push(s); logEl.textContent = lines.join('\\n'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function stats(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var sum = 0, i; for (i = 0; i < a.length; i++) sum += a[i];
    var j = 0; for (i = 1; i < a.length; i++) j += Math.abs(a[i] - a[i - 1]);
    return { min: s[0], med: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1], avg: sum / a.length, jitter: a.length > 1 ? j / (a.length - 1) : 0 };
  }
  function ms(x) { return x == null ? '-' : Math.round(x) + ' ms'; }

  async function httpPings(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = performance.now();
      try { await fetch('/ping?' + Math.random(), { cache: 'no-store' }); out.push(performance.now() - t); } catch (e) {}
      await sleep(80);
    }
    return out;
  }

  function openWS() {
    return new Promise(function (resolve, reject) {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      var t0 = performance.now(), done = false;
      var ws = new WebSocket(proto + location.host + '/ws');
      var timer = setTimeout(function () { if (!done) { done = true; try { ws.close(); } catch (e) {} reject(new Error('timed out after 10 seconds')); } }, 10000);
      ws.onopen = function () { if (!done) { done = true; clearTimeout(timer); resolve({ ws: ws, connectMs: performance.now() - t0 }); } };
      ws.onerror = function () { if (!done) { done = true; clearTimeout(timer); reject(new Error('connection refused or blocked')); } };
      ws.onclose = function (e) { if (!done) { done = true; clearTimeout(timer); reject(new Error('closed during connect (code ' + e.code + ')')); } };
    });
  }

  async function run() {
    $('go').disabled = true; $('verdict').style.display = 'none'; $('copy').style.display = 'none'; $('tbl').innerHTML = ''; lines = []; logEl.textContent = '';
    var R = { when: new Date().toString(), page: location.host };

    log('1/4 Normal web request speed...');
    var h = stats(await httpPings(10)); R.http = h;
    if (h) log('    median ' + ms(h.med)); else log('    FAILED');

    log('2/4 Opening a live connection (WebSocket)...');
    var conn;
    try { conn = await openWS(); }
    catch (e) { R.wsError = e.message; log('    FAILED: ' + e.message); return finish(R); }
    var ws = conn.ws; R.connectMs = conn.connectMs; log('    connected in ' + ms(conn.connectMs));

    var closedEarly = null, pending = {}, rtts = [], got = {}, order = 0, lastSeq = -1, outOfOrder = 0, lateMsgs = 0;
    ws.onclose = function (e) { if (closedEarly === null && !R.finishedOK) closedEarly = 'code ' + e.code + (e.reason ? ' ' + e.reason : ''); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      var now = performance.now();
      if (m.k === 'p') { if (pending[m.i] != null) { rtts.push(now - pending[m.i]); delete pending[m.i]; } }
      else if (m.k === 'r') {
        got[m.i] = now - m.ts;
        if (m.i < lastSeq) outOfOrder++; lastSeq = Math.max(lastSeq, m.i);
        if (now - m.ts > 500) lateMsgs++;
      }
    };

    log('3/4 Delay test (20 quick pings)...');
    for (var i = 0; i < 20 && closedEarly === null; i++) {
      pending[i] = performance.now(); try { ws.send(JSON.stringify({ k: 'p', i: i })); } catch (e) {}
      await sleep(150);
    }
    await sleep(600);
    var r = stats(rtts); R.ws = r; R.pingsSent = 20; R.pingsBack = rtts.length;
    if (r) log('    median ' + ms(r.med) + ', worst ' + ms(r.max) + ', ' + rtts.length + '/20 answered'); else log('    no answers');

    log('4/4 Game-like traffic (15 messages per second for 10 seconds)...');
    var pad = new Array(90).join('x'), sent = 0;
    var tEnd = performance.now() + 10000, k = 0;
    while (performance.now() < tEnd && closedEarly === null) {
      var ts = performance.now(); try { ws.send(JSON.stringify({ k: 'r', i: k, ts: ts, d: pad })); sent++; } catch (e) {} k++;
      await sleep(1000 / 15);
    }
    await sleep(1200);
    var recv = Object.keys(got).length; R.sent = sent; R.recv = recv; R.outOfOrder = outOfOrder; R.late = lateMsgs;
    var rr = stats(Object.keys(got).map(function (x) { return got[x]; })); R.stream = rr;
    log('    ' + recv + ' of ' + sent + ' messages came back' + (rr ? ', median ' + ms(rr.med) + ', worst ' + ms(rr.max) : ''));
    R.closedEarly = closedEarly; R.finishedOK = true;
    try { ws.close(); } catch (e) {}
    finish(R);
  }

  function finish(R) {
    var v = $('verdict'), cls, head, body;
    var loss = R.sent ? (1 - R.recv / R.sent) : 1;
    var med = R.ws ? R.ws.med : 9999, p95 = R.ws ? R.ws.p95 : 9999;
    if (R.wsError) {
      cls = 'bad'; head = 'BLOCKED: live connection did not work';
      body = (R.http ? 'Normal web pages work here, but a live connection could not be opened (' : 'Even normal requests to this address failed, and a live connection could not be opened (') + R.wsError + '). Multiplayer will not work on this network. Try a phone hotspot to confirm it is the Wi-Fi.';
    } else if (R.closedEarly) {
      cls = 'bad'; head = 'BAD: the connection was cut off';
      body = 'It opened but this network closed it (' + R.closedEarly + '). Multiplayer would drop out here.';
    } else if (loss > 0.03 || R.pingsBack < 18) {
      cls = 'bad'; head = 'BAD: messages are getting lost';
      body = Math.round(loss * 100) + '% of game messages never came back. Players would freeze or teleport.';
    } else if (med <= 100 && p95 <= 250 && loss <= 0.01) {
      cls = 'good'; head = 'GOOD: multiplayer should work well here';
      body = 'Live connection works, delay is low and nothing was lost.';
    } else if (med <= 200 && p95 <= 500) {
      cls = 'ok'; head = 'OK: playable, but other players may look a bit jumpy';
      body = 'The connection works but the delay is on the high side.';
    } else {
      cls = 'bad'; head = 'POOR: delay is very high';
      body = 'It works but the delay is too large for smooth play.';
    }
    v.className = cls; v.style.display = 'block'; v.innerHTML = '<b>' + head + '</b>' + body;
    var rows = [
      ['Normal web request (median)', R.http ? ms(R.http.med) : 'failed'],
      ['Time to open live connection', R.connectMs != null ? ms(R.connectMs) : 'failed'],
      ['Live ping, median', R.ws ? ms(R.ws.med) : '-'],
      ['Live ping, best / worst', R.ws ? ms(R.ws.min) + ' / ' + ms(R.ws.max) : '-'],
      ['Jitter (how much it wobbles)', R.ws ? ms(R.ws.jitter) : '-'],
      ['Messages lost (game-like test)', R.sent ? (R.sent - R.recv) + ' of ' + R.sent : '-'],
      ['Messages arriving out of order / late', R.sent ? R.outOfOrder + ' / ' + R.late : '-'],
      ['Connection cut off early', R.closedEarly ? 'yes (' + R.closedEarly + ')' : 'no']
    ];
    $('tbl').innerHTML = rows.map(function (x) { return '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td></tr>'; }).join('');
    window.__resultText = head + '\\n' + body + '\\n\\n' + rows.map(function (x) { return x[0] + ': ' + x[1]; }).join('\\n') + '\\n\\nHost: ' + R.page + '\\nTime: ' + R.when;
    $('copy').style.display = 'block'; $('go').disabled = false; $('go').textContent = 'Run test again';
  }

  $('go').onclick = function () { run().catch(function (e) { log('Unexpected error: ' + e.message); $('go').disabled = false; }); };
  $('copy').onclick = function () {
    var t = window.__resultText || '';
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { $('copy').textContent = 'Copied'; }, function () { $('copy').textContent = 'Copy failed - screenshot instead'; });
  };
})();
</script></body></html>`;
// ============================================================================
//  OPEN WORLD COMBAT - multiplayer server (Cloudflare Worker + Durable Objects)
//
//  Step 1: admin switch, usage budget, rooms and lobby. No gameplay yet.
//
//  Routes
//    GET  /conntest         connection test page (when the game's files are hosted here too; otherwise also /)
//    GET  /mp/status         public: is multiplayer on?
//    GET  /mp/ws             WebSocket: create or join a room
//    POST /mp/admin/login    password -> short-lived token
//    GET  /mp/admin/status   (token) rooms, usage, limits
//    POST /mp/admin/enable   (token) turn multiplayer on/off (off = kick everyone)
//    POST /mp/admin/kickall  (token) close every room, stay on
//    POST /mp/admin/limits   (token) change limits
//
//  The admin password is NOT in this file. It lives in a Cloudflare secret
//  named ADMIN_PASSWORD (Worker -> Settings -> Variables and Secrets).
// ============================================================================
import { DurableObject } from 'cloudflare:workers';

const SERVER_VERSION = 'online-match-v2';   // the game checks this, so an out-of-date server is spotted straight away

const DEFAULT_CFG = {
  enabled: true,
  maxRooms: 3,              // rooms open at the same time
  dailyBudget: 70000,       // estimated Cloudflare requests per day we allow ourselves (free plan = 100,000)
  idleRoomSeconds: 600,     // a room nobody does anything in for this long is closed
  playerIdleSeconds: 75,    // a player we hear nothing from for this long is dropped
  maxRoomSeconds: 3 * 3600, // hard cap on a room's lifetime
  disabledReason: '',
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CLOSE = { OFF: 4001, IDLE: 4004, FULL: 4003, NOROOM: 4005, BUDGET: 4006, RATE: 4008, KICK: 4009, LEFT: 1000 };
const TOKEN_LIFETIME_MS = 2 * 3600 * 1000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
const today = () => new Date().toISOString().slice(0, 10);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function safeEqual(a, b) { // constant-time string compare (both are hex digests of equal length)
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function cleanName(raw) {
  let s = String(raw || '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 16);
  return s || 'Player';
}
function newCode() {
  const a = new Uint8Array(5); crypto.getRandomValues(a);
  return [...a].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

// ---------------------------------------------------------------------------
//  Control: one global object. Holds the on/off switch, limits, usage and the
//  list of open rooms. Everything that costs budget goes through here.
// ---------------------------------------------------------------------------
export class Control extends DurableObject {
  async cfg() {
    const saved = (await this.ctx.storage.get('cfg')) || {};
    return { ...DEFAULT_CFG, ...saved };
  }
  async saveCfg(c) { await this.ctx.storage.put('cfg', c); }

  // Usage resets every UTC day (same moment Cloudflare resets its own limits).
  async usage() {
    let u = (await this.ctx.storage.get('usage')) || { day: today(), units: 0 };
    if (u.day !== today()) u = { day: today(), units: 0 };
    return u;
  }
  async addUnits(n) {
    const u = await this.usage(); u.units += n; await this.ctx.storage.put('usage', u); return u;
  }

  async rooms() { return (await this.ctx.storage.get('rooms')) || {}; }

  async getPublic() {
    await this.addUnits(1);
    const c = await this.cfg();
    return { enabled: c.enabled, reason: c.enabled ? '' : c.disabledReason || 'Multiplayer is turned off right now' };
  }

  // Called by the Worker before a WebSocket is handed to a room.
  async authorize(create, code, size) {
    const c = await this.cfg();
    const u = await this.addUnits(1);
    if (!c.enabled) return { ok: false, close: CLOSE.OFF, error: c.disabledReason || 'Multiplayer is turned off right now' };
    if (u.units >= c.dailyBudget) {
      await this.disable('Daily online budget used up. It resets at 00:00 UTC.');
      return { ok: false, close: CLOSE.BUDGET, error: 'Daily online budget used up. Try again tomorrow.' };
    }
    const rooms = await this.rooms();
    this.sweep(rooms, c);
    if (create) {
      if (Object.keys(rooms).length >= c.maxRooms) return { ok: false, close: CLOSE.FULL, error: 'All rooms are busy right now. Try again in a few minutes.' };
      let k = ''; do { k = newCode(); } while (rooms[k]);
      rooms[k] = { createdAt: Date.now(), updatedAt: Date.now(), players: 0 };
      await this.ctx.storage.put('rooms', rooms);
      return { ok: true, code: k, size: size === 2 ? 2 : 3, create: true };
    }
    if (!rooms[code]) return { ok: false, close: CLOSE.NOROOM, error: 'No room with that code.' };
    return { ok: true, code, create: false };
  }

  // Rooms that stopped reporting (crashed / forgotten) are dropped from the list.
  sweep(rooms, c) {
    const now = Date.now();
    for (const k of Object.keys(rooms)) {
      const r = rooms[k];
      if (now - r.updatedAt > (c.idleRoomSeconds + 120) * 1000 || now - r.createdAt > c.maxRoomSeconds * 1000 + 120000) delete rooms[k];
    }
  }

  // Rooms report their player count and the budget they used.
  async roomUpdate(code, players, units) {
    const u = await this.addUnits(units + 1);
    const c = await this.cfg();
    const rooms = await this.rooms();
    if (rooms[code]) {
      if (players <= 0) delete rooms[code]; else { rooms[code].players = players; rooms[code].updatedAt = Date.now(); }
      await this.ctx.storage.put('rooms', rooms);
    }
    if (u.units >= c.dailyBudget && c.enabled) await this.disable('Daily online budget used up. It resets at 00:00 UTC.');
  }
  async roomClosed(code) {
    const rooms = await this.rooms();
    if (rooms[code]) { delete rooms[code]; await this.ctx.storage.put('rooms', rooms); }
  }

  // Turn multiplayer off and kick everyone.
  async disable(reason) {
    const c = await this.cfg(); c.enabled = false; c.disabledReason = reason || ''; await this.saveCfg(c);
    await this.closeAllRooms(reason || 'Multiplayer was turned off');
  }
  async closeAllRooms(reason) {
    const rooms = await this.rooms();
    for (const code of Object.keys(rooms)) {
      try { await this.env.ROOM.get(this.env.ROOM.idFromName(code)).shutdown(reason, CLOSE.OFF); } catch (e) { /* room already gone */ }
    }
    await this.ctx.storage.put('rooms', {});
  }

  // ---------- admin ----------
  async login(ip, password) {
    const now = Date.now();
    const fails = (await this.ctx.storage.get('fails')) || {};
    const g = (await this.ctx.storage.get('gfails')) || { n: 0, until: 0 };
    const f = fails[ip] || { n: 0, until: 0 };
    if (g.until > now) return { ok: false, error: 'Admin login is locked for a while. Try again later.' };
    if (f.until > now) return { ok: false, error: 'Too many wrong passwords. Try again in 15 minutes.' };
    const real = this.env.ADMIN_PASSWORD;
    if (!real) return { ok: false, error: 'No admin password is set on the server yet (secret ADMIN_PASSWORD).' };
    const same = safeEqual(await sha256Hex(String(password || '')), await sha256Hex(String(real)));
    if (!same) {
      f.n += 1; if (f.n >= 5) { f.until = now + 15 * 60000; f.n = 0; }
      fails[ip] = f;
      g.n += 1; if (g.n >= 20) { g.until = now + 3600000; g.n = 0; }
      await this.ctx.storage.put('fails', fails); await this.ctx.storage.put('gfails', g);
      return { ok: false, error: 'Wrong password.' };
    }
    delete fails[ip]; await this.ctx.storage.put('fails', fails);
    const raw = new Uint8Array(32); crypto.getRandomValues(raw);
    const token = hex(raw);
    const tokens = (await this.ctx.storage.get('tokens')) || {};
    for (const k of Object.keys(tokens)) if (tokens[k] < now) delete tokens[k];
    tokens[await sha256Hex(token)] = now + TOKEN_LIFETIME_MS;
    await this.ctx.storage.put('tokens', tokens);
    return { ok: true, token };
  }
  async checkToken(token) {
    if (!token) return false;
    const tokens = (await this.ctx.storage.get('tokens')) || {};
    const exp = tokens[await sha256Hex(String(token))];
    return !!exp && exp > Date.now();
  }
  async adminStatus(token) {
    if (!(await this.checkToken(token))) return { ok: false, auth: false };
    const c = await this.cfg(); const u = await this.usage(); const rooms = await this.rooms();
    this.sweep(rooms, c);
    return {
      ok: true, enabled: c.enabled, reason: c.disabledReason, cfg: c,
      usage: { day: u.day, units: Math.round(u.units), budget: c.dailyBudget },
      rooms: Object.keys(rooms).map((k) => ({ code: k, players: rooms[k].players, ageSeconds: Math.round((Date.now() - rooms[k].createdAt) / 1000) })),
    };
  }
  async adminSetEnabled(token, on) {
    if (!(await this.checkToken(token))) return { ok: false, auth: false };
    if (on) { const c = await this.cfg(); c.enabled = true; c.disabledReason = ''; await this.saveCfg(c); }
    else await this.disable('Multiplayer was turned off by the owner.');
    return this.adminStatus(token);
  }
  async adminKickAll(token) {
    if (!(await this.checkToken(token))) return { ok: false, auth: false };
    await this.closeAllRooms('The owner closed all rooms.');
    return this.adminStatus(token);
  }
  async adminLimits(token, patch) {
    if (!(await this.checkToken(token))) return { ok: false, auth: false };
    const c = await this.cfg();
    const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : null);
    const set = (key, v, lo, hi) => { const n = num(v, lo, hi); if (n !== null && v !== undefined && v !== '') c[key] = n; };
    set('maxRooms', patch.maxRooms, 1, 10);
    set('dailyBudget', patch.dailyBudget, 1000, 95000);
    set('idleRoomSeconds', patch.idleRoomSeconds, 30, 3600);
    set('playerIdleSeconds', patch.playerIdleSeconds, 20, 600);
    await this.saveCfg(c);
    return this.adminStatus(token);
  }
}

// ---------------------------------------------------------------------------
//  Room: one object per match lobby. Uses WebSocket hibernation, so while
//  nobody sends anything it sleeps and costs (almost) nothing.
//
//  Everything is rebuilt from the live sockets + a little saved info, because
//  the object can be evicted from memory and woken up again at any time.
//
//  Room phases:  lobby  ->  starting (leader pressed start, everyone loads)
//                       ->  playing  (everyone is ready, plane takes off)
// ---------------------------------------------------------------------------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.units = 0;               // budget used since last report to Control
    this.rate = new WeakMap();    // per-socket message counter (resets if we wake up; fine)
    this.meta = undefined;        // cached copy of the saved room info (undefined = not loaded yet)
    this.lastPoseAt = 0;          // last time a position update came in (memory only - keeps a live match from looking idle)
  }

  control() { return this.env.CONTROL.get(this.env.CONTROL.idFromName('main')); }
  async cfg() { return this.control().cfg(); }
  async loadMeta() { if (this.meta === undefined) this.meta = (await this.ctx.storage.get('meta')) || null; return this.meta; }
  async saveMeta() { if (this.meta) await this.ctx.storage.put('meta', this.meta); }

  players() {
    return this.ctx.getWebSockets()
      .map((ws) => ({ ws, a: ws.deserializeAttachment() }))
      .filter((p) => p.a)
      .sort((x, y) => x.a.seq - y.a.seq);
  }
  livePlayers() { return this.players().filter((p) => p.ws.readyState === 1); }
  snapshot(meta, ps) {
    ps = ps || this.players();
    return {
      t: 'lobby', code: meta.code, teamSize: meta.teamSize, phase: meta.phase || 'lobby',
      leader: ps.length ? ps[0].a.id : null,
      players: ps.map((p) => ({ id: p.a.id, name: p.a.name })),
    };
  }
  broadcast(obj) { this.sendAll(JSON.stringify(obj), null); }
  sendAll(str, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(str); } catch (e) { /* closing */ }
    }
  }

  async report() {
    const meta = await this.loadMeta(); if (!meta) return;
    const n = this.livePlayers().length; const u = this.units; this.units = 0;
    try { await this.control().roomUpdate(meta.code, n, u); } catch (e) { /* try again next time */ }
  }

  // The Worker forwards the WebSocket upgrade here.
  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const create = url.searchParams.get('create') === '1';
    const name = cleanName(url.searchParams.get('name'));
    let meta = await this.loadMeta();
    if (create && !meta) {
      const size = url.searchParams.get('size') === '2' ? 2 : 3;
      meta = { code, teamSize: size, createdAt: Date.now(), lastActivity: Date.now(), nextSeq: 1, nextId: 1, phase: 'lobby' };
      this.meta = meta; await this.saveMeta();
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const refuse = (close, msg) => {
      server.send(JSON.stringify({ t: 'error', msg })); server.close(close, msg.slice(0, 100));
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!meta) return refuse(CLOSE.NOROOM, 'No room with that code.'); // should not happen (Worker checked with Control first)
    if ((meta.phase || 'lobby') !== 'lobby') return refuse(CLOSE.FULL, 'That match has already started.');
    if (this.livePlayers().length >= meta.teamSize) return refuse(CLOSE.FULL, 'That room is full.');

    const att = { id: meta.nextId, seq: meta.nextSeq, name, lastSeen: Date.now(), ready: false };
    meta.nextId += 1; meta.nextSeq += 1; meta.lastActivity = Date.now();
    await this.saveMeta();
    server.serializeAttachment(att);
    this.units += 1;

    server.send(JSON.stringify({ t: 'welcome', you: att.id }));
    this.broadcast(this.snapshot(meta));
    await this.report();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 30000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    this.units += 1 / 20;
    // Flood guard: more than 60 messages in one second = disconnect.
    const now = Date.now(); let r = this.rate.get(ws);
    if (!r || now - r.t > 1000) { r = { t: now, n: 0 }; this.rate.set(ws, r); }
    if (++r.n > 60) { try { ws.send(JSON.stringify({ t: 'closed', reason: 'Disconnected: too many messages.' })); ws.close(CLOSE.RATE, 'Too many messages'); } catch (e) {} return; }
    if (typeof message !== 'string' || message.length > 12000) return;
    let m; try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'b' && message.length > 2000) return;       // only the leader's bot snapshots may be big
    const a = ws.deserializeAttachment(); if (!a) return;
    if (now - a.lastSeen > 1000) { a.lastSeen = now; ws.serializeAttachment(a); }   // at most once a second
    if (m.t === 'hb') { ws.send('{"t":"hbr"}'); return; }

    const meta = await this.loadMeta(); if (!meta) return;
    const phase = meta.phase || 'lobby';

    // ----- position updates: forwarded to everyone else, stamped with who sent it -----
    if (m.t === 'p') {
      if (phase !== 'playing') return;
      const d = m.d;
      if (!Array.isArray(d) || d.length < 6 || d.length > 10) return;
      for (let i = 0; i < d.length; i++) if (typeof d[i] !== 'number' || !Number.isFinite(d[i]) || Math.abs(d[i]) > (i < 3 ? 100000 : 1e10)) return;   // x,y,z must be on the map; the rest (angles, flags, clock) just have to be sane numbers
      this.lastPoseAt = now;
      this.sendAll('{"t":"p","i":' + a.id + ',"d":' + JSON.stringify(d) + '}', ws);
      return;
    }

    meta.lastActivity = now;
    const ps = this.livePlayers();
    const isLeader = ps.length > 0 && ps[0].a.id === a.id;

    // ----- bot snapshots: only the leader's device runs the bots; everyone else just displays them -----
    if (m.t === 'b') {
      if (phase !== 'playing' || !isLeader) return;
      if (!Array.isArray(m.d) || !Array.isArray(m.s) || !Number.isFinite(m.ts)) return;
      this.lastPoseAt = now;
      this.sendAll(message, ws);
      return;
    }
    // ----- small messages between devices: to the leader, to everybody, or to one player (hits, damage, kills, match over...) -----
    if (m.t === 'fw') {
      if (phase !== 'playing') return;
      if (typeof m.k !== 'string' || m.k.length > 16) return;
      const str = '{"t":"fw","f":' + a.id + ',"k":' + JSON.stringify(m.k) + ',"d":' + JSON.stringify(m.d === undefined ? null : m.d) + '}';
      this.lastPoseAt = now;
      if (m.to === 'leader') { if (!isLeader && ps[0]) { try { ps[0].ws.send(str); } catch (e) {} } return; }
      if (m.to === 'all') { this.sendAll(str, ws); return; }
      if (Number.isInteger(m.to)) { const t = ps.find((p) => p.a.id === m.to); if (t && t.ws !== ws) { try { t.ws.send(str); } catch (e) {} } }
      return;
    }
    const err = (msg) => ws.send(JSON.stringify({ t: 'error', msg }));

    if (m.t === 'teamSize') {
      if (!isLeader) return err('Only the leader can change team size.');
      if (phase !== 'lobby') return err('You cannot change the team size during a match.');
      const n = m.n === 2 ? 2 : 3;
      if (ps.length > n) return err('Too many players in the room for a team of ' + n + '.');
      meta.teamSize = n; await this.saveMeta();
      this.broadcast(this.snapshot(meta, ps)); return;
    }
    if (m.t === 'start') {
      if (!isLeader) return err('Only the leader can start the match.');
      if (phase !== 'lobby') return err('The match has already started.');
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      meta.phase = 'starting'; meta.seed = seed; meta.startDeadline = now + 25000;
      meta.matchId = (meta.matchId || 0) + 1;
      for (const p of ps) { const at = p.a; at.ready = false; p.ws.serializeAttachment(at); }
      await this.saveMeta();
      this.broadcast({ t: 'start', seed, teamSize: meta.teamSize, matchId: meta.matchId, roster: ps.map((p) => ({ id: p.a.id, name: p.a.name })) });
      await this.ctx.storage.setAlarm(now + 25000);   // if somebody never reports ready, go anyway
      return;
    }
    if (m.t === 'ready') {
      if (phase !== 'starting') return;
      a.ready = true; ws.serializeAttachment(a);
      await this.maybeGo(meta);
      return;
    }
    if (m.t === 'ev') {
      // Events from the leader that the rest of the team must copy (jump out of the plane, open the parachute).
      if (phase !== 'playing' || !isLeader) return;
      if (m.k !== 'jump' && m.k !== 'chute') return;
      const x = Number.isFinite(m.x) ? m.x : 0, z = Number.isFinite(m.z) ? m.z : 0;
      this.sendAll('{"t":"ev","k":"' + m.k + '","x":' + x + ',"z":' + z + '}', ws);
      return;
    }
    if (m.t === 'toLobby') {
      if (!isLeader) return err('Only the leader can send everyone back to the lobby.');
      if (phase === 'lobby') return;
      meta.phase = 'lobby'; meta.seed = undefined; await this.saveMeta();
      for (const p of ps) { const at = p.a; at.ready = false; p.ws.serializeAttachment(at); }
      this.broadcast({ t: 'toLobby' });
      this.broadcast(this.snapshot(meta, ps)); return;
    }
  }

  // Everybody loaded (or the wait ran out): take off together.
  async maybeGo(meta, force) {
    if ((meta.phase || 'lobby') !== 'starting') return;
    const ps = this.livePlayers();
    if (!force && !ps.every((p) => p.a.ready)) return;
    meta.phase = 'playing'; meta.goAt = Date.now(); meta.lastActivity = Date.now();
    await this.saveMeta();
    this.broadcast({ t: 'go' });
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* already closed */ }
    await this.afterLeave();
  }
  async webSocketError(ws) { await this.afterLeave(); }

  async afterLeave() {
    const meta = await this.loadMeta(); if (!meta) return;
    const ps = this.livePlayers();
    if (ps.length === 0) { await this.destroy(); return; }
    this.broadcast(this.snapshot(meta, ps));
    await this.maybeGo(meta);      // the one we were waiting for may have been the one who left
    await this.report();
  }

  async destroy() {
    const meta = await this.loadMeta();
    this.meta = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (meta) { try { await this.control().roomClosed(meta.code); } catch (e) { /* ignore */ } }
  }

  // Owner switch / budget cap: send everyone home and wipe the room.
  async shutdown(reason, code) {
    this.broadcast({ t: 'closed', reason });
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(code || CLOSE.OFF, String(reason).slice(0, 100)); } catch (e) {} }
    this.meta = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Every 30s while the room exists: drop silent players, close idle rooms.
  // (Also fires once 25 s after a match is started, to take off even if someone never finished loading.)
  async alarm() {
    const meta = await this.loadMeta(); if (!meta) return;
    const c = await this.cfg(); const now = Date.now();
    this.units += 1;
    if ((meta.phase || 'lobby') === 'starting' && now >= (meta.startDeadline || 0)) await this.maybeGo(meta, true);
    let dropped = false;
    for (const p of this.players()) {
      if (now - p.a.lastSeen > c.playerIdleSeconds * 1000) {
        try { p.ws.send(JSON.stringify({ t: 'closed', reason: 'You were disconnected because nothing was heard from you.' })); p.ws.close(CLOSE.IDLE, 'Timed out'); } catch (e) {}
        dropped = true;
      }
    }
    const tooOld = now - meta.createdAt > c.maxRoomSeconds * 1000;
    const lastReal = Math.max(meta.lastActivity, this.lastPoseAt || 0);
    const idle = now - lastReal > c.idleRoomSeconds * 1000;
    if (tooOld || idle) {
      this.broadcast({ t: 'closed', reason: tooOld ? 'This room reached its time limit.' : 'Room closed because nobody did anything for a while.' });
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(CLOSE.IDLE, 'Room closed'); } catch (e) {} }
      await this.destroy(); return;
    }
    if (dropped) await this.afterLeave(); else await this.report();
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + ((meta.phase === 'starting') ? 25000 : 30000));
  }
}

// ---------------------------------------------------------------------------
//  Worker entry point
// ---------------------------------------------------------------------------
let statusCache = { at: 0, v: null };

function rejectSocket(close, msg) {
  const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
  server.accept();
  server.send(JSON.stringify({ t: 'error', msg }));
  server.close(close, msg.slice(0, 100));
  return new Response(null, { status: 101, webSocket: client });
}
function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const control = () => env.CONTROL.get(env.CONTROL.idFromName('main'));

    if (request.method === 'OPTIONS' && p.startsWith('/mp/')) return new Response(null, { status: 204, headers: CORS });

    // ---- multiplayer ----
    if (p === '/mp/status') {
      const now = Date.now();
      if (!statusCache.v || now - statusCache.at > 15000) { statusCache = { at: now, v: await control().getPublic() }; }
      return json({ ...statusCache.v, v: SERVER_VERSION });
    }
    if (p === '/mp/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket connection', { status: 426 });
      const create = url.searchParams.get('create') === '1';
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const size = url.searchParams.get('size') === '2' ? 2 : 3;
      if (!create && code.length < 4) return rejectSocket(CLOSE.NOROOM, 'Enter the room code.');
      const auth = await control().authorize(create, code, size);
      if (!auth.ok) { statusCache.at = 0; return rejectSocket(auth.close, auth.error); }
      const stub = env.ROOM.get(env.ROOM.idFromName(auth.code));
      const u = new URL(request.url);
      u.search = '';
      u.searchParams.set('code', auth.code);
      u.searchParams.set('name', url.searchParams.get('name') || '');
      if (auth.create) { u.searchParams.set('create', '1'); u.searchParams.set('size', String(auth.size)); }
      return stub.fetch(new Request(u.toString(), request));
    }

    // ---- admin ----
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (p === '/mp/admin/login' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch (e) {}
      const r = await control().login(ip, body.password);
      return json(r, r.ok ? 200 : 401);
    }
    if (p === '/mp/admin/status') { const r = await control().adminStatus(bearer(request)); return json(r, r.auth === false ? 401 : 200); }
    if (p === '/mp/admin/enable' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch (e) {}
      statusCache.at = 0;
      const r = await control().adminSetEnabled(bearer(request), !!body.enabled); return json(r, r.auth === false ? 401 : 200);
    }
    if (p === '/mp/admin/kickall' && request.method === 'POST') { const r = await control().adminKickAll(bearer(request)); return json(r, r.auth === false ? 401 : 200); }
    if (p === '/mp/admin/limits' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch (e) {}
      const r = await control().adminLimits(bearer(request), body); return json(r, r.auth === false ? 401 : 200);
    }

    // ---- connection test page (kept from before) ----
    if (p === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket connection', { status: 426 });
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      server.accept();
      server.addEventListener('message', (event) => {
        if (typeof event.data === 'string' && event.data.length < 2000) { try { server.send(event.data); } catch (e) {} }
      });
      server.addEventListener('close', () => { try { server.close(); } catch (e) {} });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === '/ping') return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    const testPage = () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (p === '/conntest') return testPage();
    // When this Worker also hosts the game's files, anything that is not an
    // /mp/ call goes to those files (a missing file is a normal 404).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return testPage();
  },
};
