// 그래픽 품질 / 후처리 / 하늘
// - 높음: 앰비언트 오클루전(구석·틈의 부드러운 음영) + 은은한 블룸 + MSAA + 부드러운 그림자 + 디테일 많은 배경
// - 낮음: 폰·저사양용 (후처리 없음, 그림자 해상도↓, 배경 단순)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const KEY = 'racer-quality';

/** 저장된 품질, 없으면 기기에 맞게 (터치 기기·작은 화면은 낮음). ?quality=low|high 로 강제 가능 */
export function initialQuality() {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'high') return q;
  try { const s = localStorage.getItem(KEY); if (s === 'low' || s === 'high') return s; } catch {}
  const weak = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
  return weak ? 'low' : 'high';
}

export class Graphics {
  constructor(renderer, scene, camera, sun) {
    Object.assign(this, { renderer, scene, camera, sun, composer: null, quality: null });
  }

  setQuality(q, save = true) {
    if (q === this.quality) return;
    this.quality = q;
    if (save) { try { localStorage.setItem(KEY, q); } catch {} }
    const high = q === 'high';
    const r = this.renderer;
    // 밝은 곳도 색이 바래지 않는 톤매핑 (ACES 는 흰색 쪽으로 날아가서 뿌옇게 보였음)
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 0.92;
    r.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1.25));
    r.shadowMap.type = high ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const size = high ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null; // 다음 렌더에서 새 크기로 만듦
    }
    this.sun.shadow.radius = high ? 3 : 1;
    r.shadowMap.needsUpdate = true;
    this.composer?.dispose?.();
    this.composer = null;
    if (high) this.buildComposer();
  }

  buildComposer() {
    const r = this.renderer, w = innerWidth, h = innerHeight;
    // MSAA 가 되는 렌더 타깃 (후처리를 쓰면 캔버스 기본 안티에일리어싱이 안 먹음)
    const rt = new THREE.WebGLRenderTarget(w * r.getPixelRatio(), h * r.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(r, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    const ao = new GTAOPass(this.scene, this.camera, w, h);
    ao.blendIntensity = 0.7;
    ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    ao.updatePdMaterial({ radius: 6, rings: 2, samples: 12 });
    c.addPass(ao);
    c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.18, 0.4, 1.8)); // 부스터 불꽃·번개처럼 아주 밝은 것만 살짝 번짐 (흰 바닥은 안 번짐)
    c.addPass(new OutputPass());
    this.composer = c;
    this.ao = ao;
  }

  setSize(w, h) {
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

const SKY_TOP = new THREE.Color(0x3a7fd4);

// ---------------- 하늘: 위는 짙은 파랑, 지평선은 구역 하늘색 + 해 주변 빛 + 구름 ----------------
export function createSky(scene) {
  const uniforms = {
    top: { value: new THREE.Color(0x4a8fd8) },
    bottom: { value: new THREE.Color(0xa8d8f0) },
    sunDir: { value: new THREE.Vector3(0.4, 0.75, 0.3).normalize() },
  };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 col = mix(bottom, top, pow(smoothstep(0.0, 1.0, h), 0.65));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.9, 0.7) * (pow(s, 64.0) * 0.6 + pow(s, 6.0) * 0.12); // 해 주변이 은은하게 밝음
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  scene.add(dome);

  // 구름: 둥근 덩어리를 뭉친 흰 구름 몇십 개가 천천히 흘러감
  const rand = (() => { let s = 99; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const blob = new THREE.IcosahedronGeometry(1, 2);
  const parts = [];
  for (let k = 0; k < 7; k++) {
    const g = blob.clone();
    const sc = 0.6 + rand() * 0.7;
    g.scale(sc * 1.3, sc * 0.75, sc);
    g.translate((k - 3) * 0.95 + (rand() - 0.5) * 0.6, (rand() - 0.3) * 0.5, (rand() - 0.5) * 1.2);
    parts.push(g);
  }
  const cloudGeo = mergeSimple(parts);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xdfe9f5, emissiveIntensity: 0.55, fog: false });
  const N = 34;
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, N);
  clouds.frustumCulled = false;
  const data = [];
  for (let k = 0; k < N; k++) data.push({ a: rand() * Math.PI * 2, r: 900 + rand() * 900, y: 260 + rand() * 260, s: 30 + rand() * 40 });
  scene.add(clouds);
  const d = new THREE.Object3D();
  let drift = 0;

  return {
    uniforms,
    update(camera, horizon, dt) {
      dome.position.copy(camera.position);
      uniforms.bottom.value.copy(horizon);
      // 위쪽은 지평선 색보다 진하고 파랗게
      uniforms.top.value.copy(horizon).lerp(SKY_TOP, 0.7);
      drift += dt * 0.004;
      data.forEach((c, k) => {
        d.position.set(camera.position.x + Math.cos(c.a + drift) * c.r, c.y, camera.position.z + Math.sin(c.a + drift) * c.r);
        d.rotation.set(0, c.a, 0);
        d.scale.setScalar(c.s);
        d.updateMatrix();
        clouds.setMatrixAt(k, d.matrix);
      });
      clouds.instanceMatrix.needsUpdate = true;
    },
  };
}

/** 인덱스 있는 지오메트리끼리 합치기 (위치·법선만) */
function mergeSimple(geos) {
  const pos = [], nor = [], idx = [];
  let off = 0;
  for (const g of geos) {
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    if (g.index) for (const i of g.index.array) idx.push(i + off);
    else for (let i = 0; i < g.attributes.position.count; i++) idx.push(i + off);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
