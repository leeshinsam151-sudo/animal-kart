// 트랙별 함정/방해물
// - 숲: 나무통 슬라럼 / 사막: 모래 늪 / 도시: 교차로를 지나는 버스 / 블록: 블록 성문 + 움직이는 블록 벽
// - (빙하 크레바스는 빼고 대신 큰 높낮이로 — 판정·모양 코드는 남겨둠)
// - 배치는 트랙 모양으로 정해짐(모든 화면에서 같음). 움직이는 것은 공유 시계(서버 시각)로 위치가 정해져서 통신 없이도 동기화
// - 판정은 각자 자기 카트만 (원격 카트는 그 사람 화면이 판정한 결과가 위치/상태로 전달됨)
import * as THREE from 'three';

const ROAD_HALF = 10, WALL_DIST = 18, CAR_R = 1.4;

// ---------------- 배치 ----------------
/** 트랙 구역마다 함정 배치 → track.hazards, track.hazardSpans, track.freeLanes */
export function planHazards(track) {
  const N = track.N, sp = track.spacing, m = (meters) => Math.round(meters / sp);
  const list = [], spans = [];
  const busy = (a, b) => spans.some(([s0, s1]) => b > s0 - m(40) && a < s1 + m(40))
    || track.ramps.some((r) => b > r.i0 - m(70) && a < r.i1 + m(110))
    || track.stunts.some((st) => b > st.a - m(20) && a < st.b + m(20))
    || a < m(140) || b > N - m(110); // 출발선 근처 비움
  // [lo, hi] 안에서 길이 len 구간을 둘 가장 곧고 평평한 곳 (조건 안 맞으면 null)
  const findSpot = (lo, hi, len, { ground = false } = {}) => {
    let best = null, bv = Infinity;
    for (let c = Math.round(lo + len / 2); c <= hi - len / 2; c += 4) {
      const a = c - Math.round(len / 2) - m(20), b = c + Math.round(len / 2) + m(20);
      if (busy(a, b)) continue;
      let bad = false, turn = 0, h0 = Infinity, h1 = -Infinity;
      const t0 = track.tangents[a];
      for (let k = a; k <= b; k += 2) {
        if (track.tunnel[k] || (ground && track.bridge[k])) { bad = true; break; }
        turn = Math.max(turn, Math.acos(Math.min(1, track.tangents[k].dot(t0))));
        h0 = Math.min(h0, track.height[k]); h1 = Math.max(h1, track.height[k]);
      }
      if (bad) continue;
      const v = turn + (h1 - h0) * 0.03 + Math.abs(track.bank[c]) * 3;
      if (v < bv) { bv = v; best = c; }
    }
    return best;
  };
  const place = (zone, lo, hi, count) => {
    const L = hi - lo;
    for (let n = 0; n < count; n++) {
      const a = lo + (L * n) / count, b = lo + (L * (n + 1)) / count;
      if (zone === 'forest') {
        // 나무통 슬라럼: 22m 간격 줄마다 왼쪽/오른쪽이 번갈아 막힘 → 지그재그로 통과
        const len = m(95), c = findSpot(a, b, len);
        if (c == null) continue;
        const L = [-9.2, -6.8, -4.4, -2.0], R = [2.0, 4.4, 6.8, 9.2];
        [L, R, L, R].forEach((lats, k) => { for (const lat of lats) list.push({ kind: 'barrel', i: c - m(33) + k * m(22), lat, r: 1.1 }); });
        spans.push([c - len / 2, c + len / 2]);
      } else if (zone === 'desert') {
        // 모래 늪: 엇갈린 구덩이 4개, 사이로 지나갈 틈은 남김
        const len = m(70), c = findSpot(a, b, len);
        if (c == null) continue;
        for (const [d, lat, r] of [[-24, -5.5, 4.6], [-8, 5, 4.2], [8, -4, 4.4], [24, 5.5, 4.6]]) list.push({ kind: 'sand', i: c + m(d), lat, r });
        spans.push([c - len / 2, c + len / 2]);
      } else if (zone === 'city') {
        // 교차로: 버스 두 대가 서로 반대 방향으로 도로를 가로지름 (타이밍 맞춰 통과)
        const len = m(30), c = findSpot(a, b, len, { ground: true });
        if (c == null) continue;
        list.push({ kind: 'cross', i: c });
        list.push({ kind: 'mover', style: 'bus', i: c - m(4.5), halfAlong: 1.5, halfLat: 5.5, lat0: -30, lat1: 30, period: 7, phase: 0, loop: true, h: 3.2 });
        list.push({ kind: 'mover', style: 'bus', i: c + m(4.5), halfAlong: 1.5, halfLat: 5.5, lat0: 30, lat1: -30, period: 7, phase: 0.5, loop: true, h: 3.2 });
        spans.push([c - len / 2, c + len / 2]);
      } else if (zone === 'block') {
        if (n % 2 === 0) {
          // 블록 성문: 성탑 2개 + 성문 기둥 2개 → 세 갈래 문으로 통과
          const len = m(30), c = findSpot(a, b, len);
          if (c == null) continue;
          list.push({ kind: 'castle', i: c });
          for (const lat of [-4.6, 4.6]) list.push({ kind: 'pillar', i: c, lat, r: 1.5 });
          spans.push([c - len / 2, c + len / 2]);
        } else {
          // 움직이는 블록 벽: 도로 반쪽을 막는 벽돌이 좌우로 오가며 길을 막음
          const len = m(60), c = findSpot(a, b, len);
          if (c == null) continue;
          [-20, 0, 20].forEach((d, k) => list.push({ kind: 'mover', style: 'brick', i: c + m(d), halfAlong: 2, halfLat: 4.6, lat0: -5.2, lat1: 5.2, period: 3.6, phase: k / 3, h: 2.6, color: [0xe63946, 0xffcc00, 0x1d8cf8][k] }));
          spans.push([c - len / 2, c + len / 2]);
        }
      }
    }
  };
  const counts = { forest: 2, desert: 2, city: 1, block: 2 }; // 빙하는 함정 대신 큰 높낮이·급경사 (크레바스 판정·모양 코드는 남겨둠)
  for (const r of track.zoneRuns) if (counts[r.zone]) place(r.zone, r.a, r.b, track.def.theme ? counts[r.zone] : 1);

  // 월드 좌표 미리 계산
  for (const h of list) {
    if (h.lat == null || h.kind === 'mover') continue;
    const p = track.points[h.i], s = track.sides[h.i];
    h.x = p.x + s.x * h.lat; h.z = p.z + s.z * h.lat;
    h.y = track.groundAt(h.i, h.lat);
  }
  for (const h of list) if (h.kind === 'mover') { h.lat = h.lat0; h.vlat = 0; }
  track.hazards = list;
  track.hazardSpans = spans.map(([a, b]) => [Math.floor(a), Math.ceil(b)]);
  track.freeLanes = buildFreeLanes(track, list);
}

