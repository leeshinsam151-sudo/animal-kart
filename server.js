// 멀티플레이 레이싱 서버
// - 정적 파일 서빙 + WebSocket 으로 방(room) 단위 레이스 진행
// - 이동은 클라이언트 권한(client-authoritative), 서버는 중계/순위/완주 판정
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const LAPS = Number(process.env.LAPS) || 2; // 트랙이 약 4.9km 로 길어서 2랩 (테스트할 땐 LAPS=1)
const TICK_RATE = 20;            // 스냅샷 전송 빈도 (Hz)
const MAX_PLAYERS = 6;               // 6명 기준으로 트랙 폭·출발 그리드·아이템 박스 배치
const COUNTDOWN_MS = 3000;
const RESULTS_MS = 8000;         // 결과 화면 유지 시간
const AFTER_FIRST_FINISH_MS = 45000; // 1등 들어온 뒤 남은 사람 대기 시간
const MAX_RACE_MS = 10 * 60 * 1000;
const MIN_LAP_MS = 50000;        // 트랙 약 4.9km, 계속 부스터를 써도 한 바퀴 약 65초 → 여유 있게 50초
const MAX_BANANAS = 30;
const HEARTBEAT_MS = 5000;       // 연결 확인 주기 (응답 없으면 다음 주기에 끊음)
const RESUME_MS = 20000;         // 레이스 중 끊긴 사람의 자리를 남겨두는 시간
const CHARACTERS = ['panda', 'cat', 'dog', 'lion', 'tiger', 'eagle'];
const COLORS = ['#e63946', '#1d8cf8', '#ffb703', '#2ec4b6', '#9b5de5', '#f15bb5', '#fb8500', '#8ac926'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 }); // 정상 메시지는 1KB 미만 → 거대한 메시지로 메모리를 괴롭히는 것 차단

/** @type {Map<string, any>} */
const rooms = new Map();
let nextId = 1;

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, players: new Map(), phase: 'lobby', hostId: null, raceStart: 0, finishOrder: [], timers: [], bananas: new Map(), missiles: new Map(), nextHazard: 1 };
    rooms.set(code, room);
  }
  return room;
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); // 재접속 대기 중(ws 없음)이면 무시
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws?.readyState === 1) p.ws.send(data);
}

/** 놓친 상태 동기화 (관전자 입장, 재접속 시) */
function syncMsg(room) {
  return {
    type: 'sync',
    bananas: [...room.bananas].map(([id, b]) => ({ id, x: b.x, z: b.z, owner: b.owner })),
    finishOrder: room.finishOrder,
  };
}

/** 플레이어를 방에서 완전히 제거 */
function removePlayer(room, player) {
  clearTimeout(player.resumeTimer);
  if (room.players.get(player.id) !== player) return;
  room.players.delete(player.id);
  if (room.players.size === 0) {
    clearTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) {
    // 연결된 사람에게 방장 넘기기
    const next = [...room.players.values()].find((p) => p.ws) || room.players.values().next().value;
    room.hostId = next.id;
  }
  broadcast(room, { type: 'left', id: player.id });
  broadcast(room, lobbyMsg(room));
  checkRaceEnd(room);
}

function lobbyMsg(room) {
  return {
    type: 'lobby',
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, char: p.char, racing: p.racing, away: !p.ws })),
  };
}

function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
}

function startRace(room) {
  clearTimers(room);
  room.phase = 'countdown';
  room.finishOrder = [];
  room.bananas = new Map();
  room.missiles = new Map();
  const grid = [];
  let slot = 0;
  for (const p of room.players.values()) {
    if (!p.ws) { p.racing = false; continue; } // 연결이 끊겨 재접속 대기 중인 사람은 이번 판 제외
    Object.assign(p, { racing: true, finished: false, finishTime: null, progress: -1, s: null });
    grid.push({ id: p.id, slot: slot++ });
  }
  broadcast(room, lobbyMsg(room));
  broadcast(room, { type: 'countdown', ms: COUNTDOWN_MS, grid, laps: LAPS });
  room.timers.push(setTimeout(() => {
    if (room.phase !== 'countdown') return;
    room.phase = 'racing';
    room.raceStart = Date.now();
    broadcast(room, { type: 'go' });
    room.timers.push(setTimeout(() => endRace(room), MAX_RACE_MS));
  }, COUNTDOWN_MS));
}

