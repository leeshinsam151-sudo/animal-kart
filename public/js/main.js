// 게임 진입점: 렌더링, 입력, 네트워크 동기화, 게임 흐름
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Track, ZONES, zoneWeights, blendColor, trackById, DEFAULT_TRACK } from './track.js';
import { Items, SPLASH_RADIUS, MISSILE_HIT_RADIUS, MISSILE_HIT_HEIGHT, MISSILE_LOCK_RANGE } from './items.js';
import { createKart, createNameTag, CHARACTER_IDS } from './kart.js';
import { CarController, TOP_SPEED, SPIN_TIME, BLAST_TIME, BUMP_K, SHIELD_TIME, MAGNET_TIME } from './physics.js';
import { KartFx, Snow } from './effects.js';
import { Net } from './net.js';
import { AudioSys } from './audio.js';
import { UI, COLORS } from './ui.js';
import { NetClock, sampleAt, smoothPosition, lerpAngle, predict, leadTime } from './interp.js';
import { updateHazards, applyHazards } from './hazards.js';

const SEND_INTERVAL = 50;   // 내 상태 전송 주기 (ms)
// 원격 카트 보간: 서버 시각 기준 정렬 + 흔들림에 맞춘 지연 자동 조절 + 짧은 예측 (interp.js)
const netClock = new NetClock();
const SHOW_INDEX = 30;      // 차고(로비) 화면에서 카트를 세워둘 트랙 위치
const FLAG_DRIFT = 1, FLAG_BOOST = 2, FLAG_SPIN = 4, FLAG_TRAP = 8, FLAG_BLAST = 16, FLAG_SHIELD = 32, FLAG_MAGNET = 64, FLAG_FALL = 128;

/** 움직이는 함정용 공유 시계(초): 멀티는 서버 시각 추정, 연습 모드는 같은 페이지 안이라 내 시계 */
function hazardClock() {
  if (net.offline || netClock.offset == null) return Date.now() / 1000;
  return (performance.now() - netClock.offset + (net.rtt || 0) / 2) / 1000;
}
const MAGNET_RANGE = 200; // m - 자석은 이 거리 안의 바로 앞 카트에게 끌려감
const ITEM_ROLL_TIME = 0.8; // 아이템 룰렛 시간 (s)
const MAX_HELD_ITEMS = 2;   // 아이템 최대 보관 개수

// ---------------- 렌더러 / 씬 ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = 0xa8d8f0;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 250, 1100);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 3000);

const hemi = new THREE.HemisphereLight(0xe0f2ff, 0x4a6b3a, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(80, 150, 60);

let track = new Track(scene, renderer, trackById(DEFAULT_TRACK)); // 로비에서 방장이 고른 트랙으로 바뀜 (loadTrack)
const ui = new UI(track);
const net = new Net();
const sound = new AudioSys(); // 엔진음·효과음·배경음악
sound.playMusic('menu');
const fx = new KartFx(scene);
const items = new Items(scene, track, fx);
net.offlineContext = { track, items };
items.onExplosion = (x, z) => { const v = nearVol(x, z); if (v > 0.05) sound.explosion(v); };
items.onSplash = (x, z) => { const v = nearVol(x, z); if (v > 0.05) sound.splash(v); };
items.onStrike = (x, z) => { const v = nearVol(x, z, 200); if (v > 0.05) sound.thunder(v); };
// 미사일 추적용: 플레이어 id → 현재 위치와 트랙 인덱스
items.getPos = (id) => {
  if (id === game.myId && game.local) { const c = game.local.ctrl; return { x: c.x, z: c.z, y: c.y, hint: c.hint }; }
  const r = game.remotes.get(id);
  return r && r.hint >= 0 ? { x: r.x, z: r.z, y: r.y, hint: r.hint } : null;
};
const snow = new Snow(scene);

/** 다른 트랙으로 교체 (같은 트랙이면 아무것도 안 함). 바꿨으면 true */
function loadTrack(id) {
  if (!id || track.id === id) return false;
  clearRace();
  clearShowroom();
  track.dispose();
  track = new Track(scene, renderer, trackById(id));
  ui.setTrack(track);
  items.setTrack(track);
  net.offlineContext.track = track; // 연습 모드 봇도 새 트랙에서 달림
  if (window.__dbg) window.__dbg.track = track;
  game.zoneIdx = -1;
  return true;
}

// ---------------- 게임 상태 ----------------
const game = {
  myId: null,
  room: '',
  laps: 3,
  phase: 'menu',          // menu | lobby | countdown | racing | results | spectate
  hostId: null,
  players: new Map(),     // id → { name, color, char }
  local: null,            // { ctrl, kart }
  remotes: new Map(),     // id → { kart, buf, p, x, z, ry, vx, vz, spin, st, fl, driftT }
  inputEnabled: false,
  raceStart: 0,
  finished: false,
  finishTime: null,
  finishOrder: [],
  lastSend: 0,
  time: 0,
  // 아이템
  heldItems: [],          // 가진 아이템 (최대 2개, 앞에서부터 사용) 'banana' | 'bomb' | 'missile'
  itemRoll: 0,            // 지금 도는 룰렛 남은 시간
  rollQueue: [],          // 룰렛이 끝나면 받을 아이템들
  prevItemKey: false,
  bombSeq: 0,
  zoneIdx: -1,
};

// 내 캐릭터/카트 색 (브라우저에 기억)
const profile = { char: 'panda', color: COLORS[0] };
try {
  const saved = JSON.parse(localStorage.getItem('racer-profile') || '{}');
  if (CHARACTER_IDS.includes(saved.char)) profile.char = saved.char;
  if (COLORS.includes(saved.color)) profile.color = saved.color;
} catch {}

// 조향 감도 (60~140%, 브라우저에 기억)
const steerInput = document.getElementById('steerSens');
let steerScale = 1;
try { const v = Number(localStorage.getItem('racer-steer')); if (v >= 0.6 && v <= 1.4) steerScale = v; } catch {}
function showSteer() {
  steerInput.value = Math.round(steerScale * 100);
  document.getElementById('steerVal').textContent = `${Math.round(steerScale * 100)}%`;
}
showSteer();
steerInput.addEventListener('input', () => {
  steerScale = Number(steerInput.value) / 100;
  showSteer();
  try { localStorage.setItem('racer-steer', String(steerScale)); } catch {}
  if (game.local) game.local.ctrl.steerScale = steerScale;
});

// 배경음악 / 효과음 볼륨 (브라우저에 기억)
const vols = { music: 50, sfx: 80 };
try { Object.assign(vols, JSON.parse(localStorage.getItem('racer-vol') || '{}')); } catch {}
function applyVols() {
  sound.setVolumes(vols.music / 100, vols.sfx / 100);
  for (const k of ['music', 'sfx']) {
    document.getElementById(`${k}Vol`).value = vols[k];
    document.getElementById(`${k}Val`).textContent = `${vols[k]}%`;
  }
}
applyVols();
for (const k of ['music', 'sfx']) {
  document.getElementById(`${k}Vol`).addEventListener('input', (e) => {
    vols[k] = Number(e.target.value);
    applyVols();
    try { localStorage.setItem('racer-vol', JSON.stringify(vols)); } catch {}
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('button')) { sound.start(); sound.click(); } });

// ---------------- 입력 ----------------
const keys = new Set();
const BIND = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight'],
  boost: ['Space', 'KeyE'],
  item: ['KeyZ'],
};
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyR' && game.local && game.inputEnabled && !game.finished) game.local.ctrl.respawn();
  if (e.code === 'KeyM') ui.toast(sound.toggle() ? '🔇 소리 끔' : '🔊 소리 켬', 1000);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// 모바일 터치 버튼