/** 봇용: 인덱스별로 지나갈 수 있는 가로 구간 (정적 함정만) */
function buildFreeLanes(track, list) {
  const map = new Map(), sp = track.spacing, lim = ROAD_HALF - 1.6;
  const add = (k, blocked) => { if (!map.has(k)) map.set(k, []); map.get(k).push(...blocked); };
  for (const h of list) {
    if (h.kind === 'barrel' || h.kind === 'pillar' || h.kind === 'sand') {
      const reach = Math.ceil((h.r + 4) / sp);
      for (let k = h.i - reach; k <= h.i + reach; k++) add(k, [[h.lat - h.r - CAR_R - 0.6, h.lat + h.r + CAR_R + 0.6]]);
    } else if (h.kind === 'crevasse') {
      // 다리 밖은 전부 막힘
      const edges = [-WALL_DIST, ...h.bridges.flatMap(([a, b]) => [a + 0.9, b - 0.9]), WALL_DIST];
      const blocked = [];
      for (let k = 0; k < edges.length; k += 2) blocked.push([edges[k], edges[k + 1]]);
      for (let k = h.i0 - Math.round(6 / sp); k <= h.i1; k++) add(k, blocked);
    }
  }
  // 막힌 구간의 여집합 → 지나갈 수 있는 구간
  const free = new Map();
  for (const [k, blocked] of map) {
    blocked.sort((a, b) => a[0] - b[0]);
    const out = [];
    let x = -lim;
    for (const [a, b] of blocked) { if (a > x) out.push([x, Math.min(a, lim)]); x = Math.max(x, b); }
    if (x < lim) out.push([x, lim]);
    free.set(k, out.filter(([a, b]) => b - a > 0.3));
  }
  return free;
}