function endRace(room) {
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  clearTimers(room);
  room.phase = 'results';
  const racers = [...room.players.values()].filter((p) => p.racing);
  const finished = racers.filter((p) => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const dnf = racers.filter((p) => !p.finished).sort((a, b) => b.progress - a.progress);
  const results = [...finished, ...dnf].map((p, i) => ({
    id: p.id, name: p.name, color: p.color, place: i + 1, time: p.finished ? p.finishTime : null,
  }));
  broadcast(room, { type: 'results', results });
  room.timers.push(setTimeout(() => {
    room.phase = 'lobby';
    for (const p of room.players.values()) { p.racing = false; p.s = null; }
    broadcast(room, lobbyMsg(room));
  }, RESULTS_MS));
}

function checkRaceEnd(room) {
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  const racers = [...room.players.values()].filter((p) => p.racing);
  if (racers.length === 0 || racers.every((p) => p.finished)) endRace(room);
}

wss.on('connection', (ws) => {
  let player = null;
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 연결 하나의 프로토콜 오류(너무 큰 메시지, 깨진 프레임 등)가 서버 전체를 죽이지 않도록
  ws.on('error', (err) => { console.warn('[ws error]', err.code || err.message); ws.terminate(); });

  ws.on('message', (raw) => {
    try { handle(raw); } catch (err) { console.warn('[message error]', err.message); } // 예상 못 한 입력도 이 메시지만 무시
  });

  const handle = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!player) {
      if (msg.type !== 'join') return;
      // 재접속: 레이스 중 끊겼던 자리로 복귀
      if (typeof msg.token === 'string') {
        for (const r of rooms.values()) {
          const old = [...r.players.values()].find((p) => p.token === msg.token);
          if (!old) continue;
          clearTimeout(old.resumeTimer);
          // 서버가 아직 못 알아챈 죽은 연결이 남아 있으면 새 연결로 교체
          if (old.ws && old.ws !== ws) { const stale = old.ws; old.ws = null; stale.terminate(); }
          old.ws = ws;
          player = old;
          room = r;
          send(ws, { type: 'welcome', id: player.id, room: room.code, laps: LAPS, phase: room.phase, token: player.token, resume: true });
          send(ws, syncMsg(room));
          broadcast(room, lobbyMsg(room));
          return;
        }
      }
      const code = String(msg.room || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'main';
      const r = getRoom(code);
      if (r.players.size >= MAX_PLAYERS) {
        send(ws, { type: 'error', message: `방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명)` });
        return;
      }
      const used = new Set([...r.players.values()].map((p) => p.color));
      room = r;
      player = {
        id: nextId++,
        name: String(msg.name || '').trim().slice(0, 16) || `Racer${nextId}`,
        // 원하는 색이 이미 쓰이고 있으면 남는 색 배정
        color: COLORS.includes(msg.color) && !used.has(msg.color) ? msg.color : COLORS.find((c) => !used.has(c)) || COLORS[0],
        char: CHARACTERS.includes(msg.char) ? msg.char : CHARACTERS[0],
        ws, racing: false, finished: false, finishTime: null, progress: 0, s: null,
        token: randomBytes(12).toString('hex'),
      };
      room.players.set(player.id, player);
      if (!room.hostId) room.hostId = player.id;
      send(ws, { type: 'welcome', id: player.id, room: room.code, laps: LAPS, phase: room.phase, token: player.token });
      if (room.phase !== 'lobby') send(ws, syncMsg(room)); // 관전자: 이미 깔린 바나나 등
      broadcast(room, lobbyMsg(room));
      return;
    }

    switch (msg.type) {
      case 'profile': {
        // 로비에서 캐릭터/카트 색 변경
        if (room.phase !== 'lobby') break;
        if (CHARACTERS.includes(msg.char)) player.char = msg.char;
        const taken = [...room.players.values()].some((p) => p !== player && p.color === msg.color);
        if (COLORS.includes(msg.color) && !taken) player.color = msg.color;
        broadcast(room, lobbyMsg(room));
        break;
      }

      case 'start':
        if (player.id === room.hostId && room.phase === 'lobby') startRace(room);
        break;

      case 'state': {
        if (!player.racing) break;
        const n = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
        player.s = [n(msg.x), n(msg.z), n(msg.ry), n(msg.sp), n(msg.st), (msg.fl | 0) & 31]; // fl: 1=드리프트, 2=부스터, 4=스핀, 8=물방울, 16=미사일 피격
        player.y = n(msg.y);
        if (!player.finished) player.progress = Number.isFinite(msg.p) ? Math.round(msg.p * 10000) / 10000 : 0;
        break;
      }

      case 'finish': {
        if (room.phase !== 'racing' || !player.racing || player.finished) break;
        // 아주 기초적인 검증: 서버가 마지막으로 받은 진행도가 완주 근처여야 함
        if (player.progress < LAPS - 0.05) break;
        if (Date.now() - room.raceStart < LAPS * MIN_LAP_MS) break;
        player.finished = true;
        player.finishTime = Date.now() - room.raceStart;
        player.progress = LAPS + 1 - room.finishOrder.length * 0.001;
        room.finishOrder.push(player.id);
        broadcast(room, { type: 'finished', id: player.id, name: player.name, time: player.finishTime, place: room.finishOrder.length });
        if (room.finishOrder.length === 1) room.timers.push(setTimeout(() => endRace(room), AFTER_FIRST_FINISH_MS));
        checkRaceEnd(room);
        break;
      }

      // ---------- 아이템 ----------
      case 'box': { // 아이템 박스를 깼음 → 다른 사람 화면에서도 사라지게
        if (room.phase !== 'racing' || !player.racing) break;
        const now = Date.now();
        if (now - (player.lastBox || 0) < 80) break; // 연타 방지
        player.lastBox = now;
        broadcast(room, { type: 'box', i: msg.i | 0, by: player.id });
        break;
      }

      case 'item': {
        if (room.phase !== 'racing' || !player.racing) break;
        const now = Date.now();
        if (now - (player.lastItem || 0) < 300) break; // 연타 방지
        player.lastItem = now;
        const x = Number(msg.x), z = Number(msg.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) break;
        const id = room.nextHazard++;
        if (msg.kind === 'banana') {
          room.bananas.set(id, { x, z, owner: player.id });
          broadcast(room, { type: 'banana', id, x, z, owner: player.id });
          if (room.bananas.size > MAX_BANANAS) {
            const oldest = room.bananas.keys().next().value;
            room.bananas.delete(oldest);
            broadcast(room, { type: 'bananaGone', id: oldest });
          }
        } else if (msg.kind === 'missile') {
          // 오래된 미사일 기록 정리
          for (const [mid, t] of room.missiles) if (now - t > 15000) room.missiles.delete(mid);
          room.missiles.set(id, now);
          const target = room.players.has(msg.target) ? msg.target : null;
          broadcast(room, { type: 'missile', id, owner: player.id, target, x, z, idx: msg.idx | 0, lat: Number(msg.lat) || 0, cid: msg.cid });
        } else if (msg.kind === 'bomb') {
          broadcast(room, { type: 'bomb', id, owner: player.id, x, z, idx: msg.idx | 0, lat: Number(msg.lat) || 0, cid: msg.cid });
        }
        break;
      }

      case 'bump': { // 카트 충돌 알림 → 박힌 사람에게만 전달 (양쪽 화면에서 동시에 튕기게)
        if (room.phase !== 'racing' || !player.racing) break;
        const now = Date.now();
        if (now - (player.lastBump || 0) < 100) break; // 연타 방지
        player.lastBump = now;
        const target = room.players.get(msg.target);
        const ix = Number(msg.ix), iz = Number(msg.iz);
        if (!target?.racing || !Number.isFinite(ix) || !Number.isFinite(iz) || Math.hypot(ix, iz) > 40) break;
        send(target.ws, { type: 'bump', from: player.id, ix, iz });
        break;
      }

      case 'missileHit': // 맞은 사람이 보고 → 한 번만 인정
        if (room.missiles.delete(msg.id)) broadcast(room, { type: 'missileGone', id: msg.id, victim: player.id });
        break;

      case 'hitBanana': // 먼저 밟은 사람만 인정
        if (room.bananas.delete(msg.id)) broadcast(room, { type: 'bananaGone', id: msg.id, by: player.id });
        break;

      case 'ping':
        send(ws, { type: 'pong', t: msg.t });
        break;
    }
  };

  ws.on('close', () => {
    if (!player || !room || player.ws !== ws) return;
    player.ws = null;
    const others = [...room.players.values()].some((p) => p.ws);
    // 레이스 중이고 아직 완주 전이면 잠시 자리를 남겨둠 (재접속하면 이어서 달림)
    if (others && player.racing && !player.finished && (room.phase === 'racing' || room.phase === 'countdown')) {
      const p = player, r = room;
      p.resumeTimer = setTimeout(() => { if (!p.ws) removePlayer(r, p); }, RESUME_MS);
      if (room.hostId === p.id) room.hostId = [...room.players.values()].find((v) => v.ws).id; // 방장은 바로 넘김
      broadcast(room, lobbyMsg(room));
      return;
    }
    removePlayer(room, player);
  });
});

// 스냅샷 브로드캐스트: [id, x, z, ry, speed, steer, flags, progress, y]
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    const ps = [];
    for (const p of room.players.values()) if (p.racing && p.s) ps.push([p.id, ...p.s, p.progress, p.y || 0]);
    if (ps.length) broadcast(room, { type: 'snap', t: Date.now(), ps }); // t: 서버 시각 (클라이언트 보간 기준)
  }
}, 1000 / TICK_RATE);

// 하트비트: 응답 없는 연결(와이파이 끊김 등)을 정리 → 유령 플레이어 방지
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('error', (err) => console.warn('[wss error]', err.message));
// 최후 안전망: 놓친 예외가 있어도 서버(모든 방)를 유지하고 기록만 남김
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

server.listen(PORT, () => {
  console.log(`🏁 Racing server: http://localhost:${PORT}`);
});
