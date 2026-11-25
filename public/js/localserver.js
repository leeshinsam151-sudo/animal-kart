// 오프라인 연습 모드: 서버(server.js)와 같은 메시지를 브라우저 안에서 흉내 내고, AI 봇 5명을 운전시킴
// - 멀티플레이 서버 없이도 레이스/아이템을 테스트할 수 있음
import { CarController } from './physics.js';
import { CHARACTER_IDS, CHARACTERS } from './kart.js';
import { COLORS } from './ui.js';
import { BOMB_RANGE, BOMB_FLIGHT, MISSILE_LOCK_RANGE, MISSILE_HIT_HEIGHT, BLOCK_RADIUS } from './items.js';

const LAPS = 2;
const COUNTDOWN_MS = 3000;
const RESULTS_MS = 8000;
const AFTER_FIRST_FINISH_MS = 30000;
const TICK = 50;
const BOT_COUNT = 5; // 나 + 봇 5 = 6명 풀 레이스
const BANANA_RADIUS = 2.1;
const BOMB_FLIGHT_MS = BOMB_FLIGHT * 1000; // 게임과 같은 값 (items.js)
const SPLASH_RADIUS = 7.5;
const MISSILE_HIT_RADIUS = 3;
const FLAG = { drift: 1, boost: 2, spin: 4, trap: 8, blast: 16 };

