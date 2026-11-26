// 도시 건물: 유럽풍 집 (회반죽 벽 + 창틀·덧문, 삼각 기와지붕 + 굴뚝, 1층 줄무늬 차양) + 시계탑
// 집 모양은 (폭 × 층수) 몇 가지 종류로 만들고 InstancedMesh 로 색만 바꿔 여러 채 → 그리기 호출 수가 적음
import * as THREE from 'three';

const BAY = 3.4;      // 창문 한 칸 폭 (m)
const FLOOR = 3.4;    // 층 높이 (m)

const WALLS = [0xfff4e0, 0xf6d7c3, 0xd9e8f5, 0xd8efe0, 0xffe1b8, 0xf2f2f2, 0xf9d1d8, 0xe8dcc8];
const ROOFS = [0xc8553d, 0x2a9d8f, 0xb23a48, 0x4a6a92, 0xe07a3f, 0x8c4a3a];
const AWNINGS = [0x2f6fc4, 0xd62828, 0x2a9d8f, 0xe9a23b, 0x6a4c93];

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** 창문 한 칸 × 한 층 (반복되는 벽 무늬). 흰색 계열 → 집마다 색을 곱해서 칠함 */
function facadeTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 500; k++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    // 층 사이 띠 (처마돌림)
    g.fillStyle = '#d6d0c6'; g.fillRect(0, h - 10, w, 10);
    g.fillStyle = '#efeae2'; g.fillRect(0, h - 12, w, 2);
    // 덧문 (벽색의 진한 톤)
    g.fillStyle = '#8f8a86';
    g.fillRect(24, 30, 14, 66); g.fillRect(90, 30, 14, 66);
    g.fillStyle = '#a8a39e';
    for (let y = 34; y < 94; y += 6) { g.fillRect(26, y, 10, 2); g.fillRect(92, y, 10, 2); }
    // 창틀 + 유리
    g.fillStyle = '#fbf8f2'; g.fillRect(38, 26, 52, 74);
    const glass = g.createLinearGradient(42, 30, 86, 96);
    glass.addColorStop(0, '#5c88b8'); glass.addColorStop(0.5, '#2f4d78'); glass.addColorStop(1, '#22385c');
    g.fillStyle = glass; g.fillRect(42, 30, 44, 66);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.moveTo(46, 92); g.lineTo(60, 34); g.lineTo(66, 34); g.lineTo(52, 92); g.fill();
    g.fillStyle = '#fbf8f2'; g.fillRect(62, 30, 4, 66); g.fillRect(42, 58, 44, 4); // 창살
    // 창턱 + 화분
    g.fillStyle = '#e4ddd2'; g.fillRect(34, 100, 60, 6);
    for (let x = 40; x < 90; x += 9) { g.fillStyle = ['#e63946', '#ff8fab', '#ffd166'][(x / 9) % 3 | 0]; g.beginPath(); g.arc(x, 99, 4, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#4f8a3a'; g.fillRect(36, 99, 56, 2);
  });
}

/** 기와: 물고기 비늘 모양 줄 (흰색 계열 → 지붕색을 곱함) */
function tileTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#e8e2dc'; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 8; row++) {
      const y = row * 16, off = row % 2 ? 8 : 0;
      for (let x = -16 + off; x < w + 16; x += 16) {
        const grd = g.createLinearGradient(0, y, 0, y + 16);
        grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#b9b2ab');
        g.fillStyle = grd;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 16, y); g.lineTo(x + 16, y + 9); g.arc(x + 8, y + 9, 8, 0, Math.PI); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(60,40,30,0.35)'; g.lineWidth = 1.2; g.stroke();
      }
    }
  });
}

/** 줄무늬 차양 (흰색 + 회색 → 차양색을 곱하면 흰색/색 줄무늬) */
function awningTexture() {
  return canvasTex(64, 32, (g, w, h) => {
    for (let x = 0; x < w; x += 16) { g.fillStyle = '#ffffff'; g.fillRect(x, 0, 8, h); g.fillStyle = '#9a9a9a'; g.fillRect(x + 8, 0, 8, h); }
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h - 5, w, 5);
  });
}

