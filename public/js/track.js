// 트랙: 숲 → 빙하 → 사막 → 도시 → 블록 세상을 지나는 약 5.6km 순환 코스
// - Catmull-Rom 스플라인을 따라 도로/연석/벽 리본 메시 생성
// - 구역(zone)은 위치 기반 가중치로 부드럽게 섞임 (지면 색, 언덕 높이, 도로/벽 색, 하늘)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const ROAD_HALF = 10;   // 도로 반폭 (m) - 6명이 3대씩 나란히 달릴 수 있는 폭
export const CURB_W = 1.4;     // 연석 폭
export const WALL_DIST = 18;   // 중심선에서 벽까지 거리
const SPACING = 1.4;           // 샘플 간격 (m)

// 트랙 모양 (x, z, 단위 m). 첫 점이 출발선
const CONTROL_POINTS = [
  [-600, 400], [-600, 250], [-565, 150], [-622, 55], [-565, -45],                     // 숲 (S자 커브)
  [-620, -200], [-700, -330], [-640, -470], [-500, -530], [-390, -480], [-290, -560], [-160, -570], // 빙하
  [0, -480], [100, -570], [230, -510], [350, -560], [440, -560], [580, -500], [640, -360], [570, -250], [650, -140], // 사막 (S자 시케인)
  [620, 20], [520, 90], [560, 220], [680, 300], [640, 440], [480, 480], [360, 410], [220, 460], // 도시
  [150, 600], [200, 740], [120, 860], [30, 880], [-20, 960], [-110, 1000], [-220, 950], [-300, 840], // 블록 세상 (S자)
  [-330, 710], [-420, 610], [-540, 630], [-640, 540],                                // 다시 숲
];

export const ZONES = [
  {
    id: 'forest', name: '숲', label: 'FOREST', emoji: '🌲', center: [-380, 380],
    ground: 0x5d9b3f, runoff: 0xb9a77f, road: 0xffffff, wall: 0x4a8fe0, gate: 0x2d6a4f, map: '#7bd389',
    sky: 0xa8d8f0, fog: [250, 1100], hemiSky: 0xe0f2ff, hemiGround: 0x4a6b3a, hill: 10, grip: 1, offroadMax: 24,
  },
  {
    id: 'glacier', name: '빙하', label: 'GLACIER', emoji: '❄️', center: [-470, -420],
    ground: 0xe6f1fa, runoff: 0xcfe3f2, road: 0xd6e8ff, wall: 0xa9dcff, gate: 0x3a86c8, map: '#bfe9ff',
    sky: 0xcbe3f3, fog: [130, 800], hemiSky: 0xf0f8ff, hemiGround: 0xa8c4dc, hill: 24, grip: 0.55, offroadMax: 22,
  },
  {
    id: 'desert', name: '사막', label: 'DESERT', emoji: '🏜️', center: [380, -430],
    ground: 0xe3c07a, runoff: 0xd9b26a, road: 0xf2dcb0, wall: 0xe09a5a, gate: 0xc8553d, map: '#ffcf70',
    sky: 0xf3d7a6, fog: [180, 950], hemiSky: 0xfff1d6, hemiGround: 0xc9a46a, hill: 14, grip: 0.95, offroadMax: 18,
  },
  {
    id: 'city', name: '도시', label: 'CITY', emoji: '🏙️', center: [520, 280],
    ground: 0x7d838c, runoff: 0x9ca3ad, road: 0x8c919a, wall: 0xff6b6b, gate: 0x6c5ce7, map: '#b9a7ff',
    sky: 0xbfcdf0, fog: [220, 1000], hemiSky: 0xe8ecff, hemiGround: 0x6b6f7a, hill: 0, grip: 1, offroadMax: 26,
  },
  {
    id: 'block', name: '블록 세상', suffix: '', label: 'BLOCK WORLD', emoji: '🧱', center: [-40, 780],
    ground: 0x6fcf4f, runoff: 0xe4e7ef, road: 0xb9c0d8, wall: 0xff4d4d, gate: 0xff7a00, map: '#ff8a5c',
    sky: 0xbfe6ff, fog: [250, 1100], hemiSky: 0xffffff, hemiGround: 0x8fd16f, hill: 6, grip: 1, offroadMax: 24,
  },
];

// 모든 클라이언트가 같은 배경을 보도록 시드 고정 난수
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw, renderer) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function noise(ctx, w, h, count, colors, rand) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.fillRect(rand() * w, rand() * h, 2, 2);
  }
}

