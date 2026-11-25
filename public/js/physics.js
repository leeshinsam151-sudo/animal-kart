// 아케이드 카트 물리
// - 자전거 모델 조향 + 횡방향 그립으로 미끄러짐 표현
// - 드리프트(Shift): 그립↓ 회전↑, 미끄러지는 동안 부스터 게이지 충전
// - 부스터(Space): 게이지가 차면 얻는 아이템, 사용 시 일정 시간 최고속도/가속 증가
import { ROAD_HALF, CURB_W, WALL_DIST } from './track.js';

const MAX_SPEED = 56;       // m/s (~200 km/h)
const BOOST_MAX = 74;
const BOOST_OFFROAD_MAX = 40;
const ACCEL = 22;
const BOOST_ACCEL = 42;
const BRAKE = 40;
const REVERSE_MAX = 12;
const REVERSE_ACCEL = 10;
const WHEELBASE = 2.6;
const MAX_STEER = 0.6;
const GRAVITY = 32;            // 아케이드 중력 (m/s²) - 점프가 너무 둥둥 뜨지 않게
const SLOPE_FORCE = 6;         // 오르막 감속 / 내리막 가속 세기
const MAX_LAUNCH_VY = 11;      // 점프 발사 속도 상한 (부스터로 달려도 너무 높이 뜨지 않게)
const MAX_YAW = 1.75;          // 일반 주행 최대 회전 속도 (rad/s ≈ 100°/s)
const YAW_RAMP_IN = 3.5;       // 키를 누를 때 회전이 붙는 속도 (작을수록 부드러움, 약 0.3초)
const YAW_RAMP_OUT = 9;        // 키를 뗄 때 똑바로 돌아오는 속도
const CAR_HALF_W = 1.4;
export const CAR_RADIUS = 1.4;
const CAR_JUMP_CLEAR = 1.6;   // 높이 차가 이보다 크면 카트끼리 안 부딪힘 (점프로 넘어가기)
export const BUMP_K = 0.6;   // 충돌 반발 (0.5 = 붙어서 같이 감, 1 = 당구공처럼 튕김)
export const TOP_SPEED = MAX_SPEED;
export const BOOST_TIME = 2.2;
export const MAX_ITEMS = 2;
const GAUGE_RATE = 0.5;     // 드리프트 약 2초 = 부스터 1개
export const SPIN_TIME = 1.2;   // 바나나 스핀 시간
export const TRAP_TIME = 1.8;   // 물폭탄 갇힘 시간
export const BLAST_TIME = 1.5;  // 미사일 피격 (공중 회전) 시간

function track_groundAt(track, loc) { return track.groundAt(loc.f, loc.lateral); }

export class CarController {
  constructor(track) {
    this.track = track;
    this.x = 0; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.heading = 0;
    this.steer = 0;
    this.vF = 0;
    this.accel = 0;
    this.slip = 0;
    this.spin = 0;
    this.hint = -1;
    this.lastF = 0;
    this.progressRaw = 0;
    this.offroad = false;
    this.wrongWay = false;
    this.impact = 0;
    // 드리프트 / 부스터
    this.drifting = false;
    this.driftDir = 0;
    this.driftTime = 0;
    this.gauge = 0;
    this.items = 0;
    this.boostTime = 0;
    this.prevBoostKey = false;
    this.onItem = null; // 아이템 획득 콜백
    // 피격 상태
    this.spinTime = 0;
    this.trapTime = 0;
    this.blastTime = 0;
    this.yawRate = 0;      // 현재 회전 속도 (부드럽게 변함)
    this.steerScale = 1;   // 조향 감도 (설정에서 0.6~1.4)
    // 높이 / 점프
    this.y = 0;
    this.vy = 0;
    this.air = false;
    this.airTime = 0;
    this.groundY = 0;
    this.roll = 0;
    this.groundVy = 0;
    this.slope = 0;        // 진행 방향 기준 경사 (+ 오르막)
    this.landing = 0;      // 착지 충격 (연출용, 0~1)
  }

  reset(x, z, heading) {
    Object.assign(this, { x, z, heading, vx: 0, vz: 0, vF: 0, steer: 0, impact: 0, gauge: 0, items: 0, boostTime: 0, drifting: false, spinTime: 0, trapTime: 0, blastTime: 0, yawRate: 0 });
    const loc = this.track.locate(x, z);
    this.hint = loc.index;
    this.lastF = loc.f;
    this.y = this.groundY = track_groundAt(this.track, loc);
    this.vy = 0; this.air = false;
    // 출발선 뒤에서 시작하므로 음수 진행도
    this.progressRaw = loc.f > this.track.N / 2 ? loc.f - this.track.N : loc.f;
  }