const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export class LocalServer {
  constructor({ track, items }, emit) {
    this.track = track;
    this.items = items;
    this.emit = emit;
    this.phase = 'lobby';
    this.players = new Map();
    this.timers = [];
    this.nextHazard = 1;
    this.bananas = new Map();
    this.bombs = [];
    this.missiles = new Set();
    this.finishOrder = [];
    this.raceStart = 0;
    this.last = performance.now();
    setInterval(() => this.tick(), TICK);
  }

  get bots() { return [...this.players.values()].filter((p) => p.bot); }
  get me() { return this.players.get(1); }

  lobbyMsg() {
    return {
      type: 'lobby', hostId: 1, phase: this.phase,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, char: p.char, racing: p.racing })),
    };
  }

  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }

  // ---------- 클라이언트 → 서버 ----------
  receive(msg) {
    switch (msg.type) {
      case 'join': {
        const me = { id: 1, name: msg.name || '나', char: CHARACTER_IDS.includes(msg.char) ? msg.char : 'panda', color: COLORS.includes(msg.color) ? msg.color : COLORS[0], racing: false, x: 0, z: 0, progress: 0 };
        this.players.set(1, me);
        const chars = CHARACTER_IDS.filter((c) => c !== me.char).sort(() => Math.random() - 0.5);
        const colors = COLORS.filter((c) => c !== me.color);
        for (let i = 0; i < BOT_COUNT; i++) {
          const char = chars[i];
          this.players.set(i + 2, { id: i + 2, bot: true, name: `${CHARACTERS[char].name}봇`, char, color: colors[i * 2 % colors.length], racing: false });
        }
        this.emit({ type: 'welcome', id: 1, room: 'offline', laps: LAPS, phase: 'lobby', offline: true });
        this.emit(this.lobbyMsg());
        break;
      }
      case 'profile': {
        if (this.phase !== 'lobby') break;
        const me = this.me;
        if (CHARACTER_IDS.includes(msg.char)) me.char = msg.char;
        if (COLORS.includes(msg.color)) {
          // 봇이 쓰는 색이면 봇과 맞바꿈
          const other = this.bots.find((b) => b.color === msg.color);
          if (other) other.color = me.color;
          me.color = msg.color;
        }
        this.emit(this.lobbyMsg());
        break;
      }
      case 'start':
        if (this.phase === 'lobby') this.startRace();
        break;
      case 'state': {
        const me = this.me;
        if (!me?.racing) break;
        me.x = msg.x; me.z = msg.z; me.y = msg.y;
        if (!me.finished) me.progress = msg.p;
        break;
      }
      case 'finish': this.finish(this.me); break;
      case 'item': this.useItem(1, msg); break;
      case 'hitBanana':
        if (this.bananas.delete(msg.id)) this.emit({ type: 'bananaGone', id: msg.id, by: 1 });
        break;
      case 'missileHit':
        if (this.missiles.delete(msg.id)) this.emit({ type: 'missileGone', id: msg.id, victim: 1 });
        break;
    }
  }

  // ---------- 레이스 진행 ----------
  startRace() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.phase = 'countdown';
    this.finishOrder = [];
    this.bananas.clear();
    this.bombs = [];
    this.missiles.clear();
    // 내가 맨 뒤에서 출발 → 앞에 쫓아갈 상대가 있음
    const order = [...this.bots, this.me];
    const grid = order.map((p, slot) => ({ id: p.id, slot }));
    order.forEach((p, slot) => {
      Object.assign(p, { racing: true, finished: false, finishTime: null, progress: -0.01 });
      if (p.bot) {
        const s = this.track.gridSlot(slot);
        p.ctrl = new CarController(this.track);
        p.ctrl.reset(s.x, s.z, s.heading);
        Object.assign(p, {
          lane: (Math.random() - 0.5) * 8, laneTarget: 0, laneTimer: 0,
          cap: 52 + Math.random() * 6,     // 봇마다 최고속도가 조금씩 다름 (내 최고속도 56)
          held: null, useAt: 0, stuckT: 0, wrongT: 0,
        });
      }
    });
    this.emit(this.lobbyMsg());
    this.emit({ type: 'countdown', ms: COUNTDOWN_MS, grid, laps: LAPS });
    this.later(COUNTDOWN_MS, () => {
      this.phase = 'racing';
      this.raceStart = performance.now();
      this.emit({ type: 'go' });
    });
  }

  finish(p) {
    if (this.phase !== 'racing' || !p?.racing || p.finished) return;
    p.finished = true;
    p.finishTime = performance.now() - this.raceStart;
    p.progress = LAPS + 1 - this.finishOrder.length * 0.001;
    this.finishOrder.push(p.id);
    this.emit({ type: 'finished', id: p.id, name: p.name, time: p.finishTime, place: this.finishOrder.length });
    if (this.finishOrder.length === 1) this.later(AFTER_FIRST_FINISH_MS, () => this.endRace());
    const all = [...this.players.values()].filter((v) => v.racing);
    // 내가 들어오면 남은 봇은 최대 10초만 기다림
    if (all.every((v) => v.finished)) this.endRace();
    else if (p.id === 1) this.later(10000, () => this.endRace());
  }

  endRace() {
    if (this.phase !== 'racing') return;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.phase = 'results';
    const racers = [...this.players.values()].filter((p) => p.racing);
    const done = racers.filter((p) => p.finished).sort((a, b) => a.finishTime - b.finishTime);
    const dnf = racers.filter((p) => !p.finished).sort((a, b) => b.progress - a.progress);
    this.emit({
      type: 'results',
      results: [...done, ...dnf].map((p, i) => ({ id: p.id, name: p.name, color: p.color, place: i + 1, time: p.finished ? p.finishTime : null })),
    });
    this.later(RESULTS_MS, () => {
      this.phase = 'lobby';
      for (const p of this.players.values()) p.racing = false;
      this.emit(this.lobbyMsg());
    });
  }

  // ---------- 아이템 ----------
  useItem(owner, msg) {
    if (this.phase !== 'racing') return;
    const id = this.nextHazard++;
    if (msg.kind === 'banana') {
      this.bananas.set(id, { x: msg.x, z: msg.z, owner, t: performance.now() });
      this.emit({ type: 'banana', id, x: msg.x, z: msg.z, owner });
    } else if (msg.kind === 'bomb') {
      const N = this.track.N;
      const li = (msg.idx + Math.round(BOMB_RANGE / this.track.spacing) + N) % N;
      const p = this.track.points[li], s = this.track.sides[li];
      const l = Math.max(-6, Math.min(6, msg.lat * 0.6));
      this.bombs.push({ owner, x: p.x + s.x * l, z: p.z + s.z * l, landAt: performance.now() + BOMB_FLIGHT_MS });
      this.emit({ type: 'bomb', id, owner, x: msg.x, z: msg.z, idx: msg.idx, lat: msg.lat, cid: msg.cid });
    } else if (msg.kind === 'missile') {
      this.missiles.add(id);
      this.emit({ type: 'missile', id, owner, target: msg.target ?? null, x: msg.x, z: msg.z, idx: msg.idx, lat: msg.lat, cid: msg.cid });
    }
  }

  /** 진행도 순으로 정렬했을 때 p 바로 앞 사람 */
  racerAhead(p) {
    const list = [...this.players.values()].filter((v) => v.racing && !v.finished).sort((a, b) => b.progress - a.progress);
    const i = list.indexOf(p);
    return i > 0 ? list[i - 1] : null;
  }

  rollBotItem(bot) {
    const list = [...this.players.values()].filter((v) => v.racing).sort((a, b) => b.progress - a.progress);
    const pos = list.indexOf(bot);
    const r = Math.random();
    if (r < 0.2) return 'charge';
    if (pos === 0) return r < 0.75 ? 'banana' : 'bomb';
    return r < 0.4 ? 'banana' : r < 0.7 ? 'bomb' : 'missile';
  }

  botUseItem(bot, now) {
    const c = bot.ctrl;
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
    const loc = this.track.locate(c.x, c.z, c.hint);
    const ahead = this.racerAhead(bot);
    if (bot.held === 'charge') {
      c.gauge = 1; // 게이지 충전 → 다음 프레임에 부스터 획득
    } else if (bot.held === 'banana') {
      this.useItem(bot.id, { kind: 'banana', x: c.x - fx * 3.6, z: c.z - fz * 3.6 });
    } else if (bot.held === 'bomb') {
      // 앞사람이 착지 지점(약 85m 앞) 근처에 있을 때 던짐 (8초 넘게 들고 있으면 그냥 던짐)
      const gap = ahead ? (ahead.progress - bot.progress) * this.track.length : Infinity;
      if ((gap > 130 || gap < 40) && now - bot.useAt < 8000) return;
      this.useItem(bot.id, { kind: 'bomb', x: c.x + fx * 2, z: c.z + fz * 2, idx: loc.index, lat: loc.lateral });
    } else {
      // 미사일: 앞사람이 조준 거리(220m) 안에 들어올 때까지 기다림 (8초 넘으면 그냥 직진 발사)
      const gap = ahead ? (ahead.progress - bot.progress) * this.track.length : Infinity;
      const inRange = gap <= MISSILE_LOCK_RANGE;
      if (!inRange && now - bot.useAt < 8000) return;
      this.useItem(bot.id, { kind: 'missile', target: inRange ? ahead.id : null, x: c.x + fx * 3, z: c.z + fz * 3, idx: loc.index, lat: loc.lateral });
    }
    bot.held = null;
  }

  // ---------- 봇 운전 ----------
  drive(bot, dt) {
    const c = bot.ctrl, t = this.track, N = t.N;
    if (bot.finished) return { brake: true };
    // 가끔 주행 라인을 바꿈
    bot.laneTimer -= dt;
    if (bot.laneTimer <= 0) { bot.laneTarget = (Math.random() - 0.5) * 12; bot.laneTimer = 2 + Math.random() * 4; }
    bot.lane += (bot.laneTarget - bot.lane) * Math.min(1, dt * 0.8);
    const look = 22 + Math.round(Math.min(20, c.vF * 0.4));
    const i = (c.hint + look) % N;
    const p = t.points[i], s = t.sides[i];
    const tx = p.x + s.x * bot.lane, tz = p.z + s.z * bot.lane;
    const d = wrapAngle(Math.atan2(tx - c.x, tz - c.z) - c.heading);
    const sharp = Math.abs(d) > 0.22;
    // 드리프트는 속도를 유지하므로 급커브에서만 감속
    return {
      throttle: c.vF < bot.cap && !(Math.abs(d) > 0.45 && c.vF > 36),
      brake: Math.abs(d) > 0.5 && c.vF > 42,
      left: d > 0.03,
      right: d < -0.03,
      drift: sharp && c.vF > 26,
      boost: c.items > 0 && Math.abs(d) < 0.05 && Math.random() < 0.03,
      item: false,
    };
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000); // 렉이 있어도 봇이 실시간 속도를 유지하도록 (60Hz 하위 스텝)
    this.last = now;
    if (this.phase === 'lobby') return;
    const bots = this.bots;

    if (this.phase === 'racing') {
      const steps = Math.max(1, Math.round(dt * 60));
      for (const bot of bots) {
        if (!bot.racing) continue;
        for (let k = 0; k < steps; k++) bot.ctrl.update(dt / steps, this.drive(bot, dt / steps));
        const c = bot.ctrl;
        bot.progress = bot.finished ? bot.progress : c.progress;

        // 끼였거나 역주행이면 리스폰
        bot.stuckT = !c.stunned && Math.abs(c.vF) < 2 && !bot.finished ? bot.stuckT + dt : 0;
        bot.wrongT = c.wrongWay ? bot.wrongT + dt : 0;
        if (bot.stuckT > 2.5 || bot.wrongT > 1.5) { c.respawn(); bot.stuckT = bot.wrongT = 0; }

        // 아이템 박스
        const box = this.items.touchBox(c.x, c.z, now);
        if (box >= 0) {
          this.items.breakBox(box, now);
          this.emit({ type: 'box', i: box, by: bot.id });
          if (!bot.held) { bot.held = this.rollBotItem(bot); bot.useAt = now + 1500 + Math.random() * 4000; }
        }
        if (bot.held && now > bot.useAt && !c.stunned && !bot.finished) this.botUseItem(bot, now);

        if (!bot.finished && c.progress >= LAPS) this.finish(bot);
      }

      // 카트끼리 충돌 (봇 ↔ 봇, 봇 ↔ 나)
      const me = this.me;
      for (const a of bots) {
        if (me?.racing) a.ctrl.collideWith(me.x, me.z, 0, 0, me.y ?? a.ctrl.y);
        for (const b of bots) if (a !== b) a.ctrl.collideWith(b.ctrl.x, b.ctrl.z, b.ctrl.vx, b.ctrl.vz, b.ctrl.y);
      }

      this.hazards(bots, now);
    }

    // 스냅샷
    const ps = bots.filter((b) => b.racing && b.ctrl).map((b) => {
      const c = b.ctrl;
      const fl = (c.drifting ? FLAG.drift : 0) | (c.boosting ? FLAG.boost : 0) | (c.spinTime > 0 ? FLAG.spin : 0)
        | (c.trapTime > 0 ? FLAG.trap : 0) | (c.blastTime > 0 ? FLAG.blast : 0);
      return [b.id, c.x, c.z, c.heading, c.vF, c.steer, fl, b.progress, c.y];
    });
    if (ps.length) this.emit({ type: 'snap', ps });
  }

  /** 봇이 아이템에 맞는지 판정 (내 카트는 클라이언트가 직접 판정) */
  hazards(bots, now) {
    // 바나나
    for (const [id, b] of this.bananas) {
      for (const bot of bots) {
        if ((bot.id === b.owner && now - b.t < 1200) || bot.ctrl.air) continue;
        if (Math.hypot(bot.ctrl.x - b.x, bot.ctrl.z - b.z) < BANANA_RADIUS) {
          bot.ctrl.spinOut();
          this.bananas.delete(id);
          this.emit({ type: 'bananaGone', id, by: bot.id });
          break;
        }
      }
    }
    // 물폭탄 착지
    for (const b of this.bombs) {
      if (now < b.landAt) continue;
      for (const bot of bots) if (bot.id !== b.owner && Math.hypot(bot.ctrl.x - b.x, bot.ctrl.z - b.z) < SPLASH_RADIUS) bot.ctrl.trap();
      b.done = true;
    }
    this.bombs = this.bombs.filter((b) => !b.done);
    // 봇을 노리거나 봇이 쏜 직진 미사일이 바나나에 막힘 (내가 목표인 경우는 내 화면이 판정)
    const isBot = (id) => bots.some((b) => b.id === id);
    for (const [mid, bid, m] of this.items.blockedMissiles()) {
      if (!this.missiles.has(mid) || !(isBot(m.target) || (m.target == null && isBot(m.owner)))) continue;
      this.missiles.delete(mid);
      this.bananas.delete(bid);
      this.emit({ type: 'missileGone', id: mid });
      this.emit({ type: 'bananaGone', id: bid });
    }
    // 미사일: 화면에 보이는 봇 위치 기준으로 판정해야 연출과 맞음
    for (const m of this.items.missiles) {
      if (typeof m.id !== 'number' || !this.missiles.has(m.id)) continue;
      for (const bot of bots) {
        if (bot.id === m.owner) continue;
        const pos = this.items.getPos(bot.id);
        if (pos && Math.abs(m.y - ((pos.y ?? bot.ctrl.y) + 1.2)) > MISSILE_HIT_HEIGHT) continue; // 점프 중이면 통과
        if (pos && Math.hypot(m.x - pos.x, m.z - pos.z) < MISSILE_HIT_RADIUS + Math.abs(bot.ctrl.vF) * 0.06) {
          bot.ctrl.blast();
          this.missiles.delete(m.id);
          this.emit({ type: 'missileGone', id: m.id, victim: bot.id });
          break;
        }
      }
    }
  }
}
