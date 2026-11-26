// 아이템 시스템: 아이템 박스, 바나나(뒤에 설치 → 밟으면 스핀), 물폭탄(앞으로 투척 → 착지 지점 주변 갇힘)
import * as THREE from 'three';

export const ITEM_INFO = {
  banana: { name: '바나나', emoji: '🍌' },
  bomb: { name: '물폭탄', emoji: '💧' },
  missile: { name: '미사일', emoji: '🚀' },
  charge: { name: '게이지 충전', emoji: '⚡' },
};
const BOX_RESPAWN = 4000;   // ms
const BOX_RADIUS = 2.6;
const BANANA_RADIUS = 2.1;
export const BOMB_FLIGHT = 1.15;  // s
export const BOMB_RANGE = 85;     // m 앞에 착지 (예전 48m 는 너무 짧았음)
export const SPLASH_RADIUS = 7.5;
const SPLASH_WINDOW = 0.35; // 착지 후 이 시간 동안 범위 안에 들어와도 갇힘
const MISSILE_SPEED = 95;     // m/s (부스터 최고속 74보다는 빠름)
const MISSILE_HOME_DIST = 35; // 목표가 이 거리 안이면 트랙을 벗어나 직진 추적
const MISSILE_LIFE = 10;      // s (게임 시간 기준 → 프레임이 느려도 비행 거리 동일)
const MISSILE_MAX_DIST = 480; // m 넘게 날면 폭발 (조준 끝 220m 의 보통 속도 목표는 닿고, 부스터로 도망가면 못 따라잡음)
const MISSILE_FREE_DIST = 300;// 목표 없이 쏘면 이만큼 직진 후 폭발
const MISSILE_TURN = 2.6;     // rad/s 최대 회전 → 타이밍 맞춘 급회전으로 빗나가게 할 수 있음
export const MISSILE_LOCK_RANGE = 220; // m 이내의 앞사람만 조준 (멀면 직진 발사)
export const MISSILE_HIT_RADIUS = 3;
export const MISSILE_HIT_HEIGHT = 1.5; // 미사일은 지면 가까이 날아감 → 점프대에서 뜨면(최고 약 1.9m) 아래로 지나감
export const BLOCK_RADIUS = 2.5;       // 바나나에 이 거리 안으로 닿으면 미사일이 막힘

function boxTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 128, 128);
  grd.addColorStop(0, '#ff6fae'); grd.addColorStop(0.5, '#ffd166'); grd.addColorStop(1, '#4cc9f0');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 8; g.strokeRect(4, 4, 120, 120);
  g.font = 'bold 92px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = '#2b2d42'; g.strokeText('?', 64, 70);
  g.fillStyle = '#fff'; g.fillText('?', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeBanana() {
  const g = new THREE.Group();
  const peel = new THREE.MeshStandardMaterial({ color: 0xffd84d, roughness: 0.5 });
  const tip = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.22, 10, 18, 2.3), peel);
  body.castShadow = true;
  g.add(body);
  const t1 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), tip);
  t1.position.set(0.6, 0, 0);
  const t2 = t1.clone();
  t2.position.set(Math.cos(2.3) * 0.6, Math.sin(2.3) * 0.6, 0);
  g.add(t1, t2);
  g.rotation.x = -Math.PI / 2;
  g.scale.setScalar(1.7);
  const wrap = new THREE.Group();
  wrap.add(g);
  g.position.y = 0.35;
  return wrap;
}

function makeMissile() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4, metalness: 0.3 });
  const red = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.9, 14).rotateX(Math.PI / 2), white);
  body.castShadow = true;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 14).rotateX(Math.PI / 2), red);
  nose.position.z = 1.3;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.2, 14).rotateX(Math.PI / 2), red);
  band.position.z = 0.3;
  g.add(body, nose, band);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.5), red);
    fin.position.set(0, 0.32, -0.75);
    const pivot = new THREE.Group();
    pivot.rotation.z = (k * Math.PI) / 2;
    pivot.add(fin);
    g.add(pivot);
  }
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
  glow.position.z = -1.0;
  g.add(glow);
  g.scale.setScalar(1.3);
  return g;
}

