// 간단한 파티클 시스템 (드리프트 연기/불꽃, 부스터 화염)
import * as THREE from 'three';

const sprite = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

export class Particles {
  constructor(scene, max, additive = false) {
    this.max = max;
    this.i = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: sprite }, uScale: { value: 500 } },
      vertexShader: `
        attribute vec3 pcolor; attribute float alpha; attribute float size;
        varying vec3 vColor; varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = pcolor; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, drag = 1) {
    const i = this.i;
    this.i = (i + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b], i * 3);
    this.life[i] = this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a; this.drag[i] = drag;
  }

  update(dt, camera, renderer) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]); // 1 → 0
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] *= d; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.a0[i] * k;
      this.size[i] = this.s1[i] + (this.s0[i] - this.s1[i]) * k;
    }
    for (const n of ['position', 'pcolor', 'alpha', 'size']) this.geo.attributes[n].needsUpdate = true;
    this.mat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
}

const _v = new THREE.Vector3();

/** 카트 상태에 따른 이펙트 방출 */
export class KartFx {
  constructor(scene) {
    this.smoke = new Particles(scene, 600, false);
    this.glow = new Particles(scene, 900, true);
  }

  emitFor(kart, { drifting, boosting, slip = 0, charge = 0, speed = 0 }, dt) {
    const h = kart.root.rotation.y;
    const fx = Math.sin(h), fz = Math.cos(h);
    const rnd = (s) => (Math.random() - 0.5) * s;

    if (drifting || Math.abs(slip) > 6) {
      for (const w of kart.rearWheels) {
        w.getWorldPosition(_v);
        if (Math.random() < dt * 45) {
          this.smoke.emit(_v.x + rnd(0.4), _v.y, _v.z + rnd(0.4), -fx * 2 + rnd(2), 1 + Math.random(), -fz * 2 + rnd(2), 0.9, 0.9, 3.2, 0.92, 0.92, 0.95, 0.55, 1.5);
        }
        if (drifting) {
          // 드리프트가 길어질수록 노랑 → 주황 → 파랑 불꽃
          const c = charge < 0.6 ? [1, 0.85, 0.3] : charge < 1.4 ? [1, 0.5, 0.15] : [0.35, 0.7, 1];
          const n = Math.random() < dt * 60 ? 2 : 0;
          for (let k = 0; k < n; k++) {
            this.glow.emit(_v.x, _v.y - 0.2, _v.z, -fx * 4 + rnd(6), 2 + Math.random() * 3, -fz * 4 + rnd(6), 0.25 + Math.random() * 0.15, 0.45, 0.1, c[0], c[1], c[2], 1, 2);
          }
        }
      }
    }

    if (boosting) {
      for (const e of kart.exhausts) {
        e.getWorldPosition(_v);
        for (let k = 0; k < 3; k++) {
          const blue = Math.random() < 0.35;
          this.glow.emit(_v.x + rnd(0.15), _v.y + rnd(0.15), _v.z + rnd(0.15),
            -fx * (6 + speed * 0.3) + rnd(1.5), rnd(1.5), -fz * (6 + speed * 0.3) + rnd(1.5),
            0.18 + Math.random() * 0.12, blue ? 0.9 : 1.3, 0.2,
            blue ? 0.4 : 1, blue ? 0.75 : 0.55, blue ? 1 : 0.15, 1, 3);
        }
      }
    }
  }

  update(dt, camera, renderer) {
    this.smoke.update(dt, camera, renderer);
    this.glow.update(dt, camera, renderer);
  }
}

/** 빙하 구역 눈 내림 (카메라 주변에서만) */
export class Snow {
  constructor(scene, count = 1800) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) this.pos.set([(Math.random() - 0.5) * 140, Math.random() * 50, (Math.random() - 0.5) * 140], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.45, map: sprite, transparent: true, opacity: 0, depthWrite: false });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(dt, camera, amount, time) {
    this.mat.opacity = Math.min(1, amount * 1.4);
    this.points.visible = amount > 0.02;
    if (!this.points.visible) return;
    const cx = camera.position.x, cz = camera.position.z;
    const p = this.pos;
    for (let i = 0; i < this.count; i++) {
      let x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      y -= dt * (4 + (i % 7) * 0.4);
      x += Math.sin(time + i) * dt * 0.8;
      // 카메라 주변 140m 박스 안에서 순환
      if (y < 0) y += 50;
      if (x - cx > 70) x -= 140; else if (x - cx < -70) x += 140;
      if (z - cz > 70) z -= 140; else if (z - cz < -70) z += 140;
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