document.querySelectorAll('#touch [data-key]').forEach((btn) => {
  const code = btn.dataset.key;
  const on = (e) => { e.preventDefault(); keys.add(code); sound.start(); };
  const off = (e) => { e.preventDefault(); keys.delete(code); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('pointerleave', off);
});
if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

function readInput() {
  const inp = {};
  for (const k in BIND) inp[k] = BIND[k].some((c) => keys.has(c));
  return inp;
}
const NO_INPUT = { throttle: false, brake: false, left: false, right: false, drift: false, boost: false, item: false };
const COAST_INPUT = { ...NO_INPUT, brake: true };

// ---------------- 카트 관리 ----------------
function disposeKart(kart) {
  scene.remove(kart.root);
  kart.root.traverse((o) => {
    if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); }
    if (o.geometry?.userData.owned) o.geometry.dispose(); // 카트마다 합쳐 만든 형상 해제 (메모리 누수 방지)
  });
}

function spawnKart(id) {
  const info = game.players.get(id) || { name: '???', color: '#888888', char: 'panda' };
  const kart = createKart({ color: info.color, character: info.char });
  if (id !== game.myId) kart.root.add(createNameTag(info.name, info.color));
  scene.add(kart.root);
  return kart;
}

function getRemote(id) {
  let r = game.remotes.get(id);
  if (!r) {
    r = { kart: spawnKart(id), buf: [], p: 0, x: 0, z: 0, ry: 0, vx: 0, vz: 0, spin: 0, st: 0, fl: 0, driftT: 0, spinAngle: 0, wasTrapped: false, blastT: 0, hint: -1 };
    game.remotes.set(id, r);
  }
  return r;
}

function clearRace() {
  if (game.local) disposeKart(game.local.kart);
  game.local = null;
  for (const r of game.remotes.values()) disposeKart(r.kart);
  game.remotes.clear();
  Object.assign(game, { inputEnabled: false, finished: false, finishTime: null, finishOrder: [], heldItems: [], itemRoll: 0, rollQueue: [], zoneIdx: -1, magnetTarget: null });
  items.clear();
  document.body.classList.remove('boosting');
  ui.missileWarning(false);
  ui.hideCountdown();
}

function setupRace(grid) {
  clearRace();
  clearShowroom();
  const mine = grid.find((g) => g.id === game.myId);
  if (mine) {
    const ctrl = new CarController(track);
    ctrl.steerScale = steerScale;
    ctrl.onItem = () => sound.chime(); // 드리프트로 부스터 획득
    ctrl.onShieldBreak = () => { // 방어막이 공격을 막음
      sound.shieldBreak();
      ui.toast('🛡️ 방어막이 막아냈다!', 1200);
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI;
        fx.glow.emit(ctrl.x + Math.cos(a) * 2.8, ctrl.y + 2 + Math.cos(e) * 2.5, ctrl.z + Math.sin(a) * 2.8, Math.cos(a) * 6, 2 + Math.random() * 4, Math.sin(a) * 6, 0.45, 0.6, 0.1, 1, 0.85, 0.35, 1, 2);
      }
    };
    game.lapShown = 1;
    const slot = track.gridSlot(mine.slot);
    ctrl.reset(slot.x, slot.z, slot.heading);
    game.local = { ctrl, kart: spawnKart(game.myId) };
    // 카메라를 내 카트 뒤로 즉시 이동
    camYaw = slot.heading;
    camera.position.set(slot.x - Math.sin(slot.heading) * 9, 4.9, slot.z - Math.cos(slot.heading) * 9);
  }
  // 다른 카트도 스냅샷 오기 전에 그리드에 미리 배치
  for (const g of grid) {
    if (g.id === game.myId) continue;
    const s = track.gridSlot(g.slot);
    Object.assign(getRemote(g.id), { x: s.x, z: s.z, ry: s.heading, p: -0.01 });
  }
}

// ---------------- 차고 (메뉴/로비에서 카트 전시) ----------------
const showroom = { karts: [], key: '', prev: new Map(), wave: new Map() };

function clearShowroom() {
  showroom.karts.forEach((s) => disposeKart(s.kart));
  showroom.karts = [];
  showroom.key = '';
}

/** list: [{ id, name, char, color }] → 출발선 앞 직선 구간에 나란히 세움 */
function syncShowroom(list) {
  const key = JSON.stringify(list.map((p) => [p.id, p.char, p.color, p.name]));
  if (key === showroom.key) return;
  // 새로 들어왔거나 캐릭터/색을 바꾼 플레이어는 손 흔들기
  for (const p of list) {
    const prev = showroom.prev.get(p.id);
    if (!prev || prev.char !== p.char || prev.color !== p.color) showroom.wave.set(p.id, game.time + 1.8);
  }
  showroom.prev = new Map(list.map((p) => [p.id, { char: p.char, color: p.color }]));
  clearShowroom();
  showroom.key = key;
  const base = track.points[SHOW_INDEX], t = track.tangents[SHOW_INDEX], s = track.sides[SHOW_INDEX];
  const heading = Math.atan2(t.x, t.z);
  list.forEach((p, i) => {
    const kart = createKart({ color: p.color, character: p.char });
    const lat = (i - (list.length - 1) / 2) * 5;
    kart.root.position.set(base.x + s.x * lat, 0, base.z + s.z * lat);
    kart.root.rotation.y = heading;
    if (list.length > 1) kart.root.add(createNameTag(p.name, p.color));
    scene.add(kart.root);
    showroom.karts.push({ id: p.id, kart, seed: i * 1.7 });
  });
}

function menuShowroom() {
  syncShowroom([{ id: 'me', name: '', char: profile.char, color: profile.color }]);
}

function lobbyShowroom() {
  syncShowroom([...game.players.values()].map((p) => ({ id: p.id, name: p.name, char: p.char, color: p.color })));
}

function updateShowroom(dt) {
  const t = game.time;
  for (const { id, kart, seed } of showroom.karts) {
    const cheer = (showroom.wave.get(id) || 0) > t;
    kart.animate({ t, dt, cheer, look: Math.sin(t * 0.7 + seed) * 0.35, speed: 0.15 });
    kart.body.position.y = Math.abs(Math.sin(t * 9 + seed)) * 0.012; // 공회전 들썩임
  }
}

function refreshGarage() {
  const taken = new Set([...game.players.values()].filter((p) => p.id !== game.myId).map((p) => p.color));
  ui.renderGarage(profile, game.phase === 'lobby' ? taken : new Set());
}

function setProfile(change) {
  Object.assign(profile, change);
  try { localStorage.setItem('racer-profile', JSON.stringify(profile)); } catch {}
  if (game.phase === 'lobby') net.send({ type: 'profile', ...profile });
  else menuShowroom();
  refreshGarage();
}