function makeBomb() {
  const g = new THREE.Group();
  const water = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x3aa0ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85, emissive: 0x0a3a7a, emissiveIntensity: 0.4 }));
  water.castShadow = true;
  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  shine.position.set(-0.35, 0.4, 0.55);
  const knot = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x1f6fd1 }));
  knot.position.y = 0.95;
  g.add(water, shine, knot);
  return g;
}

export class Items {
  constructor(scene, track, fx) {
    this.scene = scene;
    this.track = track;
    this.fx = fx;
    const tex = boxTexture();
    this.boxGeo = new THREE.BoxGeometry(1.8, 1.8, 1.8);
    this.boxMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.25, transparent: true, opacity: 0.92 });
    this.dummy = new THREE.Object3D();

    this.bananas = new Map();   // id → { obj, x, z, owner, t }
    this.bombs = [];            // 비행/착지 중인 물폭탄
    this.splashes = [];         // 물보라 링
    this.ringGeo = new THREE.RingGeometry(0.75, 1, 40).rotateX(-Math.PI / 2);
    this.missiles = [];
    this.getPos = () => null; // id → { x, z, hint } (main 에서 지정)
    this.setTrack(track);
  }

  /** 트랙이 바뀌면 깔린 아이템을 치우고 아이템 박스를 새 트랙에 맞춰 다시 배치 */
  setTrack(track) {
    if (this.boxMesh) { this.clear(); this.boxMesh.removeFromParent(); this.boxMesh.dispose(); }
    this.track = track;
    this.boxes = track.itemBoxPositions().map((p) => ({ ...p, hiddenUntil: 0 }));
    this.boxMesh = new THREE.InstancedMesh(this.boxGeo, this.boxMat, this.boxes.length);
    this.boxMesh.castShadow = true;
    this.boxMesh.frustumCulled = false;
    this.scene.add(this.boxMesh);
  }

  clear() {
    for (const b of this.bananas.values()) this.scene.remove(b.obj);
    this.bananas.clear();
    for (const b of this.bombs) this.scene.remove(b.obj);
    this.bombs = [];
    for (const s of this.splashes) this.scene.remove(s.mesh);
    this.splashes = [];
    for (const m of this.missiles) this.scene.remove(m.obj);
    this.missiles = [];
    for (const b of this.boxes) b.hiddenUntil = 0;
  }

  // ---------- 아이템 박스 ----------
  /** 내 카트가 닿은 박스 인덱스 (없으면 -1) */
  touchBox(x, z, now) {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.hiddenUntil > now) continue;
      if ((b.x - x) ** 2 + (b.z - z) ** 2 < BOX_RADIUS * BOX_RADIUS) return i;
    }
    return -1;
  }

  breakBox(i, now) {
    const b = this.boxes[i];
    if (!b || b.hiddenUntil > now) return;
    b.hiddenUntil = now + BOX_RESPAWN;
    const colors = [[1, 0.43, 0.68], [1, 0.82, 0.4], [0.3, 0.79, 0.94]];
    for (let k = 0; k < 24; k++) {
      const c = colors[k % 3];
      const a = Math.random() * Math.PI * 2;
      this.fx.glow.emit(b.x, b.y + 1.6, b.z, Math.cos(a) * 7, 3 + Math.random() * 5, Math.sin(a) * 7, 0.5, 0.7, 0.15, c[0], c[1], c[2], 1, 2);
    }
  }

  /** 도로 위 지점의 높이 */
  groundY(x, z) {
    const loc = this.track.locate(x, z);
    return this.track.groundAt(loc.f, loc.lateral);
  }

  // ---------- 바나나 ----------
  addBanana(id, x, z, owner, now) {
    if (this.bananas.has(id)) return;
    const obj = makeBanana();
    const y = this.groundY(x, z);
    obj.position.set(x, y, z);
    obj.rotation.y = Math.random() * Math.PI * 2;
    this.scene.add(obj);
    this.bananas.set(id, { obj, x, y, z, owner, t: now });
  }

  removeBanana(id) {
    const b = this.bananas.get(id);
    if (!b) return;
    this.scene.remove(b.obj);
    this.bananas.delete(id);
    for (let k = 0; k < 10; k++) {
      this.fx.glow.emit(b.x, b.y + 0.5, b.z, (Math.random() - 0.5) * 6, 2 + Math.random() * 3, (Math.random() - 0.5) * 6, 0.4, 0.6, 0.1, 1, 0.85, 0.3, 1, 2);
    }
  }

  /** 내 카트가 밟은 바나나 id (자기가 막 놓은 건 1.2초간 무시) */
  touchBanana(x, z, myId, now) {
    for (const [id, b] of this.bananas) {
      if (b.owner === myId && now - b.t < 1200) continue;
      if ((b.x - x) ** 2 + (b.z - z) ** 2 < BANANA_RADIUS * BANANA_RADIUS) return id;
    }
    return null;
  }

  // ---------- 물폭탄 ----------
  /** 트랙 인덱스 기준으로 BOMB_RANGE 앞 지점에 착지 (모든 클라이언트가 같은 경로를 계산) */
  throwBomb({ id, owner, x, z, idx, lat }, now) {
    if (this.bombs.some((b) => b.id === id)) return;
    const N = this.track.N;
    const li = (idx + Math.round(BOMB_RANGE / this.track.spacing)) % N;
    const p = this.track.points[li], s = this.track.sides[li];
    const l = Math.max(-6, Math.min(6, lat * 0.6));
    const obj = makeBomb();
    const sy = this.track.heightAt(idx) + 1.5, ey = this.track.height[li] + this.track.bank[li] * l;
    obj.position.set(x, sy, z);
    this.scene.add(obj);
    this.bombs.push({ id, owner, sx: x, sy, sz: z, ex: p.x + s.x * l, ey, ez: p.z + s.z * l, t0: now, obj, landed: false, landT: 0, hitMe: false });
  }

  /** 착지해서 효과가 유효한 물폭탄 목록 (프레임이 느려도 착지 직후 최소 1번은 판정) */
  activeSplashes(now) {
    return this.bombs.filter((b) => b.landed && (!b.checked || (now - b.landT) / 1000 < SPLASH_WINDOW));
  }

  // ---------- 미사일 ----------
  /** target: 추적할 플레이어 id (없으면 트랙을 따라 직진 후 폭발) */
  fireMissile({ id, owner, target, x, z, idx, lat }, now) {
    if (this.missiles.some((m) => m.id === id)) return;
    const obj = makeMissile();
    const y = this.track.heightAt(idx) + 1.4;
    obj.position.set(x, y, z);
    this.scene.add(obj);
    this.missiles.push({ id, owner, target: target ?? null, f: idx, lat, x, y, z, mode: 'track', age: 0, obj, dist: 0, heading: 0, waitAt: -1 });
  }

  /** 내가 쏜 미사일의 임시 id 를 서버 id 로 교체 */
  assignServerId(cid, id) {
    const m = this.missiles.find((v) => v.id === cid);
    if (m) m.id = id;
  }

  explodeMissile(id) {
    const i = this.missiles.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = this.missiles[i];
    this.missiles.splice(i, 1);
    this.scene.remove(m.obj);
    this.explosion(m.x, m.z, m.y - 1.4);
  }

  /** 바나나에 닿은 미사일 [미사일 id, 바나나 id] 목록 */
  blockedMissiles() {
    const out = [];
    for (const m of this.missiles) {
      if (typeof m.id !== 'number') continue;
      for (const [bid, b] of this.bananas) {
        if ((m.x - b.x) ** 2 + (m.z - b.z) ** 2 < BLOCK_RADIUS * BLOCK_RADIUS) { out.push([m.id, bid, m]); break; }
      }
    }
    return out;
  }

  /** 나를 노리는 미사일이 날아오는 중인지 */
  targeting(myId) {
    return this.missiles.some((m) => m.target === myId);
  }

  explosion(x, z, y = 0) {
    this.onExplosion?.(x, z);
    const fx = this.fx;
    for (let k = 0; k < 70; k++) {
      const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 12;
      const hot = Math.random() < 0.5;
      fx.glow.emit(x, y + 1.2, z, Math.cos(a) * sp, 3 + Math.random() * 12, Math.sin(a) * sp, 0.4 + Math.random() * 0.4, hot ? 1.6 : 1.0, 0.2,
        1, hot ? 0.75 : 0.4, hot ? 0.3 : 0.1, 1, 2.5);
    }
    for (let k = 0; k < 26; k++) {
      const a = Math.random() * Math.PI * 2;
      fx.smoke.emit(x + Math.cos(a), y + 1, z + Math.sin(a), Math.cos(a) * 5, 2 + Math.random() * 4, Math.sin(a) * 5, 1.4, 2, 6, 0.35, 0.33, 0.33, 0.7, 1.5);
    }
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffa94d, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(x, y + 0.1, z);
    this.scene.add(mesh);
    this.splashes.push({ mesh, t: 0 });
  }

  updateMissiles(dt, now) {
    const track = this.track, N = track.N;
    for (const m of [...this.missiles]) {
      const tp = m.target != null ? this.getPos(m.target) : null;
      const px = m.x, pz = m.z;
      const step = MISSILE_SPEED * dt;
      m.age += dt;
      if (m.mode === 'track') {
        // 트랙 중심선을 따라 비행 (코너를 돌아감)
        m.f = (m.f + step / track.spacing) % N;
        m.dist += step;
        let targetLat = 0;
        if (tp) {
          let ahead = tp.hint - m.f;
          if (ahead > N / 2) ahead -= N; else if (ahead < -N / 2) ahead += N;
          const loc = track.locate(tp.x, tp.z, tp.hint);
          targetLat = loc.lateral;
          if (ahead * track.spacing < MISSILE_HOME_DIST || Math.hypot(tp.x - m.x, tp.z - m.z) < MISSILE_HOME_DIST) m.mode = 'home';
        } else if (m.dist > MISSILE_FREE_DIST) {
          this.explodeMissile(m.id);
          continue;
        }
        m.lat += Math.max(-12 * dt, Math.min(12 * dt, targetLat - m.lat));
        const i = Math.floor(m.f) % N;
        const p = track.points[i], s = track.sides[i];
        m.x = p.x + s.x * m.lat;
        m.y = this.track.heightAt(m.f) + 1.4;
        m.z = p.z + s.z * m.lat;
      } else if (tp) {
        // 직진 추적: 한 번에 꺾을 수 있는 각도가 제한됨
        if (m.homeHeading == null) m.homeHeading = m.heading;
        let turn = Math.atan2(tp.x - m.x, tp.z - m.z) - m.homeHeading;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        m.homeHeading += Math.max(-MISSILE_TURN * dt, Math.min(MISSILE_TURN * dt, turn));
        m.x += Math.sin(m.homeHeading) * step;
        m.z += Math.cos(m.homeHeading) * step;
        m.dist += step;
        // 지면 가까이 낮게 → 점프하면 아래로 지나감
        const loc = track.locate(m.x, m.z, m.hint ?? Math.floor(m.f));
        m.hint = loc.index;
        m.y = track.heightAt(loc.f) + 1.2;
        // 빗나감: 가장 가까웠던 때보다 멀어지기 시작하면 0.4초 뒤 폭발
        const d = Math.hypot(tp.x - m.x, tp.z - m.z);
        m.closest = Math.min(m.closest ?? Infinity, d);
        if (m.closest < 12 && d > m.closest + 2) {
          m.missT = (m.missT || 0) + dt;
          if (m.missT > 0.4) { this.explodeMissile(m.id); continue; }
        }
      } else {
        this.explodeMissile(m.id);
        continue;
      }
      if (m.age > MISSILE_LIFE || m.dist > MISSILE_MAX_DIST) { this.explodeMissile(m.id); continue; }

      const mx = m.x - px, mz = m.z - pz;
      if (mx * mx + mz * mz > 1e-6) m.heading = Math.atan2(mx, mz);
      m.obj.position.set(m.x, m.y + Math.sin(now / 90) * 0.08, m.z);
      m.obj.rotation.set(0, m.heading, 0);
      m.obj.rotateZ(now / 120);
      // 꼬리 불꽃 + 연기
      const tx = m.x - Math.sin(m.heading) * 1.5, tz = m.z - Math.cos(m.heading) * 1.5;
      for (let k = 0; k < 2; k++) {
        this.fx.glow.emit(tx, m.y, tz, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0.18, 1.0, 0.2, 1, 0.6, 0.2, 1, 2);
      }
      this.fx.smoke.emit(tx, m.y, tz, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), 0.9, 0.6, 2.2, 0.85, 0.85, 0.88, 0.5, 1);
    }
  }

  splash(b) {
    this.onSplash?.(b.ex, b.ez);
    const fx = this.fx;
    for (let k = 0; k < 60; k++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
      fx.glow.emit(b.ex, b.ey + 0.6, b.ez, Math.cos(a) * sp, 4 + Math.random() * 9, Math.sin(a) * sp, 0.7, 0.9, 0.2, 0.45, 0.75, 1, 1, 1.5);
    }
    for (let k = 0; k < 24; k++) {
      const a = Math.random() * Math.PI * 2;
      fx.smoke.emit(b.ex + Math.cos(a) * 2, b.ey + 0.5, b.ez + Math.sin(a) * 2, Math.cos(a) * 5, 2, Math.sin(a) * 5, 0.9, 1.5, 4, 0.85, 0.93, 1, 0.6, 2);
    }
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0x6cc6ff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(b.ex, b.ey + 0.08, b.ez);
    this.scene.add(mesh);
    this.splashes.push({ mesh, t: 0 });
  }

  update(dt, now, time) {
    // 박스: 회전 + 둥실둥실
    const d = this.dummy;
    this.boxes.forEach((b, i) => {
      const visible = b.hiddenUntil <= now;
      const respawnPop = visible && now - b.hiddenUntil < 300 ? (now - b.hiddenUntil) / 300 : 1;
      d.position.set(b.x, b.y + 1.6 + Math.sin(time * 2 + i) * 0.25, b.z);
      d.rotation.set(time * 0.7 + i, time * 1.3 + i, 0);
      d.scale.setScalar(visible ? respawnPop : 0);
      d.updateMatrix();
      this.boxMesh.setMatrixAt(i, d.matrix);
    });
    this.boxMesh.instanceMatrix.needsUpdate = true;

    for (const b of this.bananas.values()) b.obj.children[0].rotation.z = Math.sin(time * 3 + b.x) * 0.15;

    // 물폭탄 비행 (포물선)
    for (const b of this.bombs) {
      const u = (now - b.t0) / 1000 / BOMB_FLIGHT;
      if (!b.landed) {
        const k = Math.min(1, u);
        b.obj.position.set(b.sx + (b.ex - b.sx) * k, b.sy * (1 - k) + (b.ey + 0.9) * k + 14 * 4 * k * (1 - k), b.sz + (b.ez - b.sz) * k);
        b.obj.rotation.x += dt * 6;
        if (u >= 1) {
          b.landed = true;
          b.landT = now;
          this.scene.remove(b.obj);
          this.splash(b);
        }
      }
    }
    this.bombs = this.bombs.filter((b) => !b.landed || now - b.landT < 1500);
    this.updateMissiles(dt, now);

    for (const s of this.splashes) {
      s.t += dt;
      const k = s.t / 0.7;
      s.mesh.scale.setScalar(1 + k * SPLASH_RADIUS);
      s.mesh.material.opacity = 0.8 * (1 - k);
    }
    this.splashes = this.splashes.filter((s) => {
      if (s.t < 0.7) return true;
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
      return false;
    });
  }
}
