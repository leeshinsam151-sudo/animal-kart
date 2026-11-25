// 카트 + 동물 캐릭터 모델링 (외부 에셋 없이 기본 도형으로 제작)
// 툰 셰이딩(MeshToonMaterial) + 뒷면 확장 외곽선으로 카툰 스타일
// 카트 앞쪽 = 로컬 +Z
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const KART_SCALE = 1.5;

// ---------------- 재질 ----------------
const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
const matCache = new Map();
function toon(color) {
  const key = String(color);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshToonMaterial({ color, gradientMap }));
  return matCache.get(key);
}
const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x1d1b2a, side: THREE.BackSide });
OUTLINE.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * 0.022;');
};

const BLACK = '#1c1c24';
const WHITE = '#ffffff';
const PINK = '#ff8fa3';

// ---------------- 지오메트리 헬퍼 ----------------
const geoCache = new Map();
function cached(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}
const sphere = (r) => cached(`s${r}`, () => (r < 0.2 ? new THREE.SphereGeometry(r, 12, 8) : new THREE.SphereGeometry(r, 22, 14)));
const capsule = (r, len, axis = 'y') => cached(`c${r}-${len}-${axis}`, () => {
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  return g;
});
const boxG = (w, h, d) => cached(`b${w}-${h}-${d}`, () => new THREE.BoxGeometry(w, h, d));
const cone = (r, h, seg = 8) => cached(`k${r}-${h}-${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const cyl = (r, h, axis = 'y') => cached(`y${r}-${h}-${axis}`, () => {
  const g = new THREE.CylinderGeometry(r, r, h, 18);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
});

/** 메시 생성 (+선택적으로 외곽선) */
function M(geo, color, { pos, rot, scale, outline = true, cast = true } = {}) {
  const m = new THREE.Mesh(geo, toon(color));
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = cast;
  if (outline) m.add(new THREE.Mesh(geo, OUTLINE));
  return m;
}

/** 옆면 실루엣(길이, 높이)을 폭 방향으로 돌출 */
function profile(points, width, bevel) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 1,
  });
  g.translate(0, 0, -width / 2);
  g.rotateY(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** 위에서 본 둥근 사각형 판 */
function plate(w, l, r, thick) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -l / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + l - r); s.quadraticCurveTo(x + w, y + l, x + w - r, y + l);
  s.lineTo(x + r, y + l); s.quadraticCurveTo(x, y + l, x, y + l - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  g.rotateX(Math.PI / 2); // 판을 수평으로 (두께는 아래 방향)
  return g;
}

const chassisGeo = plate(1.1, 2.4, 0.25, 0.1);
const noseGeo = profile([[0.35, 0.24], [1.38, 0.24], [1.48, 0.33], [1.15, 0.52], [0.35, 0.6]], 0.86, 0.05);

/** 머리 구면 위 (x, y) 지점의 앞쪽 z 좌표 */
const R = 0.42;
const faceZ = (x, y, r = R) => Math.sqrt(Math.max(0, r * r - x * x - y * y));

// ---------------- 얼굴 공통 파츠 ----------------
function eyes(head, { y = 0.05, x = 0.15, size = 0.065, color = BLACK } = {}) {
  for (const s of [-1, 1]) {
    const z = faceZ(x, y);
    head.add(M(sphere(size), color, { pos: [s * x, y, z], scale: [0.85, 1.3, 0.5], outline: false }));
    head.add(M(sphere(size * 0.35), WHITE, { pos: [s * x - 0.02, y + 0.04, z + size * 0.45], outline: false }));
  }
}

function smile(head, y, z, r = 0.055) {
  const g = cached(`smile${r}`, () => new THREE.TorusGeometry(r, 0.016, 6, 14, Math.PI));
  head.add(M(g, '#3a1f1f', { pos: [0, y, z], rot: [0, 0, Math.PI], outline: false }));
}

function blush(head, y = -0.07, x = 0.25) {
  for (const s of [-1, 1]) head.add(M(sphere(0.065), PINK, { pos: [s * x, y, faceZ(x, y) - 0.01], scale: [1, 0.6, 0.3], outline: false }));
}

/** 동물 주둥이 + 코 + 입 */
function muzzle(head, color, nose = BLACK, { y = -0.11, w = 0.17, mouth = true } = {}) {
  const z = faceZ(0, y) - 0.06;
  head.add(M(sphere(w), color, { pos: [0, y, z], scale: [1.15, 0.8, 0.7] }));
  const front = z + w * 0.7;
  head.add(M(sphere(0.055), nose, { pos: [0, y + 0.05, front - 0.01], scale: [1.3, 0.9, 0.8], outline: false }));
  if (mouth) smile(head, y - 0.04, front - 0.025, 0.045);
}

function roundEars(head, color, inner, { x = 0.29, y = 0.31, r = 0.13 } = {}) {
  for (const s of [-1, 1]) {
    head.add(M(sphere(r), color, { pos: [s * x, y, -0.02] }));
    if (inner) head.add(M(sphere(r * 0.55), inner, { pos: [s * x, y, -0.02 + r * 0.6], scale: [1, 1, 0.5], outline: false }));
  }
}

function pointyEars(head, color, inner) {
  for (const s of [-1, 1]) {
    head.add(M(cone(0.14, 0.3, 4), color, { pos: [s * 0.25, 0.37, -0.02], rot: [0, Math.PI / 4, -s * 0.35] }));
    head.add(M(cone(0.08, 0.18, 4), inner, { pos: [s * 0.245, 0.35, 0.05], rot: [0, Math.PI / 4, -s * 0.35], outline: false }));
  }
}

function stripe(head, color, x, y, len, rotZ) {
  const z = faceZ(x, y) - 0.005;
  const m = M(boxG(0.035, len, 0.03), color, { pos: [x, y, z], outline: false });
  m.lookAt(m.position.clone().multiplyScalar(2)); // 표면 법선 방향으로
  m.rotateZ(rotZ);
  head.add(m);
}

function whiskers(head, y = -0.1) {
  for (const s of [-1, 1]) for (const k of [-1, 1]) {
    head.add(M(boxG(0.22, 0.012, 0.012), BLACK, { pos: [s * 0.3, y + k * 0.025, faceZ(0.24, y) + 0.02], rot: [0, -s * 0.3, s * k * 0.12], outline: false }));
  }
}

// ---------------- 동물 캐릭터 ----------------
export const CHARACTERS = {
  panda: {
    name: '판다', emoji: '🐼', fur: '#f7f7f2', outfit: '#43aa8b', pants: '#2b2d42', scarf: '#90be6d', glove: '#2b2b33',
    build(head) {
      roundEars(head, BLACK, null);
      // 눈 주변 검은 무늬 위에 하얀 눈
      for (const s of [-1, 1]) {
        head.add(M(sphere(0.11), BLACK, { pos: [s * 0.15, 0.03, faceZ(0.15, 0.03) - 0.04], rot: [0, 0, s * 0.5], scale: [1, 1.3, 0.5], outline: false }));
        head.add(M(sphere(0.045), WHITE, { pos: [s * 0.15, 0.05, faceZ(0.15, 0.05) + 0.015], outline: false }));
        head.add(M(sphere(0.026), BLACK, { pos: [s * 0.14, 0.05, faceZ(0.14, 0.05) + 0.045], outline: false }));
      }
      muzzle(head, '#ffffff', BLACK);
      blush(head, -0.12, 0.27);
    },
  },
  cat: {
    name: '고양이', emoji: '🐱', fur: '#ffb35c', outfit: '#ff6b9d', pants: '#3d405b', scarf: '#ffd6e0', glove: '#ffffff',
    build(head) {
      pointyEars(head, '#ffb35c', '#ffc2d1');
      for (const [x, rz] of [[0, 0], [-0.09, 0.25], [0.09, -0.25]]) stripe(head, '#e07a1f', x, 0.3, 0.14, rz);
      eyes(head, { color: '#2a3d2a' });
      muzzle(head, '#fff3e0', '#ff7a95', { w: 0.14 });
      whiskers(head);
      blush(head);
    },
  },
  dog: {
    name: '강아지', emoji: '🐶', fur: '#e0a96d', outfit: '#3a86ff', pants: '#2b2d42', scarf: '#ff595e', glove: '#ffffff',
    build(head) {
      // 늘어진 귀
      for (const s of [-1, 1]) head.add(M(sphere(0.17), '#8b5a2b', { pos: [s * 0.4, 0.05, -0.04], rot: [0, 0, s * 0.35], scale: [0.5, 1.15, 0.75] }));
      head.add(M(sphere(0.12), '#8b5a2b', { pos: [0.16, 0.08, faceZ(0.16, 0.08) - 0.07], scale: [1, 1.1, 0.5], outline: false })); // 눈가 얼룩
      eyes(head);
      muzzle(head, '#fff1dc', BLACK, { w: 0.18 });
      head.add(M(sphere(0.05), '#ff6b81', { pos: [0, -0.21, faceZ(0, -0.2) + 0.06], scale: [1, 0.6, 0.6], outline: false })); // 혀
    },
  },
  lion: {
    name: '사자', emoji: '🦁', fur: '#f6bd4f', outfit: '#e63946', pants: '#3d2c2e', scarf: '#ffd166', glove: '#ffffff',
    build(head) {
      // 갈기: 얼굴 둘레의 구슬 + 뒷머리
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        head.add(M(sphere(0.17), '#c8641e', { pos: [Math.cos(a) * 0.42, Math.sin(a) * 0.42, -0.1] }));
      }
      head.add(M(sphere(0.44), '#c8641e', { pos: [0, 0, -0.14], scale: [1.05, 1.05, 0.8] }));
      roundEars(head, '#f6bd4f', '#ffe0a3', { x: 0.27, y: 0.33, r: 0.1 });
      eyes(head);
      muzzle(head, '#fff0c9', '#6b3e26');
      blush(head);
    },
  },
  tiger: {
    name: '호랑이', emoji: '🐯', fur: '#ff8f2b', outfit: '#1d3557', pants: '#14213d', scarf: '#f1faee', glove: '#ffffff',
    build(head) {
      roundEars(head, '#ff8f2b', '#ffffff', { r: 0.12 });
      for (const [x, y, len, rz] of [[0, 0.32, 0.16, 0], [-0.1, 0.28, 0.12, 0.3], [0.1, 0.28, 0.12, -0.3],
        [-0.36, 0.05, 0.14, 1.3], [0.36, 0.05, 0.14, -1.3], [-0.37, -0.06, 0.12, 1.4], [0.37, -0.06, 0.12, -1.4]]) {
        stripe(head, BLACK, x, y, len, rz);
      }
      for (const s of [-1, 1]) head.add(M(sphere(0.13), '#ffffff', { pos: [s * 0.2, -0.12, faceZ(0.2, -0.12) - 0.05], scale: [1, 0.8, 0.5], outline: false }));
      eyes(head, { color: '#3b2a12' });
      muzzle(head, '#ffffff', '#ff7a95', { w: 0.14 });
      whiskers(head);
    },
  },
  eagle: {
    name: '독수리', emoji: '🦅', fur: '#fafafa', outfit: '#6b4226', pants: '#3b2416', scarf: '#ffc300', glove: '#ffc300',
    build(head) {
      // 뒤로 뻗은 깃털
      for (const [x, y, rx] of [[0, 0.36, -1.0], [-0.12, 0.33, -1.15], [0.12, 0.33, -1.15], [0, 0.25, -1.35]]) {
        head.add(M(cone(0.09, 0.32, 6), '#ececec', { pos: [x, y, -0.3], rot: [rx, 0, 0] }));
      }
      eyes(head, { y: 0.07, size: 0.06 });
      // 진한 눈썹 (늠름한 인상)
      for (const s of [-1, 1]) head.add(M(boxG(0.17, 0.04, 0.05), '#5c3b1e', { pos: [s * 0.15, 0.17, faceZ(0.15, 0.17) + 0.01], rot: [0, 0, s * 0.3], outline: false }));
      // 갈고리 부리
      head.add(M(cone(0.11, 0.3, 10), '#ffc300', { pos: [0, -0.06, faceZ(0, -0.06) + 0.1], rot: [Math.PI / 2 + 0.35, 0, 0] }));
      head.add(M(sphere(0.1), '#ffc300', { pos: [0, -0.04, faceZ(0, -0.04) - 0.01], scale: [1.1, 0.8, 0.8] }));
    },
  },
};
export const CHARACTER_IDS = Object.keys(CHARACTERS);

// ---------------- 카트 ----------------
// ---------------- 동물별 카트 디자인 (장식만 다름, 크기·바퀴 위치·충돌은 동일) ----------------
const DARK = '#2a2a35';
const GOLD = '#ffcf4a';

function defaultShell(body, color) {
  body.add(M(noseGeo, color));
  body.add(M(capsule(0.06, 1.2, 'x'), DARK, { pos: [0, 0.27, 1.52] }));        // 앞 범퍼
  body.add(M(capsule(0.06, 1.4, 'x'), DARK, { pos: [0, 0.27, -1.34] }));       // 뒤 범퍼
  for (const s of [-1, 1]) body.add(M(capsule(0.16, 0.75, 'z'), color, { pos: [s * 0.6, 0.33, -0.02] })); // 사이드 포드
  body.add(M(boxG(0.25, 0.02, 0.6), WHITE, { pos: [0, 0.6, 0.85], rot: [-0.33, 0, 0], outline: false })); // 보닛 스트라이프
}

function defaultEngine(body) {
  body.add(M(boxG(0.62, 0.34, 0.38), '#9aa0aa', { pos: [0, 0.48, -0.98] }));
  for (const s of [-1, 1]) body.add(M(cyl(0.07, 0.32, 'z'), '#444450', { pos: [s * 0.2, 0.58, -1.22] }));
}

// 차체 모양용 실루엣 (옆에서 본 모양 → 폭 방향으로 돌출)
const catNoseGeo = profile([[0.3, 0.24], [1.62, 0.24], [1.72, 0.3], [1.3, 0.42], [0.3, 0.56]], 0.8, 0.05);   // 길고 납작한 쐐기
const dogNoseGeo = profile([[0.3, 0.22], [1.42, 0.22], [1.48, 0.62], [1.2, 0.68], [0.3, 0.66]], 1.0, 0.07);  // 각진 지프
const tigerNoseGeo = profile([[0.3, 0.22], [1.5, 0.22], [1.58, 0.36], [1.25, 0.56], [0.3, 0.62]], 1.0, 0.06);
const eagleNoseGeo = profile([[0.3, 0.26], [1.55, 0.3], [1.62, 0.36], [1.1, 0.5], [0.3, 0.58]], 0.7, 0.05);

function bumpers(body, front = true, back = true) {
  if (front) body.add(M(capsule(0.06, 1.2, 'x'), DARK, { pos: [0, 0.27, 1.52] }));
  if (back) body.add(M(capsule(0.06, 1.4, 'x'), DARK, { pos: [0, 0.27, -1.34] }));
}

function defaultSpoiler(body, color) {
  body.add(M(boxG(1.35, 0.06, 0.32), color, { pos: [0, 1.0, -1.15] }));
  for (const s of [-1, 1]) body.add(M(boxG(0.06, 0.36, 0.12), DARK, { pos: [s * 0.42, 0.8, -1.12] }));
}

const KART_STYLES = {
  // 🐼 대나무 스포일러 + 잎사귀, 사이드 포드 대나무 마디, 동그란 검은 헤드라이트
  panda: {
    rim: '#7bc96f',
    seat: '#2a2a35',
    // 동글동글 버기: 앞코가 판다 얼굴 (하얀 얼굴 + 검은 눈 무늬·코·귀), 뒤에 동그란 꼬리
    shell(body, color) {
      body.add(M(sphere(0.5), WHITE, { pos: [0, 0.42, 1.0], scale: [1.05, 0.6, 1.15] }));
      for (const s of [-1, 1]) {
        body.add(M(sphere(0.13), BLACK, { pos: [s * 0.3, 0.68, 0.95] }));                     // 귀
        body.add(M(capsule(0.17, 0.6, 'z'), color, { pos: [s * 0.6, 0.34, -0.1] }));         // 통통한 사이드 포드
      }
      body.add(M(sphere(0.07), BLACK, { pos: [0, 0.5, 1.56], scale: [1.3, 1, 0.8] }));        // 코
      body.add(M(sphere(0.16), BLACK, { pos: [0, 0.55, -1.32] }));                           // 꼬리
      bumpers(body, false, true);
    },
    spoiler(body) {
      body.add(M(cyl(0.075, 1.45, 'x'), '#9ccc65', { pos: [0, 1.0, -1.15] }));
      for (const x of [-0.45, 0, 0.45]) body.add(M(cyl(0.09, 0.04, 'x'), '#5e8f2c', { pos: [x, 1.0, -1.15], outline: false }));
      for (const s of [-1, 1]) body.add(M(cyl(0.06, 0.38), '#9ccc65', { pos: [s * 0.42, 0.8, -1.12] }));
      body.add(M(sphere(0.12), '#43a047', { pos: [0.62, 1.1, -1.08], rot: [0, 0.5, 0.4], scale: [0.6, 0.25, 2.2] }));
      body.add(M(sphere(0.12), '#43a047', { pos: [0.5, 1.12, -1.25], rot: [0, -0.6, 0.3], scale: [0.6, 0.25, 1.8] }));
    },
    deco(body) {
      for (const s of [-1, 1]) {
        for (const z of [-0.3, 0.25]) body.add(M(cyl(0.17, 0.05, 'z'), '#5e8f2c', { pos: [s * 0.6, 0.33, z], outline: false }));
        // 판다 눈 무늬 (앞코 얼굴)
        body.add(M(sphere(0.11), BLACK, { pos: [s * 0.22, 0.52, 1.47], rot: [0, 0, s * 0.5], scale: [1, 1.3, 0.45], outline: false }));
        body.add(M(sphere(0.045), WHITE, { pos: [s * 0.21, 0.54, 1.52], outline: false }));
      }
    },
  },
  // 🐱 스포일러 고양이 귀, 보닛 발바닥 무늬, 앞쪽 수염, 뒤로 솟은 꼬리
  cat: {
    rim: '#ffc2d1',
    // 날렵한 스포츠카: 길고 납작한 쐐기 앞코 + 고양이 눈 헤드라이트 + 발바닥 무늬 포드
    shell(body, color) {
      body.add(M(catNoseGeo, color));
      for (const s of [-1, 1]) {
        body.add(M(sphere(0.1), '#c8f560', { pos: [s * 0.24, 0.34, 1.62], rot: [0, 0, s * 0.35], scale: [1.4, 0.55, 0.4] }));
        body.add(M(boxG(0.02, 0.09, 0.02), BLACK, { pos: [s * 0.24, 0.34, 1.665], outline: false }));
        body.add(M(capsule(0.13, 0.85, 'z'), color, { pos: [s * 0.6, 0.31, -0.05] }));
        body.add(M(cyl(0.07, 0.02, 'x'), '#ff8fab', { pos: [s * 0.74, 0.33, 0.05], outline: false }));   // 발바닥
        for (const dz of [-0.09, 0, 0.09]) body.add(M(cyl(0.03, 0.02, 'x'), '#ff8fab', { pos: [s * 0.74, 0.43, 0.05 + dz], outline: false }));
      }
      bumpers(body, false, true);
    },
    spoiler(body, color) {
      defaultSpoiler(body, color);
      for (const s of [-1, 1]) {
        body.add(M(cone(0.13, 0.26, 4), color, { pos: [s * 0.55, 1.15, -1.15], rot: [0, Math.PI / 4, 0] }));
        body.add(M(cone(0.07, 0.15, 4), '#ffc2d1', { pos: [s * 0.55, 1.13, -1.09], rot: [0, Math.PI / 4, 0], outline: false }));
      }
    },
    deco(body, color) {
      body.add(M(cyl(0.085, 0.02), '#ff8fab', { pos: [0, 0.6, 0.78], rot: [-0.1, 0, 0], outline: false }));
      for (const [x, z] of [[-0.09, 0.9], [0, 0.93], [0.09, 0.9]]) body.add(M(cyl(0.035, 0.02), '#ff8fab', { pos: [x, 0.59, z], rot: [-0.1, 0, 0], outline: false }));
      for (const s of [-1, 1]) for (const k of [-1, 0, 1]) {
        body.add(M(boxG(0.32, 0.015, 0.015), BLACK, { pos: [s * 0.42, 0.38 + k * 0.05, 1.42], rot: [0, -s * 0.25, s * k * 0.15], outline: false }));
      }
      const tail = cached('cattail', () => new THREE.TorusGeometry(0.3, 0.05, 6, 14, Math.PI * 0.85));
      body.add(M(tail, color, { pos: [0.32, 0.95, -1.32], rot: [0, Math.PI / 2, 0.2] }));
    },
  },
  // 🐶 뼈다귀 스포일러, 범퍼 끝 뼈다귀, 귀 모양 머드가드
  dog: {
    rim: WHITE,
    // 튼튼한 지프: 각진 앞코 + 강아지 코 + 큰 눈 헤드라이트 + 펜더 + 롤케이지
    shell(body, color) {
      body.add(M(dogNoseGeo, color));
      for (const s of [-1, 1]) {
        body.add(M(cyl(0.11, 0.06, 'z'), WHITE, { pos: [s * 0.3, 0.52, 1.53] }));            // 큰 눈 헤드라이트
        body.add(M(cyl(0.05, 0.065, 'z'), BLACK, { pos: [s * 0.3, 0.52, 1.545], outline: false }));
        body.add(M(boxG(0.36, 0.06, 0.6), color, { pos: [s * 0.74, 0.62, 0.88] }));            // 앞 펜더
        body.add(M(boxG(0.4, 0.06, 0.66), color, { pos: [s * 0.8, 0.74, -0.8] }));             // 뒤 펜더
        body.add(M(capsule(0.04, 0.9, 'y'), DARK, { pos: [s * 0.38, 0.95, -0.55] }));         // 롤케이지 기둥
      }
      body.add(M(capsule(0.04, 0.76, 'x'), DARK, { pos: [0, 1.42, -0.55] }));                 // 롤케이지 윗봉
      body.add(M(sphere(0.1), BLACK, { pos: [0, 0.46, 1.56], scale: [1.4, 1, 1] }));          // 강아지 코
      body.add(M(boxG(0.5, 0.12, 0.05), DARK, { pos: [0, 0.32, 1.52] }));                     // 그릴
      bumpers(body, true, true);
    },
    // 뒤에 작은 개집
    engine(body, color) {
      body.add(M(boxG(0.6, 0.36, 0.42), '#d9a066', { pos: [0, 0.5, -1.0] }));
      for (const s of [-1, 1]) body.add(M(boxG(0.36, 0.05, 0.46), '#c0392b', { pos: [s * 0.15, 0.78, -1.0], rot: [0, 0, s * -0.6] }));
      body.add(M(cyl(0.11, 0.02, 'z'), BLACK, { pos: [0, 0.46, -1.22], outline: false }));    // 개집 문
      for (const s of [-1, 1]) body.add(M(cyl(0.06, 0.28, 'z'), '#444450', { pos: [s * 0.22, 0.4, -1.28] }));
    },
    exhaustTips: [[-0.22, 0.4, -1.44], [0.22, 0.4, -1.44]],
    spoiler(body) {
      body.add(M(cyl(0.07, 1.15, 'x'), '#fff3e0', { pos: [0, 1.0, -1.15] }));
      for (const s of [-1, 1]) for (const dz of [-0.08, 0.08]) body.add(M(sphere(0.11), '#fff3e0', { pos: [s * 0.6, 1.0, -1.15 + dz] }));
      for (const s of [-1, 1]) body.add(M(boxG(0.06, 0.36, 0.12), DARK, { pos: [s * 0.42, 0.8, -1.12] }));
    },
    deco(body) {
      for (const s of [-1, 1]) {
        for (const dy of [-0.05, 0.05]) body.add(M(sphere(0.07), '#fff3e0', { pos: [s * 0.64, 0.27 + dy, 1.52] }));
        body.add(M(sphere(0.2), '#8b5a2b', { pos: [s * 0.8, 0.32, -1.2], scale: [0.25, 1.1, 0.9] }));
      }
    },
  },
  // 🦁 금색 왕관 + 루비, 금색 장식
  lion: {
    rim: GOLD,
    seat: '#b3122b', // 빨간 벨벳 시트
    // 왕의 마차: 기본 차체 + 앞 그릴의 금빛 갈기 + 금색 몰딩 + 꼬리
    shell(body, color) {
      defaultShell(body, color);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        body.add(M(cone(0.06, 0.2, 5), GOLD, { pos: [Math.cos(a) * 0.2, 0.42 + Math.sin(a) * 0.14, 1.5], rot: [Math.PI / 2, 0, a - Math.PI / 2], outline: false }));
      }
      body.add(M(sphere(0.12), '#ff9f1c', { pos: [0, 0.42, 1.5], scale: [1, 0.75, 0.5] }));
      for (const s of [-1, 1]) body.add(M(capsule(0.03, 0.8, 'z'), GOLD, { pos: [s * 0.6, 0.47, -0.02], outline: false }));
      body.add(M(cyl(0.025, 0.5, 'z'), '#c8641e', { pos: [0, 0.62, -1.35], rot: [0.5, 0, 0], outline: false })); // 꼬리
      body.add(M(sphere(0.09), '#8b3a0e', { pos: [0, 0.75, -1.58] }));
    },
    spoiler(body, color) {
      defaultSpoiler(body, color);
      body.add(M(cyl(0.2, 0.1), GOLD, { pos: [0, 1.09, -1.15] }));
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        body.add(M(cone(0.05, 0.16, 5), GOLD, { pos: [Math.cos(a) * 0.15, 1.21, -1.15 + Math.sin(a) * 0.15], outline: false }));
      }
      body.add(M(sphere(0.06), '#e63946', { pos: [0, 1.17, -0.97], outline: false }));
    },
    deco(body) {
      body.add(M(boxG(0.27, 0.025, 0.62), GOLD, { pos: [0, 0.605, 0.85], rot: [-0.33, 0, 0], outline: false }));
      body.add(M(sphere(0.09), GOLD, { pos: [0, 0.45, 1.42] }));
      for (const s of [-1, 1]) body.add(M(sphere(0.1), GOLD, { pos: [s * 0.6, 0.33, 0.42], outline: false }));
    },
  },
  // 🐯 호랑이 줄무늬, 이중 리어윙, 앞 스플리터
  tiger: {
    rim: '#ff8f2b',
    // 근육질 레이서: 넓은 펜더 + 상어 이빨 그릴 + 발톱 자국 + 큰 배기구
    shell(body, color) {
      body.add(M(tigerNoseGeo, color));
      for (const s of [-1, 1]) {
        body.add(M(capsule(0.2, 0.55, 'z'), color, { pos: [s * 0.68, 0.42, 0.82] }));          // 앞 펜더
        body.add(M(capsule(0.24, 0.6, 'z'), color, { pos: [s * 0.72, 0.5, -0.78] }));          // 뒤 펜더
        body.add(M(capsule(0.16, 0.7, 'z'), color, { pos: [s * 0.58, 0.34, 0.02] }));
        for (const k of [0, 1, 2]) body.add(M(boxG(0.02, 0.24, 0.035), BLACK, { pos: [s * 0.75, 0.37, -0.12 + k * 0.1], rot: [0.5, 0, 0], outline: false })); // 발톱 자국
      }
      body.add(M(boxG(0.8, 0.12, 0.05), BLACK, { pos: [0, 0.3, 1.58] }));                     // 입
      for (let k = 0; k < 6; k++) body.add(M(cone(0.05, 0.1, 4), WHITE, { pos: [-0.3 + k * 0.12, 0.33, 1.6], rot: [Math.PI, 0, 0], outline: false })); // 이빨
      bumpers(body, false, true);
    },
    engine(body) {
      body.add(M(boxG(0.62, 0.34, 0.38), '#9aa0aa', { pos: [0, 0.48, -0.98] }));
      for (const s of [-1, 1]) body.add(M(cyl(0.11, 0.4, 'z'), '#c0c4cc', { pos: [s * 0.22, 0.58, -1.25] }));
    },
    spoiler(body, color) {
      defaultSpoiler(body, color);
      body.add(M(boxG(1.1, 0.05, 0.22), BLACK, { pos: [0, 0.84, -1.22] }));
    },
    deco(body) {
      // 새 차체(근육질 앞코) 표면 위로
      for (const [z, y, w] of [[0.5, 0.675, 0.72], [0.72, 0.665, 0.78], [0.95, 0.65, 0.82], [1.18, 0.6, 0.7]]) {
        body.add(M(boxG(w, 0.03, 0.06), BLACK, { pos: [0, y, z], rot: [-0.12, 0, 0], outline: false }));
      }
      for (const s of [-1, 1]) for (const z of [-0.3, 0, 0.3]) body.add(M(cyl(0.17, 0.05, 'z'), BLACK, { pos: [s * 0.6, 0.33, z], outline: false }));
      body.add(M(boxG(1.15, 0.04, 0.24), BLACK, { pos: [0, 0.2, 1.56] }));
    },
  },
  // 🦅 날개 모양 스포일러, 노란 부리 노즈, 깃털 핀
  eagle: {
    rim: '#cfd8e3',
    // 제트 글라이더: 가늘고 뾰족한 앞코 + 날개 스텁 + 수직 꼬리날개 + 제트 엔진
    shell(body, color) {
      body.add(M(eagleNoseGeo, color));
      for (const s of [-1, 1]) {
        body.add(M(capsule(0.13, 0.8, 'z'), color, { pos: [s * 0.58, 0.32, -0.02] }));
        body.add(M(boxG(0.42, 0.04, 0.5), '#fafafa', { pos: [s * 0.78, 0.4, 0.05], rot: [0, 0, s * -0.18] })); // 날개 스텁
      }
      body.add(M(boxG(0.05, 0.55, 0.42), color, { pos: [0, 1.15, -1.2], rot: [-0.35, 0, 0] }));             // 수직 꼬리날개
      bumpers(body, false, true);
    },
    engine(body) {
      body.add(M(cyl(0.22, 0.5, 'z'), '#b8c2cc', { pos: [0, 0.52, -1.05] }));
      body.add(M(cached('jetring', () => new THREE.TorusGeometry(0.22, 0.045, 6, 16)), '#6b7684', { pos: [0, 0.52, -1.3] }));
    },
    exhaustTips: [[0, 0.52, -1.35]],
    spoiler(body) {
      for (const s of [-1, 1]) {
        // 바퀴 폭(±1.0) 안에 들어오게
        body.add(M(boxG(0.62, 0.05, 0.34), '#fafafa', { pos: [s * 0.36, 1.04, -1.2], rot: [0, s * 0.3, s * 0.22] }));
        body.add(M(boxG(0.24, 0.05, 0.24), '#6b4226', { pos: [s * 0.74, 1.12, -1.33], rot: [0, s * 0.45, s * 0.3] }));
        body.add(M(boxG(0.06, 0.36, 0.12), DARK, { pos: [s * 0.3, 0.82, -1.12] }));
      }
    },
    deco(body) {
      body.add(M(cone(0.12, 0.34, 10), '#ffc300', { pos: [0, 0.34, 1.62], rot: [Math.PI / 2, 0, 0] }));
      for (const s of [-1, 1]) for (const k of [0, 1, 2]) {
        body.add(M(boxG(0.04, 0.1, 0.3), '#6b4226', { pos: [s * 0.74, 0.42 - k * 0.05, -0.15 - k * 0.12], rot: [0.3, s * 0.3, 0], outline: false }));
      }
    },
  },
};

function kartWheel(r, w, rimColor) {
  const g = new THREE.Group();
  g.add(M(cyl(r, w, 'x'), '#222228'));
  g.add(M(cyl(r * 0.55, w + 0.02, 'x'), rimColor, { outline: false }));
  g.add(M(boxG(w + 0.04, r * 0.25, r * 1.1), '#33333b', { outline: false }));
  return g;
}

// ---------------- 메시 합치기 (드로우콜 절감) ----------------
const TOON_VC = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

function prepGeo(mesh, toGroup, color) {
  let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.applyMatrix4(_m.multiplyMatrices(toGroup, mesh.matrixWorld));
  if (color) {
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return g;
}

/**
 * group 안의 정적인 툰 메시들을 메시 1개(+외곽선 1개)로 합침.
 * keep 에 든 하위 오브젝트(따로 움직이는 부품)는 건드리지 않음.
 */
function bake(group, keep = []) {
  group.updateMatrixWorld(true);
  _inv.copy(group.matrixWorld).invert();
  const solid = [], outline = [], remove = [];
  const visit = (o) => {
    for (const c of [...o.children]) {
      if (keep.includes(c)) continue;
      if (c.isMesh && c.material === OUTLINE) continue; // 외곽선은 부모와 함께 처리
      if (c.isMesh && c.material?.isMeshToonMaterial && c.material !== TOON_VC) {
        solid.push(prepGeo(c, _inv, c.material.color));
        if (c.children.some((k) => k.material === OUTLINE)) outline.push(prepGeo(c, _inv, null));
        remove.push(c);
      } else if (!c.isMesh) visit(c);
    }
  };
  visit(group);
  for (const c of remove) c.parent.remove(c);
  if (solid.length) {
    const m = new THREE.Mesh(mergeGeometries(solid), TOON_VC);
    m.geometry.userData.owned = true; // 카트를 치울 때 해제
    m.castShadow = true;
    group.add(m);
  }
  if (outline.length) {
    const o = new THREE.Mesh(mergeGeometries(outline), OUTLINE);
    o.geometry.userData.owned = true;
    group.add(o);
  }
}

export function createKart({ color = '#e63946', character = 'panda' } = {}) {
  const ch = CHARACTERS[character] || CHARACTERS.panda;
  const style = KART_STYLES[character] || {};
  const root = new THREE.Group();
  root.rotation.order = 'YXZ'; // 방향(Y) 먼저, 그 다음 경사(X)
  const model = new THREE.Group();
  model.scale.setScalar(KART_SCALE);
  root.add(model);
  const body = new THREE.Group(); // 롤/피치 연출
  model.add(body);

  // 섀시 (공통) + 동물별 차체 모양. 바퀴·운전석·핸들 위치는 모두 같아서 게임에는 영향 없음
  body.add(M(chassisGeo, DARK, { pos: [0, 0.3, 0.1] }));
  (style.shell || defaultShell)(body, color);

  // 시트
  const seatColor = style.seat || '#3a3a46';
  body.add(M(boxG(0.6, 0.1, 0.5), seatColor, { pos: [0, 0.34, -0.38] }));
  body.add(M(boxG(0.62, 0.55, 0.1), seatColor, { pos: [0, 0.6, -0.68], rot: [-0.15, 0, 0] }));

  // 엔진 + 머플러 (부스터 불꽃이 나오는 위치 = exhausts)
  (style.engine || defaultEngine)(body, color);
  const exhausts = [];
  for (const [x, y, z] of style.exhaustTips || [[-0.2, 0.58, -1.4], [0.2, 0.58, -1.4]]) {
    const tip = new THREE.Object3D();
    tip.position.set(x, y, z);
    body.add(tip);
    exhausts.push(tip);
  }

  // 스포일러 + 동물별 장식
  (style.spoiler || defaultSpoiler)(body, color);
  style.deco?.(body, color);

  // 핸들
  body.add(M(cyl(0.03, 0.42), '#2a2a35', { pos: [0, 0.6, 0.55], rot: [0.75, 0, 0], outline: false }));
  const wheelMount = new THREE.Group();
  wheelMount.position.set(0, 0.78, 0.4);
  wheelMount.rotation.x = 0.5;
  const steeringWheel = new THREE.Group();
  steeringWheel.add(M(cached('swheel', () => new THREE.TorusGeometry(0.17, 0.035, 8, 22)), '#2a2a35'));
  steeringWheel.add(M(boxG(0.3, 0.04, 0.03), '#2a2a35', { outline: false }));
  steeringWheel.add(M(cyl(0.05, 0.05, 'z'), color, { outline: false }));
  wheelMount.add(steeringWheel);
  body.add(wheelMount);

  // 바퀴 (앞바퀴는 조향 피벗 안에)
  const wheels = [], pivots = [], rearWheels = [];
  for (const [x, z, front] of [[-0.74, 0.88, true], [0.74, 0.88, true], [-0.8, -0.8, false], [0.8, -0.8, false]]) {
    const r = front ? 0.28 : 0.34;
    const w = kartWheel(r, front ? 0.28 : 0.38, style.rim || color);
    if (front) {
      const p = new THREE.Group();
      p.position.set(x, r, z);
      p.add(w);
      model.add(p);
      pivots.push(p);
    } else {
      w.position.set(x, r, z);
      model.add(w);
      rearWheels.push(w);
    }
    wheels.push(w);
  }

  // ---------- 캐릭터 ----------
  const driver = new THREE.Group();
  driver.position.set(0, 0, -0.38);
  body.add(driver);

  for (const s of [-1, 1]) driver.add(M(capsule(0.1, 0.45, 'z'), ch.pants, { pos: [s * 0.14, 0.45, 0.4] })); // 다리
  driver.add(M(capsule(0.22, 0.22), ch.outfit, { pos: [0, 0.72, 0], rot: [-0.12, 0, 0] }));              // 몸통

  // 목도리 + 펄럭이는 꼬리
  driver.add(M(cached('scarf', () => new THREE.TorusGeometry(0.17, 0.06, 8, 18)), ch.scarf, { pos: [0, 0.98, 0], rot: [Math.PI / 2, 0, 0] }));
  const scarfTail = new THREE.Group();
  scarfTail.position.set(0.08, 0.98, -0.16);
  const tail = M(boxG(0.13, 0.03, 0.5), ch.scarf, { pos: [0, 0, -0.25] });
  scarfTail.add(tail);
  driver.add(scarfTail);

  // 머리
  const head = new THREE.Group();
  head.position.set(0, 1.5, 0.04);
  head.scale.setScalar(1.35); // 2등신 비율로 큰 머리
  head.add(M(sphere(R), ch.fur));
  ch.build(head);
  driver.add(head);

  // 팔 (어깨 피벗)
  const arms = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.27, 0.88, 0);
    pivot.add(M(capsule(0.075, 0.45), ch.outfit, { pos: [0, -0.32, 0] }));
    pivot.add(M(sphere(0.095), ch.glove, { pos: [0, -0.66, 0] }));
    pivot.userData.side = s;
    driver.add(pivot);
    arms.push(pivot);
  }

  // 물폭탄에 맞았을 때 감싸는 물방울
  const bubble = new THREE.Group();
  const bubbleMat = new THREE.MeshStandardMaterial({
    color: 0x7fd3ff, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.2,
    emissive: 0x1a5f9a, emissiveIntensity: 0.3, depthWrite: false, side: THREE.DoubleSide,
  });
  bubble.add(new THREE.Mesh(sphere(2.7), bubbleMat));
  const shine = new THREE.Mesh(sphere(0.45), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
  shine.position.set(-1.2, 1.3, 1.6);
  shine.scale.set(1, 0.6, 0.4);
  bubble.add(shine);
  bubble.position.y = 2.1;
  bubble.visible = false;
  root.add(bubble);

  // 함께 움직이는 부품끼리 합치기: 카트 1대 메시 약 118개 → 약 25개
  bake(head);
  for (const a of arms) bake(a);
  bake(scarfTail);
  bake(steeringWheel);
  for (const w of wheels) bake(w);
  bake(driver, [head, scarfTail, ...arms]);
  bake(body, [driver, wheelMount]);
  bake(wheelMount, [steeringWheel]);

  const headBaseY = head.position.y;
  const state = { armLift: 0 };

  return {
    root, model, body, wheels, pivots, rearWheels, exhausts, head, driver,
    /**
     * @param o.spin 바퀴 회전각, o.steer 조향(+왼쪽), o.roll/o.pitch 차체 기울기,
     *          o.speed 0~1 속도 비율, o.t 시간(초), o.cheer 만세 동작, o.look 고개 돌림
     */
    animate({ spin = 0, steer = 0, roll = 0, pitch = 0, speed = 0, t = 0, cheer = false, look = 0, dt = 0.016, spinAngle = 0, trapped = false, blast = 0 }) {
      // 피격 연출: 스핀(바나나) / 물방울에 떠오름(물폭탄)
      model.rotation.y = spinAngle;
      bubble.visible = trapped;
      model.position.y = trapped ? 0.8 + Math.sin(t * 3) * 0.15 : 0;
      // 미사일 피격: 공중으로 튀어올라 앞으로 한 바퀴 (blast: 0→1 진행도)
      model.rotation.x = blast > 0 ? -blast * Math.PI * 2 : 0;
      if (blast > 0) model.position.y = Math.sin(Math.PI * blast) * 4;
      if (trapped) {
        bubble.scale.set(1 + Math.sin(t * 7) * 0.04, 1 + Math.cos(t * 6) * 0.05, 1 + Math.sin(t * 5 + 1) * 0.04);
        bubble.rotation.y = t * 0.6;
      }
      if (spinAngle) look = Math.sin(t * 20) * 0.5; // 어지러워하기

      for (const w of wheels) w.rotation.x = spin;
      for (const p of pivots) p.rotation.y = steer;
      steeringWheel.rotation.z = -steer * 2.2;
      body.rotation.z = roll;
      body.rotation.x = pitch;

      // 코너 방향으로 몸 기울이고 고개 돌리기
      driver.rotation.z = -steer * 0.35;
      head.rotation.y = steer * 0.7 + look;
      if (trapped) head.rotation.y = Math.sin(t * 5) * 0.6; // 허우적
      head.rotation.z = -steer * 0.2;
      head.position.y = headBaseY + Math.sin(t * 14) * 0.012 * speed + (cheer ? Math.abs(Math.sin(t * 8)) * 0.06 : 0);

      // 목도리 펄럭임
      scarfTail.rotation.x = -1.25 + speed * 1.15 + Math.sin(t * 22) * 0.12 * speed;
      scarfTail.rotation.y = Math.sin(t * 13) * 0.18 * (0.3 + speed);

      // 팔: 평소엔 핸들, 만세 시 위로 흔들기
      state.armLift += ((cheer || trapped || blast > 0 ? 1 : 0) - state.armLift) * Math.min(1, dt * 8);
      const k = state.armLift;
      for (const a of arms) {
        const s = a.userData.side;
        a.rotation.x = -1.4 * (1 - k) + (-2.9 + Math.sin(t * 10 + s) * 0.25) * k;
        a.rotation.z = (-s * 0.18) * (1 - k) + s * 0.4 * k + steer * 0.25 * (1 - k);
      }
    },
  };
}

/** 카트 위에 떠 있는 닉네임 표시 */
export function createNameTag(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,12,20,0.6)';
  ctx.beginPath(); ctx.roundRect(4, 8, 248, 48, 14); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(14, 20, 10, 24, 4); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 138, 33, 210);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(4, 1, 1);
  sprite.position.y = 3.6;
  sprite.renderOrder = 10;
  return sprite;
}