document.getElementById('garage').addEventListener('click', (e) => {
  const c = e.target.closest('[data-char]');
  const col = e.target.closest('[data-color]');
  if (c) setProfile({ char: c.dataset.char });
  if (col && !col.disabled) setProfile({ color: col.dataset.color });
});

// ---------------- 네트워크 이벤트 ----------------
function enterLobbyView() {
  sound.playMusic('menu');
  ui.show('menu', false);
  ui.show('lobby', true);
  ui.show('garage', game.phase === 'lobby');
  ui.show('hud', false);
  ui.show('results', false);
  ui.show('touch', false);
}

net
  .on('welcome', (m) => {
    if (m.resume) {
      // 레이스 중 재접속 성공: 지금 상태 그대로 이어서 달림
      ui.toast('✅ 재접속 완료! 이어서 달립니다', 2000);
      return;
    }
    if (game.local || game.remotes.size) clearRace(); // 자리 복귀 실패 → 새로 입장
    loadTrack(m.track);
    Object.assign(game, { myId: m.id, room: m.room, laps: m.laps, phase: m.phase === 'lobby' ? 'lobby' : 'spectate' });
    if (!m.offline) history.replaceState(null, '', `?room=${encodeURIComponent(m.room)}` + (location.search.includes('debug') ? '&debug' : ''));
    document.body.classList.toggle('offline', !!m.offline);
    if (m.offline) ui.toast('🤖 AI 봇 5명과 연습 모드', 2500);
    clearShowroom();
    showroom.prev.clear();
    enterLobbyView();
  })
  .on('lobby', (m) => {
    game.hostId = m.hostId;
    game.players = new Map(m.players.map((p) => [p.id, p]));
    // 재접속 중에 '나감' 메시지를 놓쳤어도 목록에 없는 카트는 정리 (유령 카트 방지)
    for (const [id, r] of game.remotes) {
      if (!game.players.has(id)) { disposeKart(r.kart); game.remotes.delete(id); }
    }
    const me = game.players.get(game.myId);
    if (me) {
      // 서버가 배정한 값(색 중복 시 변경됨)을 내 프로필에 반영
      profile.char = me.char;
      profile.color = me.color;
    }
    game.laps = m.laps ?? game.laps;
    // 방장이 트랙을 바꿨으면 로비에서 바로 새 트랙으로 (레이스 중엔 바꾸지 않음)
    if (m.phase === 'lobby') loadTrack(m.track);
    ui.updateLobby(m, game.myId, game.room);
    if (m.phase === 'lobby' && game.phase !== 'lobby') {
      game.phase = 'lobby';
      clearRace();
      enterLobbyView();
    }
    if (game.phase === 'lobby') lobbyShowroom();
    refreshGarage();
  })
  .on('countdown', (m) => {
    game.laps = m.laps;
    loadTrack(m.track);
    setupRace(m.grid);
    // 트랙 이름 배너
    const def = track.def, zn = ZONES[track.zone[0]];
    ui.zoneBanner({ emoji: def.emoji, name: def.name, suffix: '', label: def.label, map: def.theme ? zn.map : '#ffffff' });
    game.phase = game.local ? 'countdown' : 'spectate';
    ui.show('garage', false);
    if (game.local) {
      ui.show('lobby', false);
      ui.show('hud', true);
      ui.show('touch', true);
    }
    ui.countdown(m.ms);
    sound.playMusic(null);
    for (let i = 0; i < Math.round(m.ms / 1000); i++) setTimeout(() => sound.count(), i * 1000);
  })
  .on('go', () => {
    if (!game.local) return;
    game.phase = 'racing';
    game.inputEnabled = true;
    game.raceStart = performance.now();
    ui.go();
    sound.go();
    sound.playMusic(ZONES[track.zone[Math.max(0, game.local.ctrl.hint)]].id);
  })
  .on('snap', (m) => {
    const now = performance.now();
    // 서버 시각 → 내 시계로 변환. 가장 빨리 도착한 패킷 기준(offset)으로 맞추고, 늦게 온 정도로 흔들림 추정
    const t = netClock.arrival(m.t, now);
    for (const [id, x, z, ry, sp, st, fl, p, y] of m.ps) {
      if (id === game.myId) continue;
      const r = getRemote(id);
      if (r.buf.length && t <= r.buf[r.buf.length - 1].t) continue; // 순서가 뒤바뀐/중복 패킷 무시
      r.buf.push({ t, x, z, ry, sp, st, fl, y: y ?? null });
      if (r.buf.length > 40) r.buf.shift();
      r.p = p;
    }
  })
  .on('finished', (m) => {
    game.finishOrder.push(m.id);
    if (m.id !== game.myId) ui.toast(`🏁 ${m.name} 완주! (${m.place}위)`);
    else { ui.toast(`🏁 완주! ${m.place}위`, 4000); sound.finish(m.place); }
  })
  .on('results', (m) => {
    game.phase = 'results';
    game.inputEnabled = false;
    ui.show('hud', false);
    ui.show('touch', false);
    document.body.classList.remove('boosting');
    ui.showResults(m.results, game.myId, game.players);
    sound.playMusic('menu');
  })
  .on('sync', (m) => {
    // 관전 입장·재접속 때 놓친 상태 맞추기
    const now = performance.now();
    const ids = new Set(m.bananas.map((b) => b.id));
    for (const id of [...items.bananas.keys()]) if (!ids.has(id)) items.removeBanana(id);
    for (const b of m.bananas) items.addBanana(b.id, b.x, b.z, b.owner, now - 5000);
    if (m.cloud) items.setCloud(m.cloud.holder, m.cloud.ms, now); else items.clearCloud();
    game.finishOrder = [...m.finishOrder];
  })
  .on('reconnecting', ({ attempt, max }) => ui.toast(`📡 연결이 끊겨 재접속 중… (${attempt}/${max})`, 3000))
  .on('bump', (m) => {
    // 다른 사람이 나를 박았음 → 내 화면에서도 바로 튕김 (내가 먼저 감지했으면 무시)
    const c = game.local?.ctrl;
    if (!c || !game.inputEnabled) return;
    const now = performance.now();
    const r = game.remotes.get(m.from);
    if (r && now - (r.hitAt || 0) < BUMP_DEDUPE_MS) return;
    const mag = Math.hypot(m.ix, m.iz);
    if (!(mag > 0) || mag > 40) return;
    passCloud(m.from, now);
    c.bump(m.ix, m.iz);
    if (r) r.bumpAt = now;
    crashFx(c.x - (m.ix / mag) * 1.4, c.y, c.z - (m.iz / mag) * 1.4, mag);
  })
  .on('box', (m) => {
    if (m.by !== game.myId) items.breakBox(m.i, performance.now());
  })
  .on('banana', (m) => items.addBanana(m.id, m.x, m.z, m.owner, performance.now()))
  .on('bananaGone', (m) => items.removeBanana(m.id))
  .on('missile', (m) => {
    if (m.owner === game.myId) items.assignServerId(m.cid, m.id); // 내 미사일은 이미 날아가는 중
    else items.fireMissile(m, performance.now());
    if (m.target === game.myId) ui.toast('🚀 미사일이 날아옵니다!', 1500);
  })
  .on('missileGone', (m) => items.explodeMissile(m.id))
  .on('cloud', (m) => {
    items.setCloud(m.holder, m.ms, performance.now());
    if (m.holder === game.myId) { sound.cloud(); ui.toast(m.passed ? '⛈️ 번개 구름이 넘어왔다! 다른 카트에 부딪혀 넘기세요' : '⛈️ 번개 구름이 따라와요! 다른 카트에 부딪혀 넘기세요', 1800); }
    else if (m.from === game.myId) ui.toast('⛈️ 번개 구름을 넘겼다!', 1200);
  })
  .on('cloudStrike', (m) => {
    items.strike(m.holder);
    const c = game.local?.ctrl;
    if (m.holder === game.myId && c && !game.finished && c.spinOut()) { sound.slip(); ui.toast('⚡ 번개에 맞았다!', 1200); }
  })
  .on('cloudGone', () => items.clearCloud())
  .on('bomb', (m) => {
    // 내가 던진 건 이미 로컬에서 날아가는 중
    if (m.owner !== game.myId) items.throwBomb(m, performance.now());
  })
  .on('left', (m) => {
    const r = game.remotes.get(m.id);
    if (r) { disposeKart(r.kart); game.remotes.delete(m.id); }
  })
  .on('error', (m) => ui.menuMessage(m.message))
  .on('close', () => {
    clearRace();
    game.phase = 'menu';
    game.myId = null;
    game.players.clear();
    ['lobby', 'hud', 'results', 'touch'].forEach((id) => ui.show(id, false));
    ui.show('menu', true);
    ui.show('garage', true);
    ui.menuMessage('서버와 연결이 끊어졌습니다. 다시 입장해 주세요.');
    menuShowroom();
    refreshGarage();
  });