/** 박스 UV 를 면 크기에 맞춰 늘려서 창문이 칸·층 단위로 반복되게 */
function wallBox(W, H, D, floors) {
  const g = new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0);
  const uv = g.attributes.uv;
  // 면 순서: +x, -x, +y, -y, +z, -z (면당 4 정점)
  const faceW = [D, D, W, W, W, W];
  for (let f = 0; f < 6; f++) {
    const top = f === 2 || f === 3;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (top) { uv.setXY(i, 0.05, 0.9); continue; } // 윗면/아랫면: 무늬 없는 곳
      uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(faceW[f] / BAY)), uv.getY(i) * floors);
    }
  }
  return g;
}

/** 삼각 지붕 (용마루가 x 방향). 처마가 벽보다 조금 나옴 */
function gableRoof(W, D, H, R) {
  const o = 0.6, x0 = -W / 2 - o, x1 = W / 2 + o, z0 = -D / 2 - o, z1 = D / 2 + o;
  const p = [], uv = [];
  const slopeLen = Math.hypot(D / 2 + o, R);
  const quad = (a, b, c, d, u, v) => { p.push(...a, ...b, ...c, ...a, ...c, ...d); uv.push(0, 0, u, 0, u, v, 0, 0, u, v, 0, v); };
  const tu = (x1 - x0) / 3, tv = slopeLen / 3;
  quad([x0, H, z1], [x1, H, z1], [x1, H + R, 0], [x0, H + R, 0], tu, tv); // 앞 경사면
  quad([x1, H, z0], [x0, H, z0], [x0, H + R, 0], [x1, H + R, 0], tu, tv); // 뒤 경사면
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** 박공(지붕 아래 삼각형 벽) + 굴뚝 → 벽 재질의 무늬 없는 곳을 씀 */
function gableWalls(W, D, H, R, chimney) {
  const p = [];
  for (const sx of [-1, 1]) {
    const x = (sx * W) / 2;
    if (sx > 0) p.push(x, H, D / 2, x, H, -D / 2, x, H + R, 0);
    else p.push(x, H, -D / 2, x, H, D / 2, x, H + R, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(p.length / 3 * 2).fill(0).map((_, i) => (i % 2 ? 0.9 : 0.05)), 2));
  g.computeVertexNormals();
  const parts = [g];
  if (chimney) {
    const c = new THREE.BoxGeometry(1.2, R + 1.6, 1.2).translate(W * 0.28, H + (R + 1.6) / 2 + R * 0.2, -D * 0.18);
    const cu = c.attributes.uv; for (let i = 0; i < cu.count; i++) cu.setXY(i, 0.05, 0.9);
    parts.push(c.toNonIndexed());
  }
  return mergeNonIndexed(parts);
}

/** 1층 앞면 차양들 (기울어진 판) */
function awnings(W, D) {
  const n = Math.max(1, Math.round(W / BAY)), bw = W / n;
  const p = [], uv = [];
  for (let k = 0; k < n; k++) {
    const x0 = -W / 2 + k * bw + 0.25, x1 = x0 + bw - 0.5;
    const y0 = 3.7, y1 = 2.9, z0 = D / 2, z1 = D / 2 + 1.3;
    p.push(x0, y0, z0, x1, y0, z0, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z1);
    p.push(x0, y1, z1, x1, y1, z1, x1, y1 - 0.45, z1, x0, y1, z1, x1, y1 - 0.45, z1, x0, y1 - 0.45, z1); // 앞 드리움
    const u = bw / 1.6;
    uv.push(0, 1, u, 1, u, 0, 0, 1, u, 0, 0, 0, 0, 0.2, u, 0.2, u, 0, 0, 0.2, u, 0, 0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** 평지붕 고층 건물의 지붕: 난간 + 물탱크 */
function flatRoofTop(W, D, H) {
  const parts = [];
  const add = (geo) => parts.push(geo.toNonIndexed());
  add(new THREE.BoxGeometry(W + 0.4, 0.9, 0.4).translate(0, H + 0.45, D / 2));
  add(new THREE.BoxGeometry(W + 0.4, 0.9, 0.4).translate(0, H + 0.45, -D / 2));
  add(new THREE.BoxGeometry(0.4, 0.9, D).translate(W / 2, H + 0.45, 0));
  add(new THREE.BoxGeometry(0.4, 0.9, D).translate(-W / 2, H + 0.45, 0));
  add(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 10).translate(W * 0.2, H + 2.4, D * 0.1));
  add(new THREE.ConeGeometry(1.6, 1, 10).translate(W * 0.2, H + 4.2, D * 0.1));
  for (const g of parts) { const u = g.attributes.uv; for (let i = 0; i < u.count; i++) u.setXY(i, 0.05, 0.9); }
  return mergeNonIndexed(parts);
}

function mergeNonIndexed(geos) {
  const pos = [], nor = [], uv = [];
  for (let g of geos) {
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

/**
 * buildings: { low, mid, tall } 각각 [{ x, z, sx, sy, sz, ry }] (기존 배치 결과)
 * detail=false 면 차양·굴뚝·지붕 장식 생략
 */
export function buildTown(group, buildings, rand, detail) {
  const facade = facadeTexture(), tiles = tileTexture(), stripes = awningTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.7, side: THREE.DoubleSide });
  const awnMat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.8, side: THREE.DoubleSide });
  const types = new Map();
  const typeOf = (W, floors, flat) => {
    const key = `${W}x${floors}${flat ? 'f' : ''}`;
    if (!types.has(key)) {
      const D = Math.round(W * 0.8), H = 0.6 + floors * FLOOR, R = flat ? 0 : D * 0.42;
      types.set(key, {
        body: mergeNonIndexed([wallBox(W, H, D, floors), ...(flat ? [flatRoofTop(W, D, H)] : [gableWalls(W, D, H, R, detail)])]),
        roof: flat ? null : gableRoof(W, D, H, R),
        awn: detail ? awnings(W, D) : null,
        list: [],
      });
    }
    return types.get(key);
  };
  const widths = [10.2, 13.6, 17];
  for (const [kind, list] of Object.entries(buildings)) {
    for (const b of list) {
      const W = widths.reduce((a, w) => (Math.abs(w - b.sx) < Math.abs(a - b.sx) ? w : a), widths[0]);
      // 아기자기한 동네 느낌: 대부분 2~5층 기와지붕, 먼 곳에 가끔만 평지붕 6층
      const floors = kind === 'low' ? 2 + (rand() < 0.5 ? 1 : 0) : kind === 'mid' ? 3 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 3);
      typeOf(W, floors, kind === 'tall' && floors === 6).list.push(b);
    }
  }
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (const t of types.values()) {
    const meshes = [[t.body, wallMat, WALLS], [t.roof, roofMat, ROOFS], [t.awn, awnMat, AWNINGS]].filter(([g]) => g);
    for (const list of chunk(t.list)) for (const [geo, mat, palette] of meshes) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((b, k) => {
        d.position.set(b.x, b.y ?? 0, b.z); d.rotation.set(0, b.ry, 0); d.scale.set(1, 1, 1); d.updateMatrix();
        im.setMatrixAt(k, d.matrix);
        // 집마다 벽·지붕·차양 색이 다르게 (위치로 고정된 난수 → 모든 화면 같음)
        const h = Math.abs(Math.sin(b.x * 12.9898 + b.z * 78.233) * 43758.5453) % 1;
        im.setColorAt(k, c.set(palette[Math.floor(h * palette.length * 7) % palette.length]));
      });
      im.castShadow = mat !== awnMat;
      im.receiveShadow = true;
      group.add(im);
    }
  }
}