/** 원형 배열 이동 평균 (반경 r) */
function smoothArray(arr, r) {
  const n = arr.length, out = new Float32Array(n);
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += arr[((k % n) + n) % n];
  for (let i = 0; i < n; i++) {
    out[i] = sum / (2 * r + 1);
    sum += arr[(i + r + 1) % n] - arr[((i - r) % n + n) % n];
  }
  return out;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 위치별 구역 가중치 (합 = 1). 가장 가까운 구역 중심 기준으로 ~70m 폭에서 섞임 */
export function zoneWeights(x, z, out = ZONES.map(() => 0)) {
  let dmin = Infinity;
  const d = ZONES.map((zn) => {
    const v = Math.hypot(x - zn.center[0], z - zn.center[1]);
    dmin = Math.min(dmin, v);
    return v;
  });
  let sum = 0;
  for (let i = 0; i < ZONES.length; i++) { out[i] = Math.exp(-(d[i] - dmin) / 70); sum += out[i]; }
  for (let i = 0; i < ZONES.length; i++) out[i] /= sum;
  return out;
}

const _c = new THREE.Color();
/** 가중치로 구역 속성 색을 섞음 */
export function blendColor(w, key, target = new THREE.Color()) {
  target.setRGB(0, 0, 0);
  ZONES.forEach((zn, i) => { if (w[i] > 0.001) target.add(_c.set(zn[key]).multiplyScalar(w[i])); });
  return target;
}
export const blendValue = (w, key) => ZONES.reduce((s, zn, i) => s + zn[key] * w[i], 0);

// ---------------- 배경 오브젝트용 합친 지오메트리 ----------------
function part(geo, color, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  const col = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
const merge = (parts) => mergeGeometries(parts);

function buildPrototypes() {
  const cyl = (r1, r2, h, s = 7) => new THREE.CylinderGeometry(r1, r2, h, s);
  const cone = (r, h, s = 7) => new THREE.ConeGeometry(r, h, s);
  const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
  const sph = (r) => new THREE.SphereGeometry(r, 8, 6);
  const TRUNK = 0x6b4a2b;
  const palmLeaves = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    palmLeaves.push(part(new THREE.BoxGeometry(0.9, 0.12, 3.6), 0x3f9a46, {
      pos: [Math.sin(a) * 1.6, 7.6, Math.cos(a) * 1.6], rot: [0.5, a, 0], scale: [1, 1, 1],
    }));
  }
  return {
    pine: merge([part(cyl(0.25, 0.35, 2), TRUNK, { pos: [0, 1, 0] }), part(cone(2, 5), 0x2f7d3a, { pos: [0, 4.2, 0] })]),
    roundTree: merge([part(cyl(0.3, 0.4, 2.6), TRUNK, { pos: [0, 1.3, 0] }), part(ico(2.3, 1), 0x4fa33a, { pos: [0, 4.3, 0] })]),
    bush: merge([part(ico(1.2, 1), 0x3d8a35, { pos: [0, 0.6, 0], scale: [1, 0.75, 1] }), part(ico(0.8, 1), 0x4c9a3f, { pos: [0.9, 0.45, 0.3] })]),
    rock: merge([part(new THREE.DodecahedronGeometry(1.5), 0x8d8d8d, { pos: [0, 0.5, 0] })]),
    mushroom: merge([part(cyl(0.25, 0.3, 1.1), 0xfff3e0, { pos: [0, 0.55, 0] }),
      part(new THREE.SphereGeometry(0.8, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xe63946, { pos: [0, 1.0, 0] })]),
    snowyPine: merge([part(cyl(0.25, 0.35, 2), TRUNK, { pos: [0, 1, 0] }), part(cone(2, 5), 0x2c6b4a, { pos: [0, 4.2, 0] }),
      part(cone(1.35, 2.6), 0xffffff, { pos: [0, 5.6, 0] }), part(cyl(1.6, 2.05, 0.35), 0xffffff, { pos: [0, 2.0, 0] })]),
    iceberg: merge([part(ico(3, 0), 0xeef8ff, { pos: [0, 1.2, 0], scale: [1, 0.8, 1.2] }), part(ico(1.8, 0), 0xd5efff, { pos: [2.2, 0.6, 1] })]),
    iceSpike: merge([part(cone(1, 7, 5), 0xaee9ff, { pos: [0, 3.3, 0] }), part(cone(0.6, 4.5, 5), 0xc8f1ff, { pos: [1.1, 2.0, 0.4], rot: [0, 0, -0.25] }),
      part(cone(0.5, 3.5, 5), 0x9fdcff, { pos: [-0.9, 1.5, -0.3], rot: [0.2, 0, 0.3] })]),
    snowman: merge([part(sph(1.3), 0xffffff, { pos: [0, 1.2, 0] }), part(sph(0.95), 0xffffff, { pos: [0, 2.9, 0] }), part(sph(0.7), 0xffffff, { pos: [0, 4.2, 0] }),
      part(cone(0.14, 0.8, 6), 0xff8c1a, { pos: [0, 4.2, 1.0], rot: [Math.PI / 2, 0, 0] }),
      part(sph(0.1), 0x111111, { pos: [-0.25, 4.4, 0.62] }), part(sph(0.1), 0x111111, { pos: [0.25, 4.4, 0.62] }),
      part(cyl(0.45, 0.45, 0.7, 10), 0x222222, { pos: [0, 5.05, 0] }), part(cyl(0.7, 0.7, 0.08, 10), 0x222222, { pos: [0, 4.72, 0] }),
      part(cyl(0.72, 0.72, 0.25, 10), 0xe63946, { pos: [0, 3.55, 0] })]),
    // 선인장: 저폴리 (원기둥 + 둥근 끝)
    cactus: merge([part(cyl(0.45, 0.45, 3.6, 6), 0x3f8f3a, { pos: [0, 1.8, 0] }), part(ico(0.45), 0x3f8f3a, { pos: [0, 3.6, 0] }),
      part(cyl(0.3, 0.3, 0.8, 6), 0x3f8f3a, { pos: [-0.65, 1.9, 0], rot: [0, 0, Math.PI / 2] }),
      part(cyl(0.3, 0.3, 1.2, 6), 0x3f8f3a, { pos: [-1.05, 2.5, 0] }), part(ico(0.3), 0x3f8f3a, { pos: [-1.05, 3.1, 0] }),
      part(cyl(0.28, 0.28, 0.7, 6), 0x3f8f3a, { pos: [0.6, 2.7, 0], rot: [0, 0, Math.PI / 2] }),
      part(cyl(0.28, 0.28, 0.9, 6), 0x3f8f3a, { pos: [0.95, 3.15, 0] }), part(ico(0.28), 0x3f8f3a, { pos: [0.95, 3.6, 0] }),
      part(ico(0.25), 0xff6fae, { pos: [0, 4.05, 0] })]),
    palm: merge([part(cyl(0.28, 0.45, 7.6), 0x9c6b3c, { pos: [0.4, 3.8, 0], rot: [0, 0, -0.1] }), ...palmLeaves,
      part(sph(0.35), 0x6b4a2b, { pos: [0.75, 7.3, 0.3] })]),
    desertRock: merge([part(new THREE.DodecahedronGeometry(1.6), 0xc98a4b, { pos: [0, 0.6, 0], scale: [1.3, 0.8, 1] }),
      part(new THREE.DodecahedronGeometry(0.9), 0xb8773c, { pos: [1.6, 0.3, 0.6] })]),
    mesa: merge([part(cyl(1, 1.15, 1, 8), 0xc4693b, { pos: [0, 0.5, 0] }), part(cyl(1.01, 1.01, 0.12, 8), 0xe39a5c, { pos: [0, 0.72, 0] })]),
    // 블록 나무: 갈색 벽돌 기둥 + 작아지는 초록 벽돌 3층
    brickTree: merge([part(new THREE.BoxGeometry(1.2, 3, 1.2), 0x8b5a2b, { pos: [0, 1.5, 0] }),
      part(new THREE.BoxGeometry(5, 1.4, 5), 0x2fbf71, { pos: [0, 3.6, 0] }), part(new THREE.BoxGeometry(3.6, 1.4, 3.6), 0x3ed47f, { pos: [0, 5.0, 0] }),
      part(new THREE.BoxGeometry(2.2, 1.4, 2.2), 0x2fbf71, { pos: [0, 6.4, 0] }),
      ...[[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([x, z]) => part(cyl(0.3, 0.3, 0.3, 8), 0x3ed47f, { pos: [x, 7.25, z] }))]),
    lamp: merge([part(cyl(0.12, 0.16, 8, 6), 0x555a66, { pos: [0, 4, 0] }), part(new THREE.BoxGeometry(0.15, 0.15, 2.2), 0x555a66, { pos: [0, 8, 1.0] }),
      part(new THREE.BoxGeometry(0.5, 0.22, 0.9), 0xfff2b0, { pos: [0, 7.85, 1.9] })]),
  };
}

export class Track {
  constructor(scene, renderer) {
    const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    this.N = Math.round(this.length / SPACING);
    const spaced = this.curve.getSpacedPoints(this.N);
    spaced.pop(); // 마지막 점 == 첫 점
    this.points = spaced;
    this.spacing = this.length / this.N;

    this.tangents = [];
    this.sides = [];
    this.zoneW = [];      // 샘플별 구역 가중치
    this.zone = new Uint8Array(this.N); // 샘플별 대표 구역
    for (let i = 0; i < this.N; i++) {
      const a = this.points[(i - 1 + this.N) % this.N];
      const b = this.points[(i + 1) % this.N];
      const t = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
      this.tangents.push(t);
      this.sides.push(new THREE.Vector3(-t.z, 0, t.x)); // 진행 방향 기준 오른쪽
      const w = zoneWeights(this.points[i].x, this.points[i].z, []);
      this.zoneW.push(w);
      this.zone[i] = w.indexOf(Math.max(...w));
    }
    // 거리 계산용 성긴 샘플
    this.coarse = this.points.filter((_, i) => i % 6 === 0);
    this.buildProfile();

    this.bounds = new THREE.Box3().setFromPoints(this.points);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rand = mulberry32(1337);
    this.build(renderer);
  }

  /** 가장 가까운 트랙 위치. hint(이전 인덱스)가 있으면 주변만 탐색 */
  locate(x, z, hint = -1) {
    const N = this.N;
    let best = 0, bestD = Infinity;
    const hinted = hint >= 0;
    if (!hinted) {
      // 성긴 샘플로 대략 찾은 뒤 주변 정밀 탐색
      for (let k = 0; k < this.coarse.length; k++) {
        const p = this.coarse[k];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) { bestD = d; best = k * 6; }
      }
      hint = best;
      bestD = Infinity;
    }
    for (let k = hint - 40; k <= hint + 40; k++) {
      const i = ((k % N) + N) % N;
      const p = this.points[i];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    // 힌트 주변에 도로가 없으면(순간이동·재접속·긴 렉 뒤) 힌트가 틀린 것 → 전체에서 다시 찾기
    // (안 그러면 원격 카트가 엉뚱한 구간 높이에 떠서 충돌·미사일 추적이 계속 빗나감)
    if (hinted && bestD > (WALL_DIST + 6) ** 2) return this.locate(x, z);
    const p = this.points[best], t = this.tangents[best], s = this.sides[best];
    const dx = x - p.x, dz = z - p.z;
    const along = dx * t.x + dz * t.z;
    const lateral = dx * s.x + dz * s.z; // +: 오른쪽
    const f = (((best + along / this.spacing) % N) + N) % N;
    return { index: best, f, lateral };
  }

  // ---------------- 높낮이 ----------------
  /** 구역별 지형: 숲 언덕+점프대, 빙하 얼음 동굴, 사막 모래 언덕+점프대, 도시 고가도로+점프 */
  buildProfile() {
    const N = this.N, sp = this.spacing;
    const m = (meters) => meters / sp; // 미터 → 샘플 수
    this.height = new Float32Array(N);
    this.bridge = new Uint8Array(N);  // 고가도로 (아래 지면은 평지 유지)
    this.tunnel = new Uint8Array(N);  // 얼음 동굴
    // 같은 구역이 이어지는 구간(run) 찾기
    const runs = [];
    let start = 0;
    for (let i = 1; i <= N; i++) {
      if (i === N || this.zone[i] !== this.zone[start]) { runs.push({ zone: ZONES[this.zone[start]].id, a: start, b: i }); start = i; }
    }
    const bump = (i, c, w, H) => { const d = Math.abs(i - c); return d < w ? H * 0.5 * (1 + Math.cos((Math.PI * d) / w)) : 0; };
    const plateau = (i, s0, s1, r, H) => H * smoothstep(s0, s0 + r, i) * (1 - smoothstep(s1 - r, s1, i));
    const feats = [];
    const crests = []; // 점프대 끝(가장 높은 곳) 인덱스
    // 점프 전후로 휘어지는 정도: 점프대 30m 전 ~ 착지 지점 70m 후 진행 방향 변화 (라디안)
    const bend = (c) => {
      const t0 = this.tangents[((Math.round(c - m(30)) % N) + N) % N], t1 = this.tangents[Math.round(c + m(70)) % N];
      let worst = 0;
      for (let k = Math.round(c - m(30)); k <= c + m(70); k += 4) {
        const t = this.tangents[((k % N) + N) % N];
        worst = Math.max(worst, Math.acos(Math.min(1, t.dot(t0))), Math.acos(Math.min(1, t.dot(t1))));
      }
      return worst;
    };
    // [lo, hi] 구간에서 가장 곧은 곳 찾기 → 점프가 벽으로 날아가지 않게
    const straightest = (lo, hi) => {
      let best = lo, bv = Infinity;
      for (let c = lo; c <= hi; c += 5) { const v = bend(c); if (v < bv) { bv = v; best = c; } }
      return best;
    };
    // 앞뒤 창 크기를 직접 정하는 버전 (대점프·낭떠러지는 비행 거리가 길어서 더 멀리까지 곧아야 함)
    const bendW = (c, back, fwd) => {
      const t0 = this.tangents[((Math.round(c - m(back)) % N) + N) % N];
      let worst = 0;
      for (let k = Math.round(c - m(back)); k <= c + m(fwd); k += 3) worst = Math.max(worst, Math.acos(Math.min(1, this.tangents[((k % N) + N) % N].dot(t0))));
      return worst;
    };
    const straightestW = (lo, hi, back, fwd) => {
      let best = lo, bv = Infinity;
      for (let c = lo; c <= hi; c += 3) { const v = bendW(c, back, fwd); if (v < bv) { bv = v; best = c; } }
      return Math.round(best);
    };
    const megaCrests = []; // 대점프대 (능선 꼭대기)
    this.stunts = [];      // { kind: 'jump' | 'cliff', i: 시작 인덱스, a, b: 아이템 박스를 피할 구간 }
    const quiet = []; // 굴곡/기울기를 넣지 않을 구간 [시작, 끝] (점프대·동굴·고가도로 주변)
    for (const r of runs) {
      const L = r.b - r.a, at = (t) => r.a + t * L;
      if (r.zone === 'forest') {
        if (r.a === 0) {
          // 출발 후: 언덕 꼭대기 점프 → 계곡으로 내리막 → 다시 오르막
          const c = straightest(at(0.35), at(0.6));
          feats.push((i) => bump(i, c, m(110), 9));
          feats.push((i) => bump(i, c + m(250), m(120), -6));
          crests.push(c);
        } else {
          // 마지막 숲: 움푹 꺼진 곳 → 언덕 점프
          const c = straightest(at(0.3), at(0.6));
          const dip = c - m(190);
          if (!this.stunts.some((st) => st.kind === 'cliff' && Math.abs(dip - st.i) < m(220))) feats.push((i) => bump(i, dip, m(80), -4));
          feats.push((i) => bump(i, c, m(110), 7));
          crests.push(c);
        }
      } else if (r.zone === 'glacier') {
        // 빙하 능선(+10m)을 올랐다가 얼음 동굴(-3m)로 크게 내리꽂힘
        const t0 = at(0.32), t1 = at(0.62);
        // 능선 꼭대기 = 대점프대: 스키 점프처럼 아래로 길게 날아가 동굴 입구 앞에 착지
        const rc = straightestW(t0 - m(175), t0 - m(135), 40, 130);
        feats.push((i) => bump(i, rc, m(120), 11));
        megaCrests.push(rc);
        this.stunts.push({ kind: 'jump', i: rc, a: rc - m(120), b: rc + m(140) });
        quiet.push([rc - m(130), rc + m(90)]);
        feats.push((i) => plateau(i, t0 - m(70), t1 + m(70), m(70), -3));
        feats.push((i) => bump(i, at(0.86), m(60), 5));
        for (let i = Math.floor(t0); i < t1; i++) this.tunnel[i] = 1;
        quiet.push([t0 - m(80), t1 + m(80)]);
      } else if (r.zone === 'desert') {
        // 모래 언덕 3개 + 작은 물결이 이어지는 '리듬 구간'
        const c = straightest(at(0.35), at(0.65));
        feats.push((i) => bump(i, c - m(230), m(70), 7));
        feats.push((i) => bump(i, c, m(95), 11));
        feats.push((i) => bump(i, c + m(270), m(60), 6));
        const w0 = c + m(110), w1 = c + m(195), wl = m(28);
        feats.push((i) => (i > w0 && i < w1 ? 0.35 * (1 - Math.cos((2 * Math.PI * (i - w0)) / wl)) : 0));
        crests.push(c);
        quiet.push([w0 - m(10), w1 + m(10)]);
      } else if (r.zone === 'block') {
        // 블록 세상: 큰 언덕 사이로 굴곡이 많음
        const c = straightest(at(0.35), at(0.65));
        feats.push((i) => bump(i, c - m(260), m(75), 6));
        feats.push((i) => bump(i, c - m(130), m(45), -3));
        feats.push((i) => bump(i, c, m(95), 10));
        crests.push(c);
        // 낭떠러지: 길게 올라간 블록 고원(+12m) 끝에서 20m 만에 아래로 뚝 떨어짐 → 공중으로 날아가 착지
        const d = straightestW(Math.max(c + m(330), at(0.7)), at(0.93), 30, 90);
        const H = 12;
        // 내려가는 모양 (1-u)²: 가장자리에서 바로 가파르게 꺾임 → 카트가 수평으로 튀어나가 떨어짐, 바닥은 완만해서 착지가 부드러움
        const drop = m(24);
        const edge = (i) => (i <= d ? 1 : i >= d + drop ? 0 : (1 - (i - d) / drop) ** 2);
        feats.push((i) => H * smoothstep(d - m(230), d - m(60), i) * edge(i));
        this.stunts.push({ kind: 'cliff', i: d, a: d - m(60), b: d + m(90) });
        quiet.push([d - m(240), d + m(150)]);
      } else if (r.zone === 'city') {
        // 지하로 살짝 내려갔다가 고가도로(15m)로 올라감
        const ramp = m(130);
        const s0 = at(0.14), s1 = straightest(at(0.68), at(0.86)) + ramp;
        feats.push((i) => bump(i, s0 - m(80), m(60), -4));
        feats.push((i) => plateau(i, s0, s1, ramp, 15));
        crests.push(s1 - ramp); // 고가도로 끝 내리막 시작에서 점프
        for (let i = Math.floor(s0 + ramp * 0.45); i < s1 - ramp * 0.45; i++) this.bridge[i] = 1;
        quiet.push([s0, s1]);
      }
    }
    for (const c of crests) quiet.push([c - m(90), c + m(90)]);
    quiet.push([N - m(140), N + m(170)], [-m(140), m(170)]); // 출발선 앞뒤는 평평하게

    // 조용한 구간 마스크(부드럽게) → 그 밖에만 전체 굴곡과 기울기 적용
    const mask = new Float32Array(N).fill(1);
    for (const [a, b] of quiet) for (let i = Math.floor(a); i <= b; i++) mask[((i % N) + N) % N] = 0;
    const soft = smoothArray(mask, Math.round(m(40)));

    // 전체적인 굴곡: 구역마다 세기가 다른 두 개의 물결
    const ampOf = { forest: 2.5, glacier: 3, desert: 2, city: 1, block: 2.5 };
    for (let i = 0; i < N; i++) {
      const sM = i * sp;
      const amp = ZONES.reduce((sum, zn, k) => sum + ampOf[zn.id] * this.zoneW[i][k], 0);
      const wave = 0.6 * Math.sin((2 * Math.PI * sM) / 430 + 1.3) + 0.4 * Math.sin((2 * Math.PI * sM) / 160 + 0.4);
      this.height[i] = feats.reduce((sum, f) => sum + f(i), 0) + amp * wave * soft[i];
    }

    // 커브 기울기(뱅크): 급한 커브일수록 안쪽으로 기울어짐 (최대 약 7°)
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = this.tangents[(i - 6 + N) % N], b = this.tangents[(i + 6) % N], sd = this.sides[i];
      const k = ((b.x - a.x) * sd.x + (b.z - a.z) * sd.z) / (12 * sp); // 오른쪽으로 도는 정도 (1/m)
      raw[i] = Math.max(-0.12, Math.min(0.12, -k * 3.8)) * soft[i];
    }
    this.bank = smoothArray(raw, Math.round(m(20)));

    // 점프대: 약 6m 길이로 1.8m 솟은 쐐기
    const K = Math.max(3, Math.round(6 / sp));
    this.ramps = crests.map((c) => ({ i0: Math.round(c) - K, i1: Math.round(c), h: 1.8, cap: 11 }));
    // 대점프대: 약 12m 길이로 3.2m 솟음, 발사 속도 상한 16 (능선 내리막 덕분에 약 1.5초, 80~110m 비행)
    const K2 = Math.round(12 / sp);
    // 점프대 바로 앞 50m 는 부스터 발판 → 오르막에서 느려져도 최고 속도로 날아감
    for (const c of megaCrests) this.ramps.push({ i0: c - K2, i1: c, h: 3.2, cap: 16, mega: true, pad: Math.round(50 / sp) });
  }

  /** 소수 인덱스 f 에서의 커브 기울기 (lateral 1m 당 높이 변화) */
  bankAt(f) {
    const N = this.N;
    const i = ((Math.floor(f) % N) + N) % N, j = (i + 1) % N, t = f - Math.floor(f);
    return this.bank[i] * (1 - t) + this.bank[j] * t;
  }

  /** 소수 인덱스 f 에서의 도로 높이 */
  heightAt(f) {
    const N = this.N;
    const i = ((Math.floor(f) % N) + N) % N, j = (i + 1) % N, t = f - Math.floor(f);
    return this.height[i] * (1 - t) + this.height[j] * t;
  }

  /** 진행 방향 기준 경사 (dh/ds) */
  slopeAt(f) {
    return (this.heightAt(f + 2) - this.heightAt(f - 2)) / (4 * this.spacing);
  }

  /** 점프대 위라면 추가 높이 */
  rampAt(f, lateral) {
    if (Math.abs(lateral) > ROAD_HALF + 0.5) return 0;
    for (const r of this.ramps) if (f >= r.i0 && f <= r.i1) return (r.h * (f - r.i0)) / (r.i1 - r.i0);
    return 0;
  }

  /** 점프대 위나 막 떠난 직후라면 그 점프대의 발사 속도 상한 (아니면 null) */
  launchCapAt(f, lateral) {
    if (Math.abs(lateral) > ROAD_HALF + 0.5) return null;
    for (const r of this.ramps) if (f >= r.i0 && f <= r.i1 + 5) return r.cap;
    return null;
  }

  /** 대점프대 앞 부스터 발판 위인가 */
  boostPadAt(f, lateral) {
    if (Math.abs(lateral) > ROAD_HALF) return false;
    return this.ramps.some((r) => r.mega && f >= r.i0 - r.pad && f < r.i0);
  }

  /** index 근처(앞뒤 range 샘플)의 스턴트 구간 */
  stuntNear(index, range = 30) {
    return this.stunts.find((st) => Math.abs(index - st.i) < range) || null;
  }

  /** 지면 경사 (도로 + 점프대 오르막), 트랙 진행 방향 기준 dh/ds */
  groundSlopeAt(f, lateral) {
    let k = this.slopeAt(f);
    if (Math.abs(lateral) <= ROAD_HALF + 0.5) {
      for (const r of this.ramps) if (f >= r.i0 && f <= r.i1) k += r.h / ((r.i1 - r.i0) * this.spacing);
    }
    return k;
  }

  /** 카트가 닿는 지면 높이 (도로 + 점프대) */
  groundAt(f, lateral) { return this.heightAt(f) + this.bankAt(f) * lateral + this.rampAt(f, lateral); }

  /** 트랙 중심선까지 대략적인 거리와 가장 가까운 샘플 */
  nearest(x, z) {
    let best = Infinity, bi = 0;
    for (let k = 0; k < this.coarse.length; k++) {
      const p = this.coarse[k];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) { best = d; bi = k * 6; }
    }
    return { d: Math.sqrt(best), i: bi };
  }

  distTo(x, z) { return this.nearest(x, z).d; }

  /** 지면 높이: 트랙 근처는 도로 높이에 맞추고(고가도로 아래는 평지), 멀어질수록 구역별 언덕 */
  groundHeight(x, z, near = this.nearest(x, z), w = zoneWeights(x, z)) {
    const base = this.bridge[near.i] ? 0 : this.height[near.i] - 0.3 - Math.abs(this.bank[near.i]) * WALL_DIST;
    const amp = blendValue(w, 'hill');
    const n = (Math.sin(x * 0.012 + 1.1) * Math.cos(z * 0.010 + 0.4) + 0.6 * Math.sin((x * 0.7 + z) * 0.021) + 1.6) / 3.2;
    const t = smoothstep(WALL_DIST + 2, 110, near.d);
    return base * (1 - t) + amp * Math.max(0, n) * t;
  }

  zoneAt(index) { return ZONES[this.zone[index]]; }

  /** 출발 그리드 위치 (slot 0 = 폴포지션) */
  gridSlot(slot) {
    // 3대씩 나란히, 가운데 줄은 살짝 뒤 (6명 = 2줄)
    const row = Math.floor(slot / 3), col = slot % 3;
    const back = 10 + row * 10 + (col === 1 ? 2.5 : 0);
    const i = ((Math.round(-back / this.spacing) % this.N) + this.N) % this.N;
    const p = this.points[i], s = this.sides[i], t = this.tangents[i];
    const lat = (col - 1) * 5.5;
    return { x: p.x + s.x * lat, z: p.z + s.z * lat, heading: Math.atan2(t.x, t.z) };
  }

  /** 아이템 박스 위치: 약 380m 간격으로 한 줄에 6개 (6명 기준) */
  itemBoxPositions() {
    const out = [];
    const step = Math.round(380 / this.spacing);
    const clear = Math.round(45 / this.spacing);
    for (let i = Math.round(180 / this.spacing); i < this.N - Math.round(120 / this.spacing); i += step) {
      // 점프대 앞뒤 45m 는 피해서 뒤로 밀기
      let j = i;
      while (this.ramps.some((r) => j > r.i0 - clear && j < r.i1 + clear) || this.stunts.some((st) => j > st.a && j < st.b)) j += clear;
      const p = this.points[j], s = this.sides[j];
      for (const lat of [-8.3, -5, -1.7, 1.7, 5, 8.3]) out.push({ x: p.x + s.x * lat, z: p.z + s.z * lat, y: this.height[j] + this.bank[j] * lat, index: j });
    }
    return out;
  }

  /** 중심선 기준 off0~off1 오프셋의 띠 모양 지오메트리 (샘플별 색 지정 가능) */
  ribbon(off0, off1, y0, y1, vTile, colorKey, i0 = 0, i1 = this.N, color = null) {
    const N = this.N;
    const tiles = Math.max(1, Math.round(this.length / vTile)); // 이음매가 안 보이게 정수 반복
    const pos = [], uv = [], idx = [], col = [];
    const c = new THREE.Color();
    for (let i = i0; i <= i1; i++) {
      const k = ((i % N) + N) % N;
      const p = this.points[k], s = this.sides[k], h = this.height[k], bk = this.bank[k];
      const v = (i / N) * tiles;
      pos.push(p.x + s.x * off0, h + bk * off0 + y0, p.z + s.z * off0, p.x + s.x * off1, h + bk * off1 + y1, p.z + s.z * off1);
      uv.push(0, v, 1, v);
      if (colorKey || color) {
        if (color) c.set(color); else blendColor(this.zoneW[k], colorKey, c);
        if (this.tunnel[k]) c.multiplyScalar(0.55); // 동굴 안은 어둡게
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      if (i < i1) {
        const a = (i - i0) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (colorKey || color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  build(renderer) {
    const rand = this.rand;
    const add = (geo, mat, { cast = false, receive = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast; m.receiveShadow = receive;
      this.group.add(m);
      return m;
    };

    this.buildGround(renderer);

    // 아스팔트 도로 (구역별 색조)
    const roadTex = canvasTexture(256, 512, (ctx, w, h) => {
      ctx.fillStyle = '#4a4d53'; ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 9000, ['#42454b', '#53565c', '#3d4045', '#5a5d62'], rand);
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(6, 0, 6, h); ctx.fillRect(w - 12, 0, 6, h);
      ctx.fillRect(w / 2 - 3, 0, 6, h / 2);
    }, renderer);
    const flat = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    add(this.ribbon(-ROAD_HALF, ROAD_HALF, 0.02, 0.02, 18, 'road'),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.8, vertexColors: true, ...flat }));

    // 연석 (빨강/흰색)
    const curbTex = canvasTexture(16, 64, (ctx, w, h) => {
      ctx.fillStyle = '#d62828'; ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, h / 2, w, h / 2);
    }, renderer);
    const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.7, ...flat });
    add(this.ribbon(ROAD_HALF, ROAD_HALF + CURB_W, 0.04, 0.04, 4), curbMat);
    add(this.ribbon(-ROAD_HALF - CURB_W, -ROAD_HALF, 0.04, 0.04, 4), curbMat);

    // 연석 바깥 런오프 구역 (숲: 흙 / 빙하: 눈 / 사막: 모래 / 도시: 보도)
    const runoffMat = new THREE.MeshStandardMaterial({ roughness: 1, vertexColors: true, ...flat, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    add(this.ribbon(ROAD_HALF + CURB_W, WALL_DIST - 0.3, 0.01, 0.01, 10, 'runoff'), runoffMat);
    add(this.ribbon(-WALL_DIST + 0.3, -ROAD_HALF - CURB_W, 0.01, 0.01, 10, 'runoff'), runoffMat);

    // 방호벽 (구역별 색)
    const wallTex = canvasTexture(128, 32, (ctx, w, h) => {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9a9a9a'; ctx.fillRect(0, 0, w / 2, h);
      ctx.fillStyle = '#333'; ctx.fillRect(0, h - 5, w, 5);
    }, renderer);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.6, side: THREE.DoubleSide, vertexColors: true });
    add(this.ribbon(WALL_DIST, WALL_DIST, -5.5, 1.2, 6, 'wall'), wallMat, { cast: true });
    add(this.ribbon(-WALL_DIST, -WALL_DIST, -5.5, 1.2, 6, 'wall'), wallMat, { cast: true });

    // 출발선 + 구역 경계 게이트
    this.buildGate(0, 'START · FINISH', '#e63946', 0x2b2d42, renderer, true);
    for (const st of this.stunts) {
      const at = Math.round(st.i - (st.kind === 'jump' ? 95 : 70) / this.spacing);
      if (st.kind === 'jump') this.buildGate(at, '대점프  BIG JUMP ▲', '#ff7b00', 0x3a2a10, renderer, false);
      else this.buildGate(at, '⚠ 낭떠러지  CLIFF', '#d62828', 0x2b2d42, renderer, false);
    }
    for (let i = 1; i < this.N; i++) {
      if (this.zone[i] !== this.zone[i - 1]) {
        const zn = ZONES[this.zone[i]];
        this.buildGate(i, `${zn.name}  ${zn.label}`, '#' + new THREE.Color(zn.gate).getHexString(), zn.gate, renderer, false);
      }
    }
    this.buildViaduct();
    this.buildTunnel();
    this.buildRamps(renderer);
    this.buildScenery();
  }

  buildGround(renderer) {
    const rand = this.rand;
    const size = this.bounds.getSize(new THREE.Vector3());
    const center = this.bounds.getCenter(new THREE.Vector3());
    const W = size.x + 1600, H = size.z + 1600;
    const geo = new THREE.PlaneGeometry(W, H, 230, 230);
    geo.rotateX(-Math.PI / 2);
    geo.translate(center.x, 0, center.z);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const w = ZONES.map(() => 0);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      zoneWeights(x, z, w);
      pos.setY(i, this.groundHeight(x, z, this.nearest(x, z), w));
      blendColor(w, 'ground', c).multiplyScalar(0.93 + rand() * 0.1);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = canvasTexture(256, 256, (ctx, w2, h2) => {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w2, h2);
      noise(ctx, w2, h2, 7000, ['#e6e6e6', '#f2f2f2', '#d9d9d9', '#ededed'], rand);
    }, renderer);
    tex.repeat.set(W / 12, H / 12);
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1 }));
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  /** [i0, i1] 구간 목록 (플래그 배열에서 연속 구간 추출) */
  spans(flags) {
    const out = [];
    let s0 = -1;
    for (let i = 0; i <= this.N; i++) {
      const on = i < this.N && flags[i];
      if (on && s0 < 0) s0 = i;
      if (!on && s0 >= 0) { out.push([s0, i - 1]); s0 = -1; }
    }
    return out;
  }

  /** 도시 고가도로: 상판 밑면·옆면 + 기둥 */
  buildViaduct() {
    const W = WALL_DIST + 2;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.9, side: THREE.DoubleSide });
    const add = (g) => { const m = new THREE.Mesh(g, concrete); m.castShadow = m.receiveShadow = true; this.group.add(m); };
    const pillars = [];
    for (const [a, b] of this.spans(this.bridge)) {
      add(this.ribbon(-W, W, -1.3, -1.3, 10, null, a, b));                       // 밑면
      add(this.ribbon(WALL_DIST, W, 0.01, 0.01, 10, null, a, b));                 // 벽 바깥 상판
      add(this.ribbon(-W, -WALL_DIST, 0.01, 0.01, 10, null, a, b));
      add(this.ribbon(W, W, -1.3, 0.05, 10, null, a, b));                          // 옆면
      add(this.ribbon(-W, -W, -1.3, 0.05, 10, null, a, b));
      for (let i = a + 4; i < b - 2; i += Math.round(24 / this.spacing)) {
        const p = this.points[i], s = this.sides[i];
        for (const lat of [-8, 8]) pillars.push([p.x + s.x * lat, p.z + s.z * lat, this.height[i] - 1.3]);
      }
    }
    if (!pillars.length) return;
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.1, 1.3, 1, 10).translate(0, 0.5, 0), concrete, pillars.length);
    const d = new THREE.Object3D();
    pillars.forEach(([x, z, top], n) => {
      d.position.set(x, -0.5, z);
      d.scale.set(1, top + 0.5, 1);
      d.updateMatrix();
      im.setMatrixAt(n, d.matrix);
    });
    im.castShadow = im.receiveShadow = true;
    this.group.add(im);
  }

  /** 빙하 얼음 동굴: 울퉁불퉁한 아치 + 고드름 + 빛나는 얼음 결정 */
  buildTunnel() {
    const rand = mulberry32(77);
    const SEG = 18, W = WALL_DIST + 1.6, H = 13;
    for (const [a0, b0] of this.spans(this.tunnel)) {
      const a = a0 - 3, b = b0 + 3;
      const pos = [], col = [], idx = [];
      const c = new THREE.Color();
      let rows = 0;
      for (let i = a; i <= b; i += 2) {
        const p = this.points[i], s = this.sides[i], y0 = this.height[i];
        // 입구/출구는 조금 더 크게 벌어지게
        const flare = 1 + 0.12 * Math.max(smoothstep(a + 12, a, i), smoothstep(b - 12, b, i));
        for (let k = 0; k <= SEG; k++) {
          const ang = (Math.PI * k) / SEG;
          const n = (1 + 0.07 * Math.sin(i * 0.37 + k * 1.7) + 0.05 * (rand() - 0.5)) * flare;
          const lat = Math.cos(ang) * W * n;
          const up = Math.sin(ang) * H * n;
          pos.push(p.x + s.x * lat, y0 - 1.5 + up + (k === 0 || k === SEG ? 0 : 1.5), p.z + s.z * lat);
          c.setHSL(0.53 + 0.03 * rand(), 0.6, 0.62 + 0.25 * Math.sin(ang) * rand());
          col.push(c.r, c.g, c.b);
        }
        if (rows > 0) {
          const r0 = (rows - 1) * (SEG + 1), r1 = rows * (SEG + 1);
          for (let k = 0; k < SEG; k++) idx.push(r0 + k, r1 + k, r0 + k + 1, r0 + k + 1, r1 + k, r1 + k + 1);
        }
        rows++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const shell = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.2, metalness: 0.05, flatShading: true, side: THREE.DoubleSide,
        emissive: 0x16465e, emissiveIntensity: 0.55,
      }));
      shell.castShadow = shell.receiveShadow = true;
      this.group.add(shell);

      // 고드름 (천장) + 빛나는 결정 (벽 아래쪽)
      const icicles = [], crystals = [];
      for (let i = a + 4; i < b - 4; i += 3) {
        const p = this.points[i], s = this.sides[i], y0 = this.height[i];
        const ang = Math.PI * (0.3 + 0.4 * rand());
        icicles.push([p.x + s.x * Math.cos(ang) * W * 0.95, y0 + Math.sin(ang) * H * 0.95 - 1.2, p.z + s.z * Math.cos(ang) * W * 0.95, 0.6 + rand()]);
        if (rand() < 0.5) {
          const side = rand() < 0.5 ? -1 : 1;
          crystals.push([p.x + s.x * side * (WALL_DIST + 0.6), y0 + 0.6 + rand() * 1.5, p.z + s.z * side * (WALL_DIST + 0.6), 0.5 + rand() * 0.8]);
        }
      }
      const place = (geo, mat, list, rotX) => {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const d = new THREE.Object3D();
        list.forEach(([x, y, z, sc], n) => {
          d.position.set(x, y, z); d.rotation.set(rotX, rand() * 6, 0); d.scale.setScalar(sc); d.updateMatrix();
          im.setMatrixAt(n, d.matrix);
        });
        this.group.add(im);
      };
      place(new THREE.ConeGeometry(0.45, 2.8, 5), new THREE.MeshStandardMaterial({ color: 0xbff3ff, emissive: 0x3fb8e8, emissiveIntensity: 0.6, roughness: 0.1 }), icicles, Math.PI);
      place(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x4fe0ff, emissiveIntensity: 1.6, roughness: 0.1 }), crystals, 0);
    }
  }

  /** 점프대: 노란·검은 줄무늬 쐐기 */
  buildRamps(renderer) {
    const tex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#ffcc00'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1c1c24';
      for (let k = -2; k < 6; k++) {
        ctx.beginPath();
        ctx.moveTo(0, k * 32); ctx.lineTo(w / 2, k * 32 - 28); ctx.lineTo(w, k * 32);
        ctx.lineTo(w, k * 32 + 14); ctx.lineTo(w / 2, k * 32 - 14); ctx.lineTo(0, k * 32 + 14);
        ctx.fill();
      }
    }, renderer);
    const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3a46, roughness: 0.8, side: THREE.DoubleSide });
    for (const r of this.ramps) {
      const top = [], side = [], uv = [];
      for (let i = r.i0; i <= r.i1; i++) {
        const p = this.points[i], s = this.sides[i];
        const y = this.height[i] + 0.03 + (r.h * (i - r.i0)) / (r.i1 - r.i0);
        const yb = this.height[i] + 0.02;
        const v = (i - r.i0) / (r.i1 - r.i0);
        top.push([p.x - s.x * ROAD_HALF, y, p.z - s.z * ROAD_HALF], [p.x + s.x * ROAD_HALF, y, p.z + s.z * ROAD_HALF]);
        side.push([p.x - s.x * ROAD_HALF, yb, p.z - s.z * ROAD_HALF], [p.x + s.x * ROAD_HALF, yb, p.z + s.z * ROAD_HALF]);
        uv.push([0, v], [1, v]);
      }
      const n = top.length / 2;
      // 윗면
      const gTop = new THREE.BufferGeometry();
      gTop.setAttribute('position', new THREE.Float32BufferAttribute(top.flat(), 3));
      gTop.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
      const it = [];
      for (let k = 0; k < n - 1; k++) { const a = k * 2; it.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      gTop.setIndex(it);
      gTop.computeVertexNormals();
      const mTop = new THREE.Mesh(gTop, topMat);
      mTop.castShadow = mTop.receiveShadow = true;
      this.group.add(mTop);
      // 옆면 2개 + 끝면
      const sp = [], si = [];
      const quad = (a, b, c, d) => { const o = sp.length / 3; sp.push(...a, ...b, ...c, ...d); si.push(o, o + 1, o + 2, o + 2, o + 1, o + 3); };
      for (let k = 0; k < n - 1; k++) for (const e of [0, 1]) quad(side[k * 2 + e], side[k * 2 + 2 + e], top[k * 2 + e], top[k * 2 + 2 + e]);
      quad(side[(n - 1) * 2], side[(n - 1) * 2 + 1], top[(n - 1) * 2], top[(n - 1) * 2 + 1]);
      const gSide = new THREE.BufferGeometry();
      gSide.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      gSide.setIndex(si);
      gSide.computeVertexNormals();
      this.group.add(new THREE.Mesh(gSide, sideMat));
    }
    this.buildBoostPads(renderer);
  }

  /** 부스터 발판: 도로 위에 빛나는 화살표 띠 */
  buildBoostPads(renderer) {
    const tex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#0b3d91'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#5ff2ff';
      for (let k = 0; k < 2; k++) {
        const y = k * 64 + 52;
        ctx.beginPath();
        ctx.moveTo(10, y); ctx.lineTo(w / 2, y - 40); ctx.lineTo(w - 10, y);
        ctx.lineTo(w - 10, y + 12); ctx.lineTo(w / 2, y - 26); ctx.lineTo(10, y + 12);
        ctx.fill();
      }
    }, renderer);
    tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0x2aa8ff, emissiveIntensity: 0.6, emissiveMap: tex, roughness: 0.4, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (const r of this.ramps) if (r.mega) this.group.add(this.roadDecal(r.i0 - r.pad, r.i0, ROAD_HALF - 2, 6, mat));
    // 낭떠러지 가장자리: 빨강·흰색 경고 줄무늬
    const lip = canvasTexture(128, 32, (ctx, w, h) => {
      for (let k = 0; k < 8; k++) { ctx.fillStyle = k % 2 ? '#ffffff' : '#e63946'; ctx.fillRect((k * w) / 8, 0, w / 8 + 1, h); }
    }, renderer);
    const lipMat = new THREE.MeshStandardMaterial({ map: lip, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (const st of this.stunts) if (st.kind === 'cliff') this.group.add(this.roadDecal(st.i - Math.round(3 / this.spacing), st.i, ROAD_HALF, 1000, lipMat));
  }

  /** 도로 위에 얇게 붙는 띠 (i0~i1 구간, 폭 ±half, vTile m 마다 텍스처 반복) */
  roadDecal(i0, i1, half, vTile, mat) {
    const pos = [], uv = [], idx = [];
    for (let i = i0, k = 0; i <= i1; i++, k++) {
      const p = this.points[i], s = this.sides[i], h = this.height[i], bk = this.bank[i];
      const v = ((i - i0) * this.spacing) / vTile;
      pos.push(p.x - s.x * half, h - bk * half + 0.05, p.z - s.z * half, p.x + s.x * half, h + bk * half + 0.05, p.z + s.z * half);
      uv.push(0, v, 1, v);
      if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  buildGate(index, text, color, postColor, renderer, checker) {
    const p = this.points[index], t = this.tangents[index];
    const g = new THREE.Group();
    g.position.set(p.x, this.height[index], p.z);
    g.rotation.y = Math.atan2(t.x, t.z); // 로컬 +Z = 진행 방향
    this.group.add(g);

    if (checker) {
      const tex = canvasTexture(256, 32, (ctx, w) => {
        const n = 16, sz = w / n;
        for (let y = 0; y < 2; y++) for (let x = 0; x < n; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#111' : '#fff';
          ctx.fillRect(x * sz, y * sz, sz, sz);
        }
      }, renderer);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 2.2),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      line.rotation.x = -Math.PI / 2;
      line.position.y = 0.03;
      line.receiveShadow = true;
      g.add(line);
    }

    const postMat = new THREE.MeshStandardMaterial({ color: postColor, roughness: 0.5 });
    const span = ROAD_HALF + CURB_W + 1.5;
    for (const x of [-span, span]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, 8, 0.9), postMat);
      post.position.set(x, 4, 0);
      post.castShadow = true;
      g.add(post);
    }
    const banner = canvasTexture(1024, 128, (ctx, w, h) => {
      ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 80px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + 4);
    }, renderer);
    const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.6 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.9, 1.9, 0.6), [postMat, postMat, postMat, postMat, bannerMat, bannerMat]);
    beam.position.y = 7.4;
    beam.castShadow = true;
    g.add(beam);
  }

  buildScenery() {
    const rand = this.rand;
    const proto = buildPrototypes();
    const lists = {};
    for (const k of Object.keys(proto)) lists[k] = [];
    const buildings = { low: [], mid: [], tall: [] };
    const occupied = new Set(); // 건물 겹침 방지 (24m 격자)
    const brickSpots = [];
    const w = ZONES.map(() => 0);
    const pick = (arr) => { let r = rand(), acc = 0; for (const [k, p] of arr) { acc += p; if (r < acc) return k; } return null; };
    let snowmen = 0;

    // 트랙을 따라 양옆에 흩뿌리기 → 구역에 맞는 오브젝트 선택
    for (let k = 0; k < 22000; k++) {
      const i = Math.floor(rand() * this.N);
      const p = this.points[i], s = this.sides[i], t = this.tangents[i];
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (WALL_DIST + 5 + rand() ** 1.7 * 300);
      const along = (rand() - 0.5) * 30;
      const x = p.x + s.x * lat + t.x * along, z = p.z + s.z * lat + t.z * along;
      const near = this.nearest(x, z);
      const d = near.d;
      if (d < WALL_DIST + 5) continue;
      if ((this.tunnel[near.i] || this.bridge[near.i]) && d < WALL_DIST + 12) continue; // 동굴 벽·고가 상판과 겹치지 않게
      if (rand() > Math.exp(-(d - 25) / 170)) continue; // 트랙에서 멀수록 드문드문
      zoneWeights(x, z, w);
      // 경계에선 가중치대로 섞어서 자연스럽게
      let r = rand(), zi = 0;
      for (; zi < ZONES.length - 1 && r > w[zi]; zi++) r -= w[zi];
      const zone = ZONES[zi].id;
      let type;
      if (zone === 'forest') type = pick([['pine', 0.42], ['roundTree', 0.3], ['bush', 0.18], ['rock', 0.06], ['mushroom', 0.04]]);
      else if (zone === 'glacier') type = pick([['snowyPine', 0.5], ['iceberg', 0.25], ['iceSpike', 0.22], ['snowman', 0.03]]);
      else if (zone === 'desert') {
        type = pick([['cactus', 0.38], ['desertRock', 0.32], ['palm', 0.12], ['mesa', 0.18]]);
        if (type === 'mesa' && (d < 110 || w[2] < 0.9)) type = 'desertRock'; // 큰 절벽은 사막 한가운데에만
        if (type === 'palm' && d > 90) type = 'cactus';
      } else if (zone === 'block') {
        // 블록 세상: 벽돌 탑·더미는 따로 쌓고, 블록 나무
        if (rand() < 0.45) { brickSpots.push({ x, z, y: this.groundHeight(x, z, near, w), d, pile: rand() < 0.25 }); continue; }
        type = 'brickTree';
      } else {
        // 도시: 건물 위주 + 가로수
        if (d < 150 && rand() < 0.75) {
          const bw = 12 + rand() * 12, bd = 12 + rand() * 12;
          if (d - Math.hypot(bw, bd) / 2 < WALL_DIST + (this.bridge[near.i] ? 28 : 6)) continue; // 고가도로 옆은 탁 트이게
          const key = `${Math.round(x / 24)},${Math.round(z / 24)}`;
          if (occupied.has(key)) continue;
          occupied.add(key);
          const kind = d < 55 ? (rand() < 0.6 ? 'low' : 'mid') : rand() < 0.5 ? 'mid' : 'tall';
          const h = kind === 'low' ? 12 + rand() * 12 : kind === 'mid' ? 26 + rand() * 22 : 55 + rand() * 45;
          buildings[kind].push({ x, z, sx: bw, sy: h, sz: bd, ry: Math.atan2(t.x, t.z), color: new THREE.Color().setHSL(rand(), 0.25, 0.55 + rand() * 0.25) });
          continue;
        }
        type = pick([['roundTree', 0.5], ['bush', 0.5]]);
      }
      if (!type) continue;
      if (type === 'snowman' && snowmen++ > 14) continue;
      const y = this.groundHeight(x, z, near, w);
      let scale = 0.7 + rand() * 0.8;
      let sx = scale, sy = scale, sz = scale;
      if (type === 'mesa') { sx = sz = 35 + rand() * 50; sy = 25 + rand() * 40; }
      if (type === 'iceberg') { scale = 1 + rand() * 2.5; sx = sy = sz = scale; }
      lists[type].push({ x, y: y - 0.2, z, sx, sy, sz, ry: rand() * Math.PI * 2, near: d < 70 });
    }

    // 도시 가로등 (벽 바깥, 도로를 바라보게)
    for (let i = 0; i < this.N; i += Math.round(36 / this.spacing)) {
      if (ZONES[this.zone[i]].id !== 'city') continue;
      const p = this.points[i], s = this.sides[i];
      for (const side of [-1, 1]) {
        const lat = side * (WALL_DIST + 1.2); // 고가도로 위에선 상판 가장자리에
        lists.lamp.push({ x: p.x + s.x * lat, y: this.height[i] + this.bank[i] * lat, z: p.z + s.z * lat, sx: 1, sy: 1, sz: 1, ry: Math.atan2(-s.x * side, -s.z * side), near: true });
      }
    }

    const dummy = new THREE.Object3D();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
    const iceMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85, flatShading: true,
      emissive: 0x2a6a8a, emissiveIntensity: 0.35,
    });
    // 트랙 가까운 것만 그림자를 드리워서 그림자 패스 부담을 줄임
    for (const [type, all] of Object.entries(lists)) {
      for (const near of [true, false]) {
        const items = all.filter((it) => !!it.near === near);
        if (!items.length) continue;
        const im = new THREE.InstancedMesh(proto[type], type === 'iceSpike' ? iceMat : mat, items.length);
        items.forEach((it, n) => {
          dummy.position.set(it.x, it.y, it.z);
          dummy.rotation.set(0, it.ry, 0);
          dummy.scale.set(it.sx, it.sy, it.sz);
          dummy.updateMatrix();
          im.setMatrixAt(n, dummy.matrix);
        });
        im.castShadow = near && type !== 'mesa';
        im.receiveShadow = true;
        this.group.add(im);
      }
    }

    this.buildCity(buildings);
    this.buildBricks(brickSpots);
    this.buildMountains();
  }

  buildCity(buildings) {
    const dummy = new THREE.Object3D();
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x5c606a, roughness: 0.9 });
    const facade = (cols, rows) => {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 256;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 256);
      const cw = 128 / cols, ch = 256 / rows;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const lit = Math.random() < 0.3;
        g.fillStyle = lit ? '#ffe9a8' : '#3c4a63';
        g.fillRect(x * cw + cw * 0.2, y * ch + ch * 0.22, cw * 0.6, ch * 0.56);
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const variants = { low: facade(4, 4), mid: facade(5, 9), tall: facade(6, 20) };
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    for (const [kind, list] of Object.entries(buildings)) {
      if (!list.length) continue;
      const wallMat = new THREE.MeshStandardMaterial({ map: variants[kind], roughness: 0.6, metalness: 0.1 });
      const mats = [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat];
      const im = new THREE.InstancedMesh(box, mats, list.length);
      list.forEach((b, n) => {
        dummy.position.set(b.x, 0, b.z);
        dummy.rotation.set(0, b.ry, 0);
        dummy.scale.set(b.sx, b.sy, b.sz);
        dummy.updateMatrix();
        im.setMatrixAt(n, dummy.matrix);
        im.setColorAt(n, b.color);
      });
      im.castShadow = im.receiveShadow = true;
      this.group.add(im);
    }
  }

  /** 블록 세상: 돌기(스터드)가 달린 장난감 벽돌을 탑이나 더미로 쌓기 */
  buildBricks(spots) {
    if (!spots.length) return;
    const rand = mulberry32(4242);
    // 가까운 벽돌만 돌기(스터드)를 달고, 먼 벽돌은 상자만 (어차피 안 보임 → 삼각형 절약)
    const plain = new THREE.BoxGeometry(4, 1.2, 2).translate(0, 0.6, 0);
    const parts = [plain.clone()];
    for (const sx of [-1.5, -0.5, 0.5, 1.5]) for (const sz of [-0.5, 0.5]) {
      parts.push(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 6, 1, false).translate(sx, 1.35, sz));
    }
    const studded = mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
    const palette = [0xe63946, 0x1d8cf8, 0xffcc00, 0x2fbf71, 0xffffff, 0xff8c1a, 0x9b5de5];
    const near = [], far = [];
    for (const sp of spots) {
      const s = 1.3 + rand() * 1.4;
      const n = sp.pile ? 3 + Math.floor(rand() * 3) : 2 + Math.floor(rand() * (sp.d > 80 ? 6 : 4));
      let y = sp.y - 0.1, rot = Math.floor(rand() * 4) * (Math.PI / 2);
      for (let k = 0; k < n; k++) {
        const b = sp.pile
          ? { x: sp.x + (rand() - 0.5) * 8 * s, y: sp.y - 0.1 + (k > 2 ? 1.2 * s : 0), z: sp.z + (rand() - 0.5) * 8 * s, ry: rand() * Math.PI }
          : { x: sp.x + (rand() - 0.5) * 0.8 * s, y, z: sp.z + (rand() - 0.5) * 0.8 * s, ry: rot };
        b.s = s;
        b.color = palette[Math.floor(rand() * palette.length)];
        (sp.d < 70 ? near : far).push(b);
        y += 1.2 * s;
        rot += Math.PI / 2 * (rand() < 0.5 ? 1 : 0); // 엇갈려 쌓기
      }
    }
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 }); // 반짝이는 플라스틱
    const d = new THREE.Object3D(), c = new THREE.Color();
    for (const [list, cast, geo] of [[near, true, studded], [far, false, plain]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((b, i) => {
        d.position.set(b.x, b.y, b.z); d.rotation.set(0, b.ry, 0); d.scale.setScalar(b.s); d.updateMatrix();
        im.setMatrixAt(i, d.matrix);
        im.setColorAt(i, c.set(b.color));
      });
      im.castShadow = cast;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  buildMountains() {
    const rand = this.rand;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const count = 70;
    const mountains = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), count);
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    const tint = { forest: 0x5f8f5a, glacier: 0xf2f8ff, desert: 0xc97b4a, city: 0x8c86b0, block: 0x7fa6d9 };
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.05;
      const rx = size.x / 2 + 650 + rand() * 250, rz = size.z / 2 + 650 + rand() * 250;
      const x = center.x + Math.cos(a) * rx, z = center.z + Math.sin(a) * rz;
      const h = 120 + rand() * 180;
      dummy.position.set(x, h / 2 - 5, z);
      dummy.scale.set(160 + rand() * 120, h, 160 + rand() * 120);
      dummy.rotation.set(0, rand() * Math.PI, 0);
      dummy.updateMatrix();
      mountains.setMatrixAt(i, dummy.matrix);
      const w = zoneWeights(x, z);
      c.setRGB(0, 0, 0);
      ZONES.forEach((zn, k) => c.add(new THREE.Color(tint[zn.id]).multiplyScalar(w[k])));
      mountains.setColorAt(i, c.multiplyScalar(0.9 + rand() * 0.2));
    }
    this.group.add(mountains);
  }
}