/**
 * 봇이 앞으로 지나갈 함정을 보고 고른 목표: { lane, k } (k = 그 차선을 노릴 트랙 인덱스). 함정이 없으면 null
 * - 가장 가까운 막힌 줄의 빈틈 중 지금 차선에서 가까운 곳 (좁으면 가운데)
 */
export function safeLane(track, index, lane) {
  if (!track.freeLanes?.size) return null;
  for (let k = index + 2; k <= index + 45; k += 2) {
    const f = track.freeLanes.get(k % track.N);
    if (!f) continue;
    if (!f.length) return null;
    // 막힌 줄의 한가운데(빈틈이 가장 좁은 곳)를 노림
    let kk = k;
    while (track.freeLanes.has((kk + 1) % track.N) && kk < k + 10) kk++;
    const row = Math.round((k + kk) / 2);
    let best = null, bd = Infinity;
    for (const [a, b] of track.freeLanes.get(row % track.N) || f) {
      const target = b - a < 3 ? (a + b) / 2 : Math.max(a + 1, Math.min(b - 1, lane));
      const d = Math.abs(target - lane);
      if (d < bd) { bd = d; best = target; }
    }
    return best == null ? null : { lane: best, k: row };
  }
  return null;
}

// ---------------- 움직임 ----------------
/** 공유 시계 t(초)에 맞춰 움직이는 장애물 위치 갱신 (판정과 화면이 같은 값을 씀) */
export function updateHazards(track, t) {
  for (const h of track.hazards) {
    if (h.kind !== 'mover') continue;
    const u = t / h.period + h.phase;
    const prev = h.lat;
    if (h.loop) h.lat = h.lat0 + (h.lat1 - h.lat0) * (u - Math.floor(u));          // 한쪽으로 가로질러 감
    else h.lat = h.lat0 + (h.lat1 - h.lat0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * u)); // 왔다 갔다
    const dl = (h.lat1 - h.lat0) / h.period;
    h.vlat = h.loop ? dl : (h.lat1 - h.lat0) * Math.PI / h.period * Math.sin(2 * Math.PI * u);
    if (h.mesh) {
      const p = track.points[h.i], s = track.sides[h.i];
      h.mesh.position.set(p.x + s.x * h.lat, track.height[h.i] + track.bank[h.i] * Math.max(-ROAD_HALF, Math.min(ROAD_HALF, h.lat)), p.z + s.z * h.lat);
      h.mesh.visible = Math.abs(h.lat) < WALL_DIST + 12; // 화면 밖에서 반대편으로 돌아갈 땐 숨김
    }
    if (Math.abs(h.lat - prev) > 20) h.vlat = 0;
  }
  for (const d of track.sandDiscs || []) d.rotation.z = t * 0.9;
}

// ---------------- 판정 (내 카트 / 연습 봇) ----------------
/**
 * 함정 효과 적용. 일어난 일: 'hit'(부딪힘) | 'sand'(모래 늪 진입) | 'fall'(크레바스) | null
 */