/** 600m 구역마다 나눔 (화면 밖 구역은 안 그려지게, 집 종류가 많아서 구역은 크게) */
function chunk(items, size = 600) {
  const m = new Map();
  for (const it of items) { const k = `${Math.floor(it.x / size)},${Math.floor(it.z / size)}`; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return [...m.values()];
}

// ---------------- 시계탑 ----------------
function clockFace() {
  return canvasTex(256, 256, (g, w) => {
    const r = w / 2;
    g.fillStyle = '#1f3a68'; g.fillRect(0, 0, w, w);
    g.strokeStyle = '#e8c35a'; g.lineWidth = 6;
    for (const [x, y] of [[30, 30], [w - 30, 30], [30, w - 30], [w - 30, w - 30]]) { g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#e8c35a'; g.beginPath(); g.arc(r, r, r * 0.86, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fbfaf6'; g.beginPath(); g.arc(r, r, r * 0.76, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#1f2a44';
    for (let k = 0; k < 60; k++) {
      const a = (k / 60) * Math.PI * 2, big = k % 5 === 0;
      g.lineWidth = big ? 5 : 2;
      g.beginPath(); g.moveTo(r + Math.cos(a) * r * (big ? 0.6 : 0.66), r + Math.sin(a) * r * (big ? 0.6 : 0.66)); g.lineTo(r + Math.cos(a) * r * 0.72, r + Math.sin(a) * r * 0.72); g.stroke();
    }
    g.lineCap = 'round';
    g.lineWidth = 9; g.beginPath(); g.moveTo(r, r); g.lineTo(r + r * 0.32, r - r * 0.18); g.stroke();
    g.lineWidth = 6; g.beginPath(); g.moveTo(r, r); g.lineTo(r - r * 0.1, r - r * 0.56); g.stroke();
    g.fillStyle = '#1f2a44'; g.beginPath(); g.arc(r, r, 9, 0, Math.PI * 2); g.fill();
  }, false);
}

function brickTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#c9a27a'; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 8; row++) for (let x = (row % 2) * -16; x < w; x += 32) {
      g.fillStyle = ['#d8b089', '#cf9f73', '#e0bb93', '#c79466'][(row + x) & 3];
      g.fillRect(x + 1, row * 16 + 1, 30, 14);
    }
  });
}