// ---------------- 메뉴 ----------------
const nameInput = document.getElementById('name');
const roomInput = document.getElementById('room');
roomInput.value = new URLSearchParams(location.search).get('room') || '';
try { nameInput.value = localStorage.getItem('racer-name') || ''; } catch {}

function join(offline) {
  const name = nameInput.value.trim() || `Racer${Math.floor(Math.random() * 1000)}`;
  try { localStorage.setItem('racer-name', name); } catch {}
  sound.start(); // 브라우저 정책상 사용자 동작 시점에 오디오 시작
  ui.menuMessage('접속 중…');
  net.connect({ name, room: roomInput.value.trim(), char: profile.char, color: profile.color }, offline);
}
document.getElementById('menu').addEventListener('submit', (e) => { e.preventDefault(); join(false); });
document.getElementById('practiceBtn').addEventListener('click', () => join(true));
document.getElementById('startBtn').addEventListener('click', () => net.send({ type: 'start' }));
document.getElementById('trackPick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-track]');
  if (b && !b.disabled) net.send({ type: 'track', id: b.dataset.track }); // 클릭 소리는 공통 버튼 처리에서
});
document.getElementById('copyLink').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(game.room)}`;
  try { await navigator.clipboard.writeText(url); ui.toast('초대 링크를 복사했어요'); }
  catch { prompt('이 링크를 친구에게 보내세요', url); }
});

// ---------------- 원격 카트 보간 ----------------
function updateRemotes(now, dt) {
  const rt = netClock.renderTime(now);
  // 보간 상태는 실제보다 과거 → 그만큼 곡선 경로로 앞당겨서 "지금 있을 위치"에 그림 (충돌 판정도 같은 위치로)
  const lead = leadTime(netClock, net.offline ? 0 : net.rtt);
  for (const [id, r] of game.remotes) {
    let sp = 0;
    const st = sampleAt(r.buf, rt, netClock.extrapolate);
    if (st) {
      const stunned = st.fl & (FLAG_SPIN | FLAG_TRAP | FLAG_BLAST);
      const pr = lead > 0 && !stunned ? { ...st, ...predict(st, lead) } : st;
      const pos = netClock.useServerTime ? smoothPosition(r, pr, dt) : pr; // 튐을 짧게 나눠서 보정
      // 높이: 땅에 붙어 있던 카트는 예측한 위치의 지면 높이로
      const sl = track.locate(st.x, st.z, r.hint);
      const grounded = !(st.fl & FLAG_FALL) && (st.y == null || st.y < track.groundAt(sl.f, sl.lateral) + 0.4);
      // 높이도 같은 시간만큼 포물선으로 앞당김 (긴 점프·낭떠러지에서 위치는 앞인데 높이만 늦게 따라오는 것 방지)
      const yb = st.y != null && lead > 0 && !stunned ? st.y + st.vy * lead - 16 * lead * lead : null;
      Object.assign(r, { x: pos.x, z: pos.z, ny: grounded ? null : yb ?? st.y, yb, ry: pr.ry, st: st.st, fl: st.fl });
      sp = st.sp;
      r.vx = Math.sin(pr.ry) * sp;  // 충돌 계산용 속도
      r.vz = Math.cos(pr.ry) * sp;
    }
    r.spin += (sp * dt) / 0.5;
    const drifting = !!(r.fl & FLAG_DRIFT);
    r.driftT = drifting ? r.driftT + dt : 0;
    const rl = track.locate(r.x, r.z, r.hint);
    r.hint = rl.index; // 미사일 추적용 트랙 위치
    const rGround = track.groundAt(rl.f, rl.lateral);
    // 지난 상태는 땅 위였어도, 앞당긴 위치의 지면이 포물선보다 훨씬 낮으면(점프대 끝·낭떠러지) 이미 날아오른 것
    const launched = r.ny == null && r.yb != null && r.yb > rGround + 0.8;
    r.y = r.fl & FLAG_FALL ? r.ny ?? rGround // 크레바스로 떨어지는 중엔 땅 밑으로
      : Math.max(launched ? r.yb : r.ny ?? rGround, rGround); // 서버가 높이를 안 주면 트랙 높이로 (땅 밑으로는 안 들어감)
    const rAir = r.y > rGround + 0.4;
    const rDir = Math.sin(r.ry) * track.tangents[rl.index].x + Math.cos(r.ry) * track.tangents[rl.index].z;
    r.pitch = (r.pitch || 0) + ((rAir ? 0 : -Math.atan(track.slopeAt(rl.f) * rDir)) - (r.pitch || 0)) * Math.min(1, dt * 8);
    const rRoll = rAir ? 0 : -track.bankAt(rl.f) * Math.sign(rDir || 1);
    r.roll = (r.roll || 0) + (rRoll - (r.roll || 0)) * Math.min(1, dt * 8);
    r.kart.root.position.set(r.x, r.y, r.z);
    r.kart.root.rotation.set(r.pitch, r.ry, r.roll);
    r.blastT = r.fl & FLAG_BLAST ? r.blastT + dt : 0;
    const trapped = !!(r.fl & FLAG_TRAP);
    r.spinAngle = r.fl & FLAG_SPIN ? r.spinAngle + dt * 11 : 0;
    if (r.wasTrapped && !trapped) bubblePop(r.x, r.z);
    r.wasTrapped = trapped;
    r.kart.animate({
      spin: r.spin, steer: r.st, t: game.time, dt,
      speed: Math.min(Math.abs(sp) / TOP_SPEED, 1),
      roll: THREE.MathUtils.clamp(-r.st * sp * 0.005, -0.08, 0.08),
      cheer: game.finishOrder.includes(id),
      spinAngle: r.spinAngle, trapped,
      blast: r.blastT > 0 ? Math.min(1, r.blastT / BLAST_TIME) : 0,
      shielded: !!(r.fl & FLAG_SHIELD),
    });
    fx.emitFor(r.kart, { drifting, boosting: !!(r.fl & FLAG_BOOST), charge: r.driftT, speed: sp }, dt);
    if (r.fl & FLAG_MAGNET) magnetFx(r.x, r.y || 0, r.z, r.ry, dt);
  }
}

// ---------------- 순위 ----------------
function standings() {
  const list = [];
  if (game.local) {
    const me = game.players.get(game.myId) || {};
    const c = game.local.ctrl;
    list.push({ id: game.myId, name: me.name, color: me.color, char: me.char, p: c.progress, x: c.x, z: c.z, me: true });
  }
  for (const [id, r] of game.remotes) {
    const info = game.players.get(id) || {};
    list.push({ id, name: info.name, color: info.color, char: info.char, p: r.p, x: r.x, z: r.z });
  }
  for (const s of list) { s.fi = game.finishOrder.indexOf(s.id); s.finished = s.fi >= 0; }
  list.sort((a, b) => {
    if (a.finished || b.finished) return (a.finished ? a.fi : 1e9) - (b.finished ? b.fi : 1e9);
    return b.p - a.p;
  });
  return list;
}

// ---------------- 카메라 ----------------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
let camYaw = 0;

function setFov(fov, k) {
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * k; camera.updateProjectionMatrix(); }
}

/** 추격 카메라 */
let camY = 0;
function chase(x, z, yaw, speed, dt, shake = 0, boost = false, y = 0) {
  // 높이는 천천히 따라가서 점프·언덕에서 화면이 덜 출렁이게
  camY += (y - camY) * Math.min(1, dt * 5);
  camYaw = lerpAngle(camYaw, yaw, 1 - Math.exp(-dt * 5));
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  // 높은 위치에서 내려다봐서 캐릭터 머리가 시야를 가리지 않게
  const back = 9 + Math.min(Math.abs(speed), TOP_SPEED) * 0.035;
  camPos.set(x - fx * back, camY + 4.9, z - fz * back);
  camera.position.lerp(camPos, 1 - Math.exp(-dt * 12));
  camTarget.set(x + fx * 9, camY + 1.4, z + fz * 9);
  camera.lookAt(camTarget);
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.4;
    camera.position.y += (Math.random() - 0.5) * shake * 0.4;
  }
  setFov(65 + Math.min(Math.abs(speed) / TOP_SPEED, 1) * 12 + (boost ? 10 : 0), 1 - Math.exp(-dt * 4));
}

function updateCamera(dt) {
  if (game.local) {
    const c = game.local.ctrl;
    // 드리프트 중엔 카트 방향과 실제 진행 방향 사이를 바라봄
    const moveYaw = Math.atan2(c.vx, c.vz);
    const yaw = c.vF > 5 ? lerpAngle(c.heading, moveYaw, 0.6) : c.heading;
    chase(c.x, c.z, yaw, c.vF, dt, c.impact, c.boosting, c.y);
    return;
  }
  // 관전: 선두 카트 추적
  if (game.remotes.size && game.phase !== 'lobby' && game.phase !== 'menu') {
    const lead = standings()[0];
    const r = lead && game.remotes.get(lead.id);
    if (r) { chase(r.x, r.z, r.ry, 30, dt, 0, false, r.y || 0); return; }
  }
  // 차고: 세워둔 카트들을 앞에서 바라봄
  const n = Math.max(1, showroom.karts.length);
  const base = track.points[SHOW_INDEX], t = track.tangents[SHOW_INDEX], s = track.sides[SHOW_INDEX];
  const sway = Math.sin(game.time * 0.3) * 0.3;
  const dirX = t.x * Math.cos(sway) + s.x * Math.sin(sway);
  const dirZ = t.z * Math.cos(sway) + s.z * Math.sin(sway);
  const dist = 7.5 + n * 2.2;
  // 메뉴(1대)일 땐 왼쪽 패널을 피해 카트를 화면 오른쪽에 둠
  const shift = n === 1 && innerWidth > 900 ? 2.6 : 0;
  camera.position.set(base.x + dirX * dist, 2.6 + n * 0.45, base.z + dirZ * dist);
  camera.lookAt(base.x + s.x * shift, 1.2, base.z + s.z * shift);
  setFov(50, 1);
}

// ---------------- 메인 루프 ----------------
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  game.time += dt;

  updateRemotes(now, dt);
  updateShowroom(dt);

  const L = game.local;
  if (L) {
    const c = L.ctrl;
    const inp = game.finished ? COAST_INPUT : game.inputEnabled ? readInput() : NO_INPUT;
    const impactBefore = c.impact;
    // 자석: 고른 카트의 지금 위치를 따라감 (그 카트가 없어지면 가속만)
    const mt = c.magnetTime > 0 && game.magnetTarget != null ? game.remotes.get(game.magnetTarget) : null;
    c.magnetTarget = mt ? { x: mt.x, z: mt.z } : null;
    c.update(dt, inp);
    if (c.impact - impactBefore > 0.15) sound.thud(Math.min(1, (c.impact - impactBefore) * 1.5)); // 벽 충돌·착지 소리
    collideKarts(c, now);
    // 트랙 함정 (나무통·모래 늪·크레바스·버스·블록 벽)
    if (game.inputEnabled || game.finished) {
      const ev = applyHazards(c, track, dt);
      if (ev === 'hit') { sound.thud(0.8); crashFx(c.x, c.y, c.z, 12); }
      else if (ev === 'sand') { ui.toast('🏜️ 모래 늪! 부스터로 빠져나오세요', 1300); sound.splash(0.5); }
      else if (ev === 'fall') { ui.toast('🧊 크레바스에 빠졌다!', 1500); sound.slip(); }
    }

    // 카트 메시 반영 (가감속/코너링에 따라 차체 기울기)
    const k = L.kart;
    // 경사를 따라 앞뒤로 기울고, 공중에선 진행 방향(포물선)을 따라 기울기
    const targetPitch = c.air ? -Math.atan2(c.vy, Math.max(Math.abs(c.vF), 8)) * 0.6 : -Math.atan(c.slope);
    k.pitch = (k.pitch || 0) + (targetPitch - (k.pitch || 0)) * Math.min(1, dt * (c.air ? 4 : 10));
    k.bankRoll = (k.bankRoll || 0) + ((c.air ? 0 : c.roll) - (k.bankRoll || 0)) * Math.min(1, dt * 8);
    k.root.position.set(c.x, c.y - c.sink, c.z); // 모래 늪에선 가라앉음
    k.root.rotation.set(k.pitch, c.heading, k.bankRoll);
    const roll = THREE.MathUtils.clamp(-c.steer * c.vF * 0.005 + c.slip * 0.008, -0.09, 0.09);
    const pitch = THREE.MathUtils.clamp(-c.accel * 0.0012, -0.05, 0.05);
    const br = k.body.rotation;
    const wasTrapped = k.wasTrapped;
    k.wasTrapped = c.trapTime > 0;
    if (wasTrapped && !k.wasTrapped) bubblePop(c.x, c.z);
    k.animate({
      spin: c.spin, steer: c.steer, dt, t: game.time,
      roll: br.z + (roll - br.z) * Math.min(1, dt * 8),
      pitch: br.x + (pitch - br.x) * Math.min(1, dt * 6),
      speed: Math.min(Math.abs(c.vF) / TOP_SPEED, 1),
      cheer: game.finished,
      spinAngle: c.spinTime > 0 ? (1 - c.spinTime / SPIN_TIME) * Math.PI * 4 : 0,
      trapped: c.trapTime > 0,
      blast: c.blastTime > 0 ? 1 - c.blastTime / BLAST_TIME : 0,
      shielded: c.shieldTime > 0,
    });
    if (c.magnetTime > 0) magnetFx(c.x, c.y, c.z, c.heading, dt);

    // 미사일 경고 (나를 노리는 미사일이 있으면 경고 + 삐삐)
    const warned = items.targeting(game.myId) && !game.finished;
    ui.missileWarning(warned);
    const cloud = items.cloud;
    ui.cloudWarning(cloud && cloud.holder === game.myId && !game.finished ? Math.max(0, (cloud.endAt - now) / 1000) : null);
    if (warned && game.time - (game.lastBeep || 0) > 0.35) { sound.beep(); game.lastBeep = game.time; }

    if (game.inputEnabled && !game.finished) updateLocalItems(c, inp, now, dt);

    // 새 구역 진입 배너
    const zi = track.zone[Math.max(0, c.hint)];
    if (zi !== game.zoneIdx) {
      if (game.zoneIdx !== -1) { ui.zoneBanner(ZONES[zi]); sound.zone(); if (game.inputEnabled) sound.playMusic(ZONES[zi].id); }
      game.zoneIdx = zi;
    }
    fx.emitFor(k, { drifting: c.drifting, boosting: c.boosting, slip: c.slip, charge: c.driftTime, speed: c.vF }, dt);

    // 완주 체크
    if (!game.finished && game.inputEnabled && c.progress >= game.laps) {
      game.finished = true;
      game.finishTime = Math.max(0, now - game.raceStart);
      sendState(now);
      net.send({ type: 'finish' });
    }

    if (now - game.lastSend >= SEND_INTERVAL) sendState(now);

    sound.update(Math.min(Math.abs(c.vF) / TOP_SPEED, 1), inp.throttle || c.boosting ? 1 : 0, true, c.drifting);
    // 랩 통과 / 마지막 랩
    const lapNow = THREE.MathUtils.clamp(Math.floor(c.progress) + 1, 1, game.laps);
    if (game.inputEnabled && !game.finished && lapNow > (game.lapShown || 1)) {
      game.lapShown = lapNow;
      if (lapNow === game.laps) { sound.finalLap(); ui.toast('🏁 마지막 랩!', 2000); } else sound.lap();
    }
    if (c.boosting && !game.wasBoosting) sound.boost();
    game.wasBoosting = c.boosting;
    if (c.air && !game.wasAir && c.vy > 4) sound.jump();
    // 대점프대 / 낭떠러지에서 날아오르면 한마디
    if (c.air && !game.wasAir && !game.finished) {
      const st = track.stuntNear(c.hint, 30 / track.spacing);
      if (st?.kind === 'jump' && c.vy > 8) ui.toast('🚀 대점프!', 1200);
      else if (st?.kind === 'cliff') { ui.toast('😱 낭떠러지!', 1200); sound.jump(); }
    }
    game.wasAir = c.air;

    const list = standings();
    const time = game.finished ? game.finishTime : game.inputEnabled ? Math.max(0, now - game.raceStart) : 0;
    ui.updateHud({
      speed: Math.abs(c.vF) * 3.6,
      lap: THREE.MathUtils.clamp(Math.floor(c.progress) + 1, 1, game.laps),
      laps: game.laps,
      pos: list.findIndex((s) => s.me) + 1,
      total: list.length,
      time,
      standings: list,
      wrongWay: c.wrongWay,
      finished: game.finished,
      myId: game.myId,
      gauge: c.gauge,
      items: c.items,
      boosting: c.boosting,
      held: game.heldItems,
      rolling: game.itemRoll > 0,
      ping: net.offline ? null : Math.round(net.rtt),
    });
    ui.drawMinimap(list);
  } else {
    sound.update(0, 0, false);
  }

  updateHazards(track, hazardClock());
  items.update(dt, now, game.time);
  updateCamera(dt);
  updateAtmosphere(dt);
  fx.update(dt, camera, renderer);

  // 그림자 카메라가 시점 근처를 따라다니게
  const focus = L ? L.kart.root.position : track.points[SHOW_INDEX];
  sun.target.position.set(focus.x, focus.y || 0, focus.z);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/** 번개 구름을 들고 있는데 다른 카트에 닿았으면 그 카트에게 넘김 (서버가 최종 판정) */
function passCloud(toId, now) {
  if (items.cloud?.holder !== game.myId || now - (game.cloudPassAt || 0) < 700) return;
  game.cloudPassAt = now;
  net.send({ type: 'cloudPass', to: toId });
}

/** 자석: 카트 앞쪽으로 빨려 들어가는 파란 불꽃 */
function magnetFx(x, y, z, yaw, dt) {
  const fx_ = Math.sin(yaw), fz_ = Math.cos(yaw);
  for (let k = 0; k < Math.ceil(dt * 50); k++) {
    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 2;
    const px = x + fx_ * 4 + Math.cos(a) * r, pz = z + fz_ * 4 + Math.sin(a) * r;
    fx.glow.emit(px, y + 1 + Math.random() * 1.5, pz, (x + fx_ * 2 - px) * 4, 0, (z + fz_ * 2 - pz) * 4, 0.25, 0.4, 0.1, 0.35, 0.7, 1, 1, 1);
  }
}

// ---------------- 카트끼리 충돌 ----------------
const BUMP_DEDUPE_MS = 300; // 같은 충돌을 내 쪽 감지 + 상대 알림으로 두 번 적용하지 않도록

/** 내 카트 ↔ 다른 카트. 각자 자기 카트를 처리하고, 상대에게는 '부딪힘' 알림을 보내 양쪽이 동시에 튕기게 */
function collideKarts(c, now) {
  for (const [id, r] of game.remotes) {
    const recentBump = now - (r.bumpAt || 0) < BUMP_DEDUPE_MS; // 상대 알림으로 이미 튕겼으면 겹침만 풀기
    const hit = c.collideWith(r.x, r.z, r.vx, r.vz, r.y, !recentBump);
    if (hit) passCloud(id, now);
    if (!hit || recentBump) continue;
    r.hitAt = now;
    crashFx(c.x - hit.nx * 1.4, c.y, c.z - hit.nz * 1.4, hit.speed);
    if (!net.offline && hit.speed > 2 && now - (r.sentAt || 0) > 150) {
      r.sentAt = now;
      net.send({ type: 'bump', target: id, ix: -hit.nx * hit.speed * BUMP_K, iz: -hit.nz * hit.speed * BUMP_K });
    }
  }
  // 다른 사람끼리 부딪히는 것도 불꽃으로 보여주기
  const list = [...game.remotes.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
    if (d > 2.8 || d < 1e-3 || Math.abs((a.y || 0) - (b.y || 0)) > 1.6) continue;
    const closing = -((a.vx - b.vx) * dx + (a.vz - b.vz) * dz) / d;
    const key = a.kart.root.id * 10000 + b.kart.root.id;
    if (closing > 4 && now - (pairFxAt.get(key) || 0) > 400) {
      pairFxAt.set(key, now);
      crashFx((a.x + b.x) / 2, ((a.y || 0) + (b.y || 0)) / 2, (a.z + b.z) / 2, closing, true);
    }
  }
}
const pairFxAt = new Map();

/** 충돌 불꽃 + 쿵 소리 (멀리서 난 충돌은 작게) */
function crashFx(x, y, z, speed, distant = false) {
  const n = Math.min(36, Math.round(speed * 2));
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * speed * 0.4;
    const hot = Math.random() < 0.6;
    fx.glow.emit(x, y + 0.8, z, Math.cos(a) * v, 2 + Math.random() * 5, Math.sin(a) * v, 0.25 + Math.random() * 0.25, 0.5, 0.08, 1, hot ? 0.85 : 0.55, hot ? 0.4 : 0.15, 1, 3);
  }
  const vol = Math.min(1, speed / 20) * (distant ? Math.max(0, 1 - camera.position.distanceTo(new THREE.Vector3(x, y, z)) / 60) : 1);
  if (vol > 0.05) sound.thud(vol);
}

// ---------------- 아이템 ----------------
/** 순위에 따라 아이템 확률 조절: 1등은 바나나(방어), 뒤쪽일수록 미사일/물폭탄(공격), 게이지 충전은 모두에게 */
const ITEM_ODDS = {
  //          바나나 물폭탄 미사일 게이지 방어막 자석 번개구름
  solo:     [0.2, 0.15, 0.15, 0.15, 0.15, 0.1, 0.1],   // 혼자 연습
  first:    [0.4, 0.2, 0, 0.15, 0.25, 0, 0],          // 1등: 미사일·자석·번개 없음, 방어막 많이
  middle:   [0.17, 0.17, 0.18, 0.12, 0.12, 0.12, 0.12],
  last:     [0.06, 0.12, 0.22, 0.14, 0.08, 0.2, 0.18],  // 꼴등: 따라잡는 아이템 위주
};
const ITEM_KINDS = ['banana', 'bomb', 'missile', 'charge', 'shield', 'magnet', 'cloud'];
function rollItem() {
  const list = standings();
  const pos = list.findIndex((s) => s.me);
  const odds = list.length < 2 ? ITEM_ODDS.solo : pos === 0 ? ITEM_ODDS.first : pos === list.length - 1 ? ITEM_ODDS.last : ITEM_ODDS.middle;
  let r = Math.random();
  for (let k = 0; k < odds.length; k++) { if (r < odds[k]) return ITEM_KINDS[k]; r -= odds[k]; }
  return 'banana';
}

/** 자석 목표: 바로 앞 순위 카트가 MAGNET_RANGE 안이면 { id }, 아니면 null */
function magnetTarget() {
  const list = standings();
  const pos = list.findIndex((s) => s.me);
  for (let i = pos - 1; i >= 0; i--) {
    if (list[i].finished) continue;
    return (list[i].p - list[pos].p) * track.length <= MAGNET_RANGE ? { id: list[i].id } : null;
  }
  return null;
}

/** 미사일 목표: 바로 앞 순위 (완주한 사람 제외). 220m 넘게 떨어져 있으면 조준 안 함 → { id, gap } */
function missileTarget() {
  const list = standings();
  const pos = list.findIndex((s) => s.me);
  for (let i = pos - 1; i >= 0; i--) {
    if (list[i].finished) continue;
    const gap = (list[i].p - list[pos].p) * track.length;
    return gap <= MISSILE_LOCK_RANGE ? { id: list[i].id, gap } : { id: null, gap };
  }
  return { id: null, gap: null };
}

function updateLocalItems(c, inp, now, dt) {
  // 아이템 박스
  const box = items.touchBox(c.x, c.z, now);
  if (box >= 0) {
    items.breakBox(box, now);
    net.send({ type: 'box', i: box });
    sound.box();
    // 빈 칸이 있으면 아이템 획득 (룰렛은 하나씩 차례로)
    if (game.heldItems.length + game.rollQueue.length < MAX_HELD_ITEMS) {
      game.rollQueue.push(rollItem());
      if (game.itemRoll <= 0) game.itemRoll = ITEM_ROLL_TIME;
    }
  }
  if (game.itemRoll > 0) {
    if (game.time - (game.lastTick || 0) > 0.09) { sound.tick(); game.lastTick = game.time; }
    game.itemRoll -= dt;
    if (game.itemRoll <= 0) {
      game.heldItems.push(game.rollQueue.shift());
      sound.itemGet();
      if (game.rollQueue.length) game.itemRoll = ITEM_ROLL_TIME;
    }
  }

  // 아이템 사용 (Z, 누르는 순간 1회) - 첫 번째 칸부터
  const useItem = game.heldItems[0];
  if (inp.item && !game.prevItemKey && useItem && !c.stunned) {
    const fx_ = Math.sin(c.heading), fz_ = Math.cos(c.heading);
    if (useItem === 'charge') {
      // 게이지 충전: 드리프트 게이지를 가득 채움 → 부스터 1개 획득 (2칸이 꽉 찼으면 게이지만 가득 찬 채로 대기)
      const full = c.items >= 2;
      c.gauge = 1;
      sound.charge();
      chargeFx(c);
      ui.toast(full ? '⚡ 게이지 가득! (부스터를 쓰면 바로 채워짐)' : '⚡ 게이지 충전! 부스터 획득 (Space)', 1500);
    } else if (useItem === 'shield') {
      c.shieldTime = SHIELD_TIME;
      sound.shield();
      ui.toast('🛡️ 방어막! 5초 동안 공격 1번을 막아요', 1500);
    } else if (useItem === 'magnet') {
      const aim = magnetTarget();
      game.magnetTarget = aim?.id ?? null;
      c.magnetTime = MAGNET_TIME;
      sound.magnet();
      ui.toast(aim ? `🧲 ${game.players.get(aim.id)?.name ?? ''} 에게 끌려갑니다!` : '🧲 앞에 가까운 카트가 없어서 가속만!', 1400);
    } else if (useItem === 'cloud') {
      net.send({ type: 'item', kind: 'cloud', x: c.x, z: c.z });
      ui.toast('⛈️ 1등 머리 위에 번개 구름!', 1400);
    } else if (useItem === 'banana') {
      net.send({ type: 'item', kind: 'banana', x: c.x - fx_ * 3.6, z: c.z - fz_ * 3.6 });
      sound.drop();
    } else if (useItem === 'missile') {
      const loc = track.locate(c.x, c.z, c.hint);
      const aim = missileTarget();
      const m = { id: `local${++game.bombSeq}`, owner: game.myId, target: aim.id, x: c.x + fx_ * 3, z: c.z + fz_ * 3, idx: loc.index, lat: loc.lateral };
      items.fireMissile(m, now);
      sound.missile();
      net.send({ type: 'item', kind: 'missile', x: m.x, z: m.z, idx: m.idx, lat: m.lat, target: m.target, cid: m.id });
      if (m.target != null) ui.toast(`🎯 ${game.players.get(m.target)?.name ?? ''} 조준! (${Math.round(aim.gap)}m)`, 1200);
      else if (aim.gap != null) ui.toast(`🚀 앞사람이 너무 멀어서(${Math.round(aim.gap)}m) 직진 발사!`, 1500);
      else ui.toast('🚀 앞에 아무도 없어서 직진 발사!', 1200);
    } else {
      const loc = track.locate(c.x, c.z, c.hint);
      const bomb = { id: `local${++game.bombSeq}`, owner: game.myId, x: c.x + fx_ * 2, z: c.z + fz_ * 2, idx: loc.index, lat: loc.lateral };
      items.throwBomb(bomb, now);
      sound.throwIt();
      net.send({ type: 'item', kind: 'bomb', x: bomb.x, z: bomb.z, idx: bomb.idx, lat: bomb.lat });
    }
    game.heldItems.shift(); // 두 번째 아이템이 앞으로
  }
  game.prevItemKey = inp.item;

  // 미사일이 바나나에 막힘 (목표가 된 사람 / 목표 없는 미사일은 쏜 사람 화면이 판정)
  for (const [mid, bid, m] of items.blockedMissiles()) {
    if (!(m.target === game.myId || (m.target == null && m.owner === game.myId))) continue;
    net.send({ type: 'missileHit', id: mid });
    net.send({ type: 'hitBanana', id: bid });
    items.explodeMissile(mid);
    items.removeBanana(bid);
    if (m.target === game.myId) ui.toast('🍌 바나나로 미사일을 막았다!', 1500);
  }

  // 미사일 명중 (남이 쏜 것만, 서버 id 가 있는 것)
  for (const m of items.missiles) {
    if (m.owner === game.myId || typeof m.id !== 'number') continue;
    // 미사일은 낮게 날아서 점프 중이면 아래로 지나감
    if (Math.abs(m.y - (c.y + 1.2)) > MISSILE_HIT_HEIGHT) continue;
    // 프레임이 느려도 빠져나가지 않게 이번 프레임 이동 거리만큼 판정을 넓힘
    if (Math.hypot(m.x - c.x, m.z - c.z) < MISSILE_HIT_RADIUS + Math.abs(c.vF) * dt) {
      c.blast(); // 방어막이 있으면 막힘 (미사일은 어쨌든 터짐)
      net.send({ type: 'missileHit', id: m.id });
      items.explodeMissile(m.id);
      break;
    }
  }

  // 바나나 밟기
  const banana = c.air ? null : items.touchBanana(c.x, c.z, game.myId, now);
  if (banana != null) {
    if (c.spinOut()) sound.slip();
    items.removeBanana(banana);
    net.send({ type: 'hitBanana', id: banana });
  }

  // 물폭탄 물보라 (내가 던진 건 무시)
  for (const b of items.activeSplashes(now)) {
    b.checked = true;
    if (b.owner === game.myId || b.hitMe) continue;
    if (Math.hypot(c.x - b.ex, c.z - b.ez) < SPLASH_RADIUS) {
      b.hitMe = true;
      if (c.trap()) sound.trapped();
    }
  }
}

/** 카메라에서 가까울수록 크게 (0~1) */
const nearVol = (x, z, range = 120) => Math.max(0, 1 - Math.hypot(camera.position.x - x, camera.position.z - z) / range);

/** 게이지 충전 연출: 카트 주변에 노란 전기 불꽃 */
function chargeFx(c) {
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 1.5;
    fx.glow.emit(c.x + Math.cos(a) * r, c.y + 0.5 + Math.random() * 2.5, c.z + Math.sin(a) * r,
      -Math.cos(a) * 3, 2 + Math.random() * 3, -Math.sin(a) * 3, 0.4 + Math.random() * 0.3, 0.6, 0.1, 1, 0.9, 0.3, 1, 2);
  }
}

function bubblePop(x, z) {
  if (nearVol(x, z, 60) > 0) sound.pop();
  for (let k = 0; k < 30; k++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI;
    fx.glow.emit(x + Math.cos(a) * 2.5, 2 + Math.cos(e) * 2.5, z + Math.sin(a) * 2.5, Math.cos(a) * 5, 2 + Math.random() * 3, Math.sin(a) * 5, 0.5, 0.6, 0.1, 0.6, 0.85, 1, 1, 2);
  }
}

// ---------------- 구역별 하늘/안개/조명 + 눈 ----------------
const _w = ZONES.map(() => 0);
const _sky = new THREE.Color();
function updateAtmosphere(dt) {
  zoneWeights(camera.position.x, camera.position.z, _w);
  const k = 1 - Math.exp(-dt * 2);
  blendColor(_w, 'sky', _sky);
  scene.background.lerp(_sky, k);
  scene.fog.color.copy(scene.background);
  scene.fog.near += (ZONES.reduce((s, zn, i) => s + zn.fog[0] * _w[i], 0) - scene.fog.near) * k;
  scene.fog.far += (ZONES.reduce((s, zn, i) => s + zn.fog[1] * _w[i], 0) - scene.fog.far) * k;
  hemi.color.lerp(blendColor(_w, 'hemiSky', _sky), k);
  hemi.groundColor.lerp(blendColor(_w, 'hemiGround', _sky), k);
  // 얼음 동굴 안: 햇빛/하늘빛을 줄이고 눈 내림 끄기
  const near = game.local ? game.local.ctrl.hint : track.nearest(camera.position.x, camera.position.z).i;
  const inTunnel = track.tunnel[near] && camera.position.distanceTo(track.points[near]) < 60;
  const kl = 1 - Math.exp(-dt * 3);
  sun.intensity += ((inTunnel ? 0.35 : 2.4) - sun.intensity) * kl;
  hemi.intensity += ((inTunnel ? 0.5 : 1.3) - hemi.intensity) * kl;
  snow.update(dt, camera, inTunnel ? 0 : _w[1], game.time);
}

function sendState(now) {
  const c = game.local.ctrl;
  game.lastSend = now;
  const fl = (c.drifting ? FLAG_DRIFT : 0) | (c.boosting ? FLAG_BOOST : 0) | (c.spinTime > 0 ? FLAG_SPIN : 0) | (c.trapTime > 0 ? FLAG_TRAP : 0) | (c.blastTime > 0 ? FLAG_BLAST : 0)
    | (c.shieldTime > 0 ? FLAG_SHIELD : 0) | (c.magnetTime > 0 ? FLAG_MAGNET : 0) | (c.fallTime > 0 ? FLAG_FALL : 0);
  net.send({ type: 'state', x: c.x, z: c.z, y: c.y, ry: c.heading, sp: c.vF, st: c.steer, p: c.progress, fl });
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

menuShowroom();
refreshGarage();
requestAnimationFrame(frame);

// 디버그: ?debug 로 접속하면 콘솔에서 window.__dbg 로 상태 접근 (순간이동 테스트 등)
if (new URLSearchParams(location.search).has('debug')) window.__dbg = { game, track, items, camera, renderer, net, netClock, sound };