export function applyHazards(c, track, dt) {
  if (!track.hazards?.length || c.fallTime > 0) return null;
  const loc = track.locate(c.x, c.z, c.hint);
  const N = track.N, sp = track.spacing;
  let event = null, inSand = false;
  for (const h of track.hazards) {
    if (h.kind === 'barrel' || h.kind === 'pillar') {
      if (Math.abs(h.x - c.x) > 4 || Math.abs(h.z - c.z) > 4) continue;
      // 정지한 원기둥: 카트끼리 충돌과 같은 방식으로 튕김 (r 차이만큼 보정)
      const d = Math.hypot(c.x - h.x, c.z - h.z), min = h.r + CAR_R;
      if (d >= min || d < 1e-4 || c.y > h.y + (h.kind === 'pillar' ? 9 : 2.0)) continue;
      const nx = (c.x - h.x) / d, nz = (c.z - h.z) / d;
      c.x += nx * (min - d); c.z += nz * (min - d);
      const rel = c.vx * nx + c.vz * nz;
      if (rel < 0) {
        c.vx -= nx * rel * 1.5; c.vz -= nz * rel * 1.5; // 반사 (반발 0.5)
        c.vx *= 0.8; c.vz *= 0.8;
        c.impact = Math.min(1, c.impact - rel / 20);
        if (-rel > 4) event = 'hit';
      }
    } else if (h.kind === 'sand') {
      if (Math.hypot(c.x - h.x, c.z - h.z) < h.r && !c.air) {
        inSand = true;
        // 가운데로 빨려 들어가며 크게 감속 (부스터면 빠져나올 수 있음)
        const dx = h.x - c.x, dz = h.z - c.z, dl = Math.hypot(dx, dz) || 1;
        c.vx += (dx / dl) * 7 * dt; c.vz += (dz / dl) * 7 * dt;
        const damp = Math.exp(-(c.boosting ? 0.6 : 2.6) * dt);
        c.vx *= damp; c.vz *= damp;
      }
    } else if (h.kind === 'crevasse') {
      if (loc.index < h.i0 || loc.index > h.i1 || c.air) continue;
      const safe = h.bridges.some(([a, b]) => loc.lateral > a - 0.8 && loc.lateral < b + 0.8);
      if (!safe && c.fall?.(h.back, h.backLat)) return 'fall';
    } else if (h.kind === 'mover') {
      let along = (loc.f - h.i) * sp;
      if (along > (N * sp) / 2) along -= N * sp; else if (along < -(N * sp) / 2) along += N * sp;
      const dl = loc.lateral - h.lat;
      const pa = h.halfAlong + CAR_R - Math.abs(along), pl = h.halfLat + CAR_R - Math.abs(dl);
      if (pa <= 0 || pl <= 0 || c.y > track.height[h.i] + h.h) continue;
      const t = track.tangents[h.i], s = track.sides[h.i];
      if (pa < pl) {
        // 앞/뒤로 밀어냄 + 진행 방향 속도 반사
        const sg = Math.sign(along) || -1;
        c.x += t.x * sg * pa; c.z += t.z * sg * pa;
        const vt = c.vx * t.x + c.vz * t.z;
        if (vt * sg < 0) { c.vx -= t.x * vt * 1.5; c.vz -= t.z * vt * 1.5; if (Math.abs(vt) > 4) event = 'hit'; }
        c.impact = Math.min(1, c.impact + Math.abs(vt) / 25);
      } else {
        // 옆으로 밀려남 (움직이는 벽에 떠밀림)
        const sg = Math.sign(dl) || 1;
        c.x += s.x * sg * pl; c.z += s.z * sg * pl;
        const vs = c.vx * s.x + c.vz * s.z, want = h.vlat + sg * 6;
        if ((want - vs) * sg > 0) { c.vx += s.x * (want - vs); c.vz += s.z * (want - vs); event = 'hit'; }
      }
    }
  }
  if (inSand && !c.inSand) event = event || 'sand';
  c.inSand = inSand;
  c.sink = Math.max(0, Math.min(0.75, (c.sink || 0) + (inSand ? dt * 1.4 : -dt * 3)));
  return event;
}