/** 시계탑: 벽돌 몸통 + 시계 4면 + 금테 + 뾰족 지붕 (x, y, z 바닥 중심, ry 방향) */
export function buildClockTower(group, x, y, z, ry) {
  const g = new THREE.Group();
  g.position.set(x, y, z); g.rotation.y = ry;
  const brick = brickTexture(); brick.repeat.set(3, 5);
  const brickMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.9 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf1e6d2, roughness: 0.7 });
  const upper = new THREE.MeshStandardMaterial({ color: 0xd9925e, roughness: 0.75 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c35a, metalness: 0.8, roughness: 0.3 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x2f5d8c, roughness: 0.6 });
  const add = (geo, mat, px = 0, py = 0, pz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(10, 22, 10), brickMat, 0, 11);
  add(new THREE.BoxGeometry(11, 1.2, 11), trim, 0, 22.6);
  add(new THREE.BoxGeometry(9.4, 11, 9.4), upper, 0, 28.7);
  add(new THREE.BoxGeometry(10.6, 1, 10.6), trim, 0, 34.6);
  const faceMat = new THREE.MeshStandardMaterial({ map: clockFace(), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.08 });
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const f = add(new THREE.PlaneGeometry(7.6, 7.6), faceMat, Math.sin(a) * 4.75, 28.7, Math.cos(a) * 4.75);
    f.rotation.y = a;
    const ring = add(new THREE.TorusGeometry(3.3, 0.28, 8, 40), gold, Math.sin(a) * 4.85, 28.7, Math.cos(a) * 4.85);
    ring.rotation.y = a;
  }
  // 아치 창문 (벽돌 몸통)
  const winMat = new THREE.MeshStandardMaterial({ color: 0x3a2f2a, roughness: 0.8 });
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    for (const hy of [8, 15]) { const w = add(new THREE.BoxGeometry(1.6, 3, 0.2), winMat, Math.sin(a) * 5.02, hy, Math.cos(a) * 5.02); w.rotation.y = a; }
  }
  add(new THREE.ConeGeometry(7.6, 9, 4, 1).rotateY(Math.PI / 4), roof, 0, 39.6);
  add(new THREE.SphereGeometry(0.6, 12, 8), gold, 0, 44.6);
  add(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6), gold, 0, 46);
  group.add(g);
}