  /** 트랙 중앙으로 복귀 (진행도 유지) */
  respawn() {
    const i = this.hint;
    const p = this.track.points[i], t = this.track.tangents[i];
    this.x = p.x; this.z = p.z;
    this.vx = this.vz = this.vF = 0;
    this.yawRate = 0;
    this.boostTime = 0;
    this.heading = Math.atan2(t.x, t.z);
    this.y = this.groundY = this.track.height[i];
    this.vy = 0; this.air = false;
    const N = this.track.N;
    let d = i - this.lastF;
    if (d > N / 2) d -= N; else if (d < -N / 2) d += N;
    this.progressRaw += d;
    this.lastF = i;
  }

  /** 완주 랩 수 기준 진행도 (1.0 = 1랩) */
  get progress() { return this.progressRaw / this.track.N; }
  get boosting() { return this.boostTime > 0; }
  get stunned() { return this.spinTime > 0 || this.trapTime > 0 || this.blastTime > 0; }

  /** 바나나: 빙글빙글 돌며 감속 */
  spinOut() {
    if (this.trapTime > 0 || this.blastTime > 0) return;
    this.spinTime = SPIN_TIME;
    this.boostTime = 0;
    this.drifting = false;
  }

  /** 미사일: 폭발로 공중에 떠서 한 바퀴 돌고 거의 정지 */
  blast() {
    this.blastTime = BLAST_TIME;
    this.spinTime = 0;
    this.trapTime = 0;
    this.boostTime = 0;
    this.drifting = false;
  }

  /** 물폭탄: 물방울에 갇혀 정지 */
  trap() {
    if (this.blastTime > 0) return;
    this.trapTime = TRAP_TIME;
    this.spinTime = 0;
    this.boostTime = 0;
    this.drifting = false;
  }

  update(dt, inp) {
    // 피격 중엔 조작 불가 + 감속
    if (this.stunned) {
      const damp = Math.exp(-(this.trapTime > 0 ? 7 : this.blastTime > 0 ? 3.5 : 2.2) * dt);
      this.vx *= damp; this.vz *= damp;
      this.spinTime = Math.max(0, this.spinTime - dt);
      this.trapTime = Math.max(0, this.trapTime - dt);
      this.blastTime = Math.max(0, this.blastTime - dt);
      inp = { throttle: false, brake: false, left: false, right: false, drift: false, boost: false };
      this.prevBoostKey = true;
    }
    const zone = this.track.zoneAt(Math.max(0, this.hint));
    const h = this.heading;
    const fx = Math.sin(h), fz = Math.cos(h);     // 전방
    const rx = -Math.cos(h), rz = Math.sin(h);    // 오른쪽
    let vF = this.vx * fx + this.vz * fz;
    let vR = this.vx * rx + this.vz * rz;
    const speed = Math.abs(vF);
    const steerIn = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);

    // 부스터 사용 (키를 누르는 순간 1회)
    if (inp.boost && !this.prevBoostKey && this.items > 0) {
      this.items--;
      this.boostTime = BOOST_TIME;
    }
    this.prevBoostKey = inp.boost;
    const boosting = this.boostTime > 0;
    this.boostTime = Math.max(0, this.boostTime - dt);

    // 드리프트: Shift + 방향키로 진입, 진입 방향 고정. Shift 를 떼거나 느려지면 종료
    if (!this.drifting && !this.air && inp.drift && steerIn !== 0 && vF > 14) {
      this.drifting = true;
      this.driftDir = steerIn;
    } else if (this.drifting && (!inp.drift || vF < 8)) {
      this.drifting = false;
    }
    this.driftTime = this.drifting ? this.driftTime + dt : 0;

    const maxF = boosting ? (this.offroad ? BOOST_OFFROAD_MAX : BOOST_MAX) : this.offroad ? zone.offroadMax : MAX_SPEED;

    // 가속/제동
    let a = 0;
    if (inp.throttle || boosting) a += vF < -0.5 ? BRAKE : ACCEL * Math.max(0, 1 - (vF / maxF) ** 2);
    if (boosting && vF < maxF) a += BOOST_ACCEL;
    if (inp.brake && !boosting) a -= vF > 0.5 ? BRAKE : vF > -REVERSE_MAX ? REVERSE_ACCEL : 0;
    if (this.air) a *= 0.25;                        // 공중에선 바퀴가 안 닿음
    else a -= SLOPE_FORCE * this.slope;             // 오르막 감속, 내리막 가속
    this.accel = a;