// ---------------- 모양 ----------------
function tex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 도로를 따라 붙는 띠 (lat0~lat1, i0~i1) */
function strip(track, i0, i1, lat0, lat1, lift = 0.07) {
  const pos = [], uv = [], idx = [];
  for (let i = i0, k = 0; i <= i1; i++, k++) {
    const p = track.points[i], s = track.sides[i];
    for (const [lat, u] of [[lat0, 0], [lat1, 1]]) pos.push(p.x + s.x * lat, track.groundAt(i, Math.max(-ROAD_HALF, Math.min(ROAD_HALF, lat))) + lift, p.z + s.z * lat), uv.push(u, k / (i1 - i0));
    if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const lift = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };

export function buildHazardMeshes(track, group) {
  const hs = track.hazards;
  const yaw = (i) => Math.atan2(track.tangents[i].x, track.tangents[i].z);

  // 나무통
  const barrels = hs.filter((h) => h.kind === 'barrel');
  if (barrels.length) {
    const t = tex(128, 64, (ctx, w, h) => {
      ctx.fillStyle = '#9b5b2c'; ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 16) { ctx.fillStyle = x % 32 ? '#a8673a' : '#8a4f25'; ctx.fillRect(x, 0, 14, h); }
      ctx.fillStyle = '#3b3b40'; ctx.fillRect(0, 8, w, 6); ctx.fillRect(0, h - 14, w, 6);
    });
    const geo = new THREE.CylinderGeometry(1.15, 1.15, 2.2, 14).translate(0, 1.1, 0);
    const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }), barrels.length);
    const d = new THREE.Object3D();
    barrels.forEach((h, k) => { d.position.set(h.x, h.y - 0.05, h.z); d.rotation.set(0, k * 1.7, 0); d.updateMatrix(); im.setMatrixAt(k, d.matrix); });
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  }

  // 모래 늪: 소용돌이 원판 (천천히 돎)
  track.sandDiscs = [];
  const sands = hs.filter((h) => h.kind === 'sand');
  if (sands.length) {
    const t = tex(256, 256, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
      g.addColorStop(0, '#6b4a22'); g.addColorStop(0.55, '#a77b3f'); g.addColorStop(0.92, '#d9b26a'); g.addColorStop(1, 'rgba(217,178,106,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(70,45,15,0.55)'; ctx.lineWidth = 5;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 3; a += 0.1) { const r = 8 + a * 12; ctx.lineTo(w / 2 + Math.cos(a + k * Math.PI / 2) * r, h / 2 + Math.sin(a + k * Math.PI / 2) * r); }
        ctx.stroke();
      }
    });
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 1, transparent: true, ...lift });
    for (const h of sands) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(h.r + 0.6, 40), mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(h.x, h.y + 0.06, h.z);
      disc.receiveShadow = true;
      group.add(disc);
      track.sandDiscs.push(disc);
    }
  }

  // 크레바스: 다리 밖은 깊은 틈(짙은 파랑), 다리 가장자리엔 얼음 덩어리
  const crevs = hs.filter((h) => h.kind === 'crevasse');
  if (crevs.length) {
    const t = tex(64, 64, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#9fd3f2'); g.addColorStop(0.18, '#1d4f7a'); g.addColorStop(0.5, '#061a33'); g.addColorStop(0.82, '#1d4f7a'); g.addColorStop(1, '#9fd3f2');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, ...lift });
    const chunkGeo = new THREE.IcosahedronGeometry(0.55, 0);
    const chunks = [];
    for (const h of crevs) {
      const edges = [-WALL_DIST + 0.2, ...h.bridges.flatMap(([a, b]) => [a, b]), WALL_DIST - 0.2];
      for (let k = 0; k < edges.length; k += 2) {
        const m = new THREE.Mesh(strip(track, h.i0, h.i1, edges[k], edges[k + 1]), mat);
        m.receiveShadow = true;
        group.add(m);
      }
      for (const [a, b] of h.bridges) for (let i = h.i0; i <= h.i1; i += 3) for (const lat of [a, b]) chunks.push({ i, lat });
    }
    const im = new THREE.InstancedMesh(chunkGeo, new THREE.MeshStandardMaterial({ color: 0xe8f6ff, roughness: 0.3, flatShading: true }), chunks.length);
    const d = new THREE.Object3D();
    chunks.forEach(({ i, lat }, k) => {
      const p = track.points[i], s = track.sides[i];
      d.position.set(p.x + s.x * lat, track.groundAt(i, lat) + 0.15, p.z + s.z * lat);
      d.rotation.set(k, k * 2.3, 0); d.scale.set(1, 0.6, 1); d.updateMatrix();
      im.setMatrixAt(k, d.matrix);
    });
    im.castShadow = true;
    group.add(im);
  }

  // 교차로: 횡단보도 + 신호등
  for (const h of hs.filter((x) => x.kind === 'cross')) {
    const t = tex(256, 32, (ctx, w, hh) => { for (let x = 0; x < w; x += 32) { ctx.fillStyle = '#f4f4f4'; ctx.fillRect(x, 0, 18, hh); ctx.fillStyle = 'rgba(0,0,0,0)'; } });
    const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6, ...lift });
    for (const d of [-9, 9]) group.add(new THREE.Mesh(strip(track, h.i + Math.round(d / track.spacing) - 1, h.i + Math.round(d / track.spacing) + 1, -ROAD_HALF, ROAD_HALF), mat));
    for (const side of [-1, 1]) {
      const p = track.points[h.i], s = track.sides[h.i];
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 8).translate(0, 3, 0), new THREE.MeshStandardMaterial({ color: 0x444a55 })));
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.6), new THREE.MeshStandardMaterial({ color: 0x22252c }));
      box.position.y = 6.4; g.add(box);
      [[0xff3b3b, 0.55], [0xffcc00, 0], [0x3bff6b, -0.55]].forEach(([c, y]) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshBasicMaterial({ color: c })); l.position.set(0, 6.4 + y, 0.32 * -side); g.add(l); });
      g.position.set(p.x + s.x * side * (ROAD_HALF + 2.2), track.height[h.i], p.z + s.z * side * (ROAD_HALF + 2.2));
      g.rotation.y = yaw(h.i);
      group.add(g);
    }
  }

  // 블록 성: 성탑 2개 + 아치 + 성문 기둥 (벽돌 색)
  for (const h of hs.filter((x) => x.kind === 'castle')) {
    const p = track.points[h.i], s = track.sides[h.i], y0 = track.height[h.i];
    const g = new THREE.Group();
    g.position.set(p.x, y0, p.z);
    g.rotation.y = yaw(h.i);
    const grey = new THREE.MeshStandardMaterial({ color: 0xb8bec9, roughness: 0.35 });
    const red = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.35 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xffcc00, roughness: 0.35 });
    const stud = new THREE.CylinderGeometry(0.35, 0.35, 0.35, 10);
    for (const side of [-1, 1]) {
      const x = side * (ROAD_HALF + 4.5);
      const tower = new THREE.Mesh(new THREE.BoxGeometry(6, 15, 6).translate(0, 7.5, 0), grey);
      tower.position.x = x; tower.castShadow = true; g.add(tower);
      for (const [cx, cz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2], [0, -2.2], [0, 2.2], [-2.2, 0], [2.2, 0]]) {
        const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 1.4), red);
        merlon.position.set(x + cx, 15.8, cz); g.add(merlon);
        const st = new THREE.Mesh(stud, red); st.position.set(x + cx, 16.75, cz); g.add(st);
      }
      // 성문 기둥 (판정과 같은 위치)
      const pil = new THREE.Mesh(new THREE.BoxGeometry(2.6, 9, 2.6).translate(0, 4.5, 0), yellow);
      pil.position.x = side * 4.6; pil.castShadow = true; g.add(pil);
    }
    const arch = new THREE.Mesh(new THREE.BoxGeometry((ROAD_HALF + 4.5) * 2 + 6, 3, 4), grey);
    arch.position.y = 10.5; arch.castShadow = true; g.add(arch);
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x1d8cf8, side: THREE.DoubleSide });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5, 6), grey);
      pole.position.set(side * (ROAD_HALF + 4.5), 19, 0); g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), flagMat);
      flag.position.set(side * (ROAD_HALF + 4.5) + 1.3, 20.5, 0); g.add(flag);
    }
    group.add(g);
  }

  // 움직이는 블록 벽 / 버스
  for (const h of hs.filter((x) => x.kind === 'mover')) {
    const g = new THREE.Group();
    const inner = new THREE.Group();
    inner.rotation.y = yaw(h.i);
    g.add(inner);
    if (h.style === 'brick') {
      const mat = new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.35 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(h.halfLat * 2, h.h, h.halfAlong * 2).translate(0, h.h / 2, 0), mat);
      body.castShadow = body.receiveShadow = true;
      inner.add(body);
      const stud = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 12);
      for (let x = -h.halfLat + 1.1; x < h.halfLat; x += 2.2) for (const z of [-0.9, 0.9]) {
        const st = new THREE.Mesh(stud, mat); st.position.set(x, h.h + 0.2, z); inner.add(st);
      }
    } else {
      const t = tex(256, 64, (ctx, w, hh) => {
        ctx.fillStyle = '#ffc531'; ctx.fillRect(0, 0, w, hh);
        ctx.fillStyle = '#2b3a55'; for (let x = 12; x < w - 20; x += 34) ctx.fillRect(x, 10, 26, 22);
        ctx.fillStyle = '#e63946'; ctx.fillRect(0, hh - 12, w, 6);
      });
      const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(h.halfLat * 2, h.h - 0.5, h.halfAlong * 2).translate(0, (h.h - 0.5) / 2 + 0.5, 0), [mat, mat, new THREE.MeshStandardMaterial({ color: 0xffd34d }), mat, mat, mat]);
      body.castShadow = true;
      inner.add(body);
      const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12).rotateX(Math.PI / 2);
      const wm = new THREE.MeshStandardMaterial({ color: 0x1b1b1f });
      for (const x of [-h.halfLat + 1.4, h.halfLat - 1.4]) for (const z of [-h.halfAlong, h.halfAlong]) { const w = new THREE.Mesh(wheel, wm); w.position.set(x, 0.5, z); inner.add(w); }
    }
    h.mesh = g;
    group.add(g);
  }
}