    if (this.drifting) {
      // ---- 드리프트: 카트는 빠르게 돌고, 진행 방향은 카트 방향을 천천히 따라감 (속도는 대부분 유지)
      const same = steerIn === this.driftDir;
      const yawTarget = this.driftDir * (same ? 2.1 : steerIn === 0 ? 1.25 : 0.55) * Math.min(1, speed / 25) * this.steerScale;
      this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * 5);
      this.steer += (this.driftDir * MAX_STEER * 0.5 - this.steer) * Math.min(1, dt * 8);
      this.heading += this.yawRate * dt;

      let v = Math.hypot(this.vx, this.vz);
      v += a * dt;
      v -= v * (0.18 + (this.offroad ? 0.9 : 0)) * dt;
      if (v > maxF) v -= (v - maxF) * 1.5 * dt;
      let va = Math.atan2(this.vx, this.vz);
      let d = this.heading - va;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      va += d * (1 - Math.exp(-3.6 * (0.6 + 0.4 * zone.grip) * dt)); // 빙판에선 더 미끄러짐
      this.vx = Math.sin(va) * v;
      this.vz = Math.cos(va) * v;
      this.slip = this.vx * rx + this.vz * rz;

      // 미끄러지는 각도가 클수록 게이지가 빨리 참
      const slipAngle = Math.abs(d);
      if (v > 10) this.gauge += dt * GAUGE_RATE * Math.min(1, slipAngle / 0.35);
    } else {
      // ---- 일반 주행: 자전거 모델 + 횡그립
      vF += a * dt;
      const drag = 0.12 + (this.offroad ? 0.9 : 0) + (inp.throttle || inp.brake || boosting ? 0 : 0.25);
      vF -= vF * drag * dt;
      if (vF > maxF) vF -= (vF - maxF) * 1.5 * dt;
      if (!inp.throttle && !inp.brake && !boosting && Math.abs(vF) < 0.3) vF = 0;

      // 조향: 저속에선 자전거 모델, 고속에선 최대 회전 속도로 제한.
      // 회전은 서서히 붙고(톡 누르면 살짝) 키를 떼면 빠르게 풀림
      const yawCap = Math.min((Math.abs(vF) / WHEELBASE) * Math.tan(MAX_STEER), MAX_YAW * this.steerScale) * (this.air ? 0.6 : 1);
      const yawTarget = steerIn * yawCap * Math.sign(vF);
      const rampIn = steerIn !== 0 && Math.sign(yawTarget) === Math.sign(this.yawRate || yawTarget) && Math.abs(yawTarget) > Math.abs(this.yawRate);
      this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * (rampIn ? YAW_RAMP_IN : YAW_RAMP_OUT));
      this.heading += this.yawRate * dt;
      // 앞바퀴/캐릭터 연출용 조향각
      this.steer = Math.max(-1, Math.min(1, this.yawRate / MAX_YAW)) * MAX_STEER * 0.6 * Math.sign(vF || 1);

      // 횡방향 미끄러짐 감쇠. 깎인 횡속도 일부를 전진 속도로 돌려줌 (드리프트 탈출 후 속도 유지)
      const grip = (this.offroad ? 4 : 8) * zone.grip; // 빙하 구역은 그립이 낮음
      const lost = Math.abs(vR) * (1 - Math.exp(-grip * dt));
      const speedBefore = Math.hypot(vF, vR);
      vR *= Math.exp(-grip * dt);
      // 단, 전체 속력이 늘어나면 안 됨 (코너를 돌수록 빨라지는 버그 방지)
      if (vF > 0) vF = Math.min(vF + lost * 0.6, Math.sqrt(Math.max(0, speedBefore * speedBefore - vR * vR)));
      this.slip = vR;

      // 이전 축으로 다시 합성 → 다음 프레임에 새 방향 기준으로 미끄러짐이 생김
      this.vx = fx * vF + rx * vR;
      this.vz = fz * vF + rz * vR;
    }

    if (this.gauge >= 1) {
      if (this.items < MAX_ITEMS) { this.items++; this.gauge = 0; this.onItem?.(); }
      else this.gauge = 1;
    }

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    this.collideTrack();
    this.updateVertical(dt);
    this.vF = this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);
    this.spin += (this.vF * dt) / 0.5;
    this.impact = Math.max(0, this.impact - dt * 3);
  }

  collideTrack() {
    const track = this.track;
    const loc = track.locate(this.x, this.z, this.hint);
    this.hint = loc.index;
    const abs = Math.abs(loc.lateral);
    this.offroad = abs > ROAD_HALF + CURB_W;

    const limit = WALL_DIST - CAR_HALF_W;
    if (abs > limit) {
      const sgn = Math.sign(loc.lateral);
      const s = track.sides[loc.index];
      const push = abs - limit;
      this.x -= s.x * sgn * push;
      this.z -= s.z * sgn * push;
      const vn = (this.vx * s.x + this.vz * s.z) * sgn;
      if (vn > 0) {
        this.vx -= s.x * sgn * vn * 1.3;
        this.vz -= s.z * sgn * vn * 1.3;
        this.vx *= 0.93; this.vz *= 0.93;
        this.impact = Math.min(1, this.impact + vn / 20);
      }
    }

    // 진행도 누적 (역주행이면 감소)
    const N = track.N;
    let d = loc.f - this.lastF;
    if (d > N / 2) d -= N; else if (d < -N / 2) d += N;
    this.progressRaw += d;
    this.lastF = loc.f;

    const t = track.tangents[loc.index];
    const fwdDot = Math.sin(this.heading) * t.x + Math.cos(this.heading) * t.z;
    this.wrongWay = fwdDot < -0.3 && this.vF > 3;

    this.groundY = track_groundAt(track, loc);
    this.slope = track.slopeAt(loc.f) * fwdDot;
    this.roll = -track.bankAt(loc.f) * Math.sign(fwdDot || 1); // 기울어진 커브에서 카트도 옆으로 기울어짐
    // 지면을 따라 달릴 때의 수직 속도 = 경사 × 트랙 방향 속도 (위치 차이로 구하면 잡음이 생김)
    const vAlong = this.vx * t.x + this.vz * t.z;
    this.groundVy = track.groundSlopeAt(loc.f, loc.lateral) * vAlong;
  }

  /** 높이: 지면을 따라가다가, 지면이 포물선보다 빨리 꺼지면(점프대 끝, 언덕 꼭대기) 공중으로 */
  updateVertical(dt) {
    const ground = this.groundY;
    this.landing = Math.max(0, this.landing - dt * 4);
    this.landCooldown = Math.max(0, (this.landCooldown || 0) - dt);
    if (!this.air) {
      // 지면이 포물선보다 빨리 꺼지면(점프대 끝, 급한 언덕 꼭대기) 공중으로.
      // 단, 착지 직후 0.3초는 언덕 때문에 다시 뜨지 않음 (뜨고-착지-뜨고 반복으로 화면이 떨리는 것 방지)
      const crest = this.landCooldown <= 0 && this.groundVy < this.vy - GRAVITY * dt * 1.3;
      // 갑자기 꺼짐(점프대 끝): 경사를 따라 내려갈 때 예상되는 높이보다 0.15m 이상 낮으면
      const falling = crest || ground < this.y + this.vy * dt - 0.15;
      if (falling && this.vF > 12) {
        this.air = true;
        this.airTime = 0;
        this.vy = Math.min(this.vy, MAX_LAUNCH_VY);
      } else {
        this.vy = this.groundVy;
        this.y = ground;
        return;
      }
    }
    this.airTime += dt;
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;
    if (this.y <= ground) {
      // 착지
      this.landing = Math.min(1, Math.max(0, -this.vy - 4) / 14);
      this.impact = Math.min(1, this.impact + this.landing * 0.5);
      this.y = ground;
      this.vy = this.groundVy; // 경사면에 착지하면 경사를 따라가는 속도로 (연속 튀어오름 방지)
      this.air = false;
      this.landCooldown = 0.3;
    }
  }

  /**
   * 다른 카트와 원형 충돌. 높이 차가 크면(점프로 넘어감) 무시.
   * 부딪혔으면 { nx, nz, speed } 반환 (n: 상대 → 나 방향, speed: 부딪힌 속도). 아니면 null
   * impulse=false 면 겹침만 풀고 속도는 그대로 (상대가 보낸 충돌 알림으로 이미 튕긴 경우)
   */
  collideWith(ox, oz, ovx = 0, ovz = 0, oy = this.y, impulse = true) {
    if (Math.abs(this.y - oy) > CAR_JUMP_CLEAR) return null;
    const dx = this.x - ox, dz = this.z - oz;
    const d = Math.hypot(dx, dz);
    const min = CAR_RADIUS * 2;
    if (d >= min || d < 1e-4) return null;
    const nx = dx / d, nz = dz / d;
    this.x += nx * (min - d);
    this.z += nz * (min - d);
    const rel = (this.vx - ovx) * nx + (this.vz - ovz) * nz;
    if (rel >= 0) return null; // 이미 멀어지는 중
    if (impulse) this.bump(nx * -rel * BUMP_K, nz * -rel * BUMP_K);
    return { nx, nz, speed: -rel };
  }

  /** 충돌로 튕겨 나감 (상대 클라이언트가 보낸 충돌 알림에도 사용) */
  bump(ix, iz) {
    this.vx += ix;
    this.vz += iz;
    this.impact = Math.min(1, this.impact + Math.hypot(ix, iz) / 15);
  }
}
