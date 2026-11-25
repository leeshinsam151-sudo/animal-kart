// 원격 카트 보간 (렌더링/Three.js 와 무관한 순수 로직 → 단위 테스트 가능)
// - 서버가 붙여 보낸 시각(t)으로 스냅샷을 정렬해서, 패킷이 몰려 와도 간격이 고르게 유지됨
// - 네트워크 흔들림(jitter)을 추정해서 보간 지연을 자동 조절
// - 데이터가 잠깐 끊기면 마지막 속도로 짧게 예측 이동
export const INTERP_MIN = 100;   // 보간 지연 최소 (ms)
export const INTERP_MAX = 450;   // 보간 지연 최대 (ms) - 나쁜 회선에서만 이만큼 늘어남
export const EXTRAP_MAX = 250;   // 예측 이동 최대 시간 (ms)
export const LEGACY_DELAY = 110; // 이전 방식(받은 시각 기준) 지연
export const LEAD_MAX = 0.35;     // 현재 위치 예측 최대 시간 (s) - 이보다 길면 예측이 부정확

export const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class NetClock {
  constructor() {
    this.offset = null;   // 내 시계 - 서버 시계 (가장 빨리 도착한 패킷 기준)
    this.jitter = 20;     // 늦게 도착하는 정도의 평균 (ms)
    this.delay = 120;     // 현재 보간 지연 (ms)
    this.useServerTime = true;
    this.extrapolate = true;
  }

  /** 스냅샷의 서버 시각 → 내 시계 기준 시각 */
  arrival(serverT, now) {
    if (serverT == null || !this.useServerTime) return now;
    const sample = now - serverT;
    if (this.offset == null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.002; // 시계가 천천히 어긋나는 것 보정
    this.jitter += (Math.max(0, sample - this.offset) - this.jitter) * 0.05;
    this.delay = Math.min(INTERP_MAX, Math.max(INTERP_MIN, 60 + this.jitter * 2));
    return serverT + this.offset;
  }

  /** 지금 화면에 그릴 시각 (조금 과거를 그려서 그 사이를 보간) */
  renderTime(now) {
    return now - (this.useServerTime ? this.delay : LEGACY_DELAY);
  }
}

/**
 * 버퍼(시간순 스냅샷 배열)에서 rt 시각의 상태를 구함. 지난 항목은 버퍼에서 정리.
 * 항목: { t, x, z, ry, sp, st, fl, y }
 */
export function sampleAt(buf, rt, extrapolate = true) {
  if (!buf.length) return null;
  while (buf.length > 2 && buf[1].t <= rt) buf.shift();
  const a = buf[0], c = buf[1];
  // 두 스냅샷 사이 방향 변화로 회전 속도(rad/s) 추정 → 곡선 예측에 사용
  const w = c ? (lerpAngle(a.ry, c.ry, 1) - a.ry) / Math.max(0.001, (c.t - a.t) / 1000) : 0;
  // 높이 변화 속도 (점프 중 높이를 앞당겨 그릴 때 사용)
  const vy = c && a.y != null && c.y != null ? (c.y - a.y) / Math.max(0.001, (c.t - a.t) / 1000) : 0;
  if (c && rt >= a.t && rt <= c.t) {
    const k = (rt - a.t) / (c.t - a.t || 1);
    return {
      w, vy,
      x: a.x + (c.x - a.x) * k,
      z: a.z + (c.z - a.z) * k,
      y: a.y != null && c.y != null ? a.y + (c.y - a.y) * k : null,
      ry: lerpAngle(a.ry, c.ry, k),
      sp: a.sp + (c.sp - a.sp) * k,
      st: a.st + (c.st - a.st) * k,
      fl: k < 0.5 ? a.fl : c.fl,
    };
  }
  // 아직 새 데이터가 없음 → 마지막 상태에서 속도대로 짧게 예측
  const last = rt < a.t ? a : c || a;
  const ahead = extrapolate ? Math.max(0, Math.min(rt - last.t, EXTRAP_MAX)) / 1000 : 0;
  return {
    w, vy: 0,
    x: last.x + Math.sin(last.ry) * last.sp * ahead,
    z: last.z + Math.cos(last.ry) * last.sp * ahead,
    y: last.y, ry: last.ry, sp: last.sp, st: last.st, fl: last.fl,
  };
}

const SNAP_DIST = 15;      // 이보다 크게 튀면(리스폰 등) 부드럽게 하지 않고 바로 이동
const SMOOTH_TIME = 0.12;  // 위치 보정을 나눠서 반영하는 시간 (s)

/**
 * 예측했던 위치와 새 데이터가 어긋날 때 순간이동 대신 짧게 미끄러지듯 보정.
 * r: 카트별 상태 저장 객체 (ex, ez, sx, sz 를 씀), s: sampleAt 결과, 반환: 화면에 그릴 x, z
 */
export function smoothPosition(r, s, dt) {
  const decay = Math.exp(-dt / SMOOTH_TIME);
  r.ex = (r.ex || 0) * decay;
  r.ez = (r.ez || 0) * decay;
  if (r.sx != null && dt > 0) {
    // 이번 프레임에 예상되는 이동과 실제 샘플 이동의 차이 = 튐
    const dx = s.x - r.sx - Math.sin(s.ry) * s.sp * dt;
    const dz = s.z - r.sz - Math.cos(s.ry) * s.sp * dt;
    const jump = Math.hypot(dx, dz);
    if (jump > SNAP_DIST) { r.ex = r.ez = 0; }
    else if (jump > 0.3) { r.ex -= dx; r.ez -= dz; }
  }
  r.sx = s.x; r.sz = s.z;
  return { x: s.x + r.ex, z: s.z + r.ez };
}

/**
 * 보간된(과거) 상태에서 lead 초 뒤의 위치를 곡선 경로로 예측 → 상대 카트를 "지금 실제로 있을 위치"에 그림.
 * 화면에 보이는 위치와 충돌 판정 위치가 같아지고, 양쪽 화면에서 서로의 위치가 실제와 가까워짐.
 */
export function predict(s, lead) {
  const w = Math.max(-3, Math.min(3, s.w || 0)), v = s.sp;
  if (Math.abs(w) < 1e-3) return { x: s.x + Math.sin(s.ry) * v * lead, z: s.z + Math.cos(s.ry) * v * lead, ry: s.ry };
  const r2 = s.ry + w * lead;
  return {
    x: s.x + (v / w) * (Math.cos(s.ry) - Math.cos(r2)),
    z: s.z + (v / w) * (Math.sin(r2) - Math.sin(s.ry)),
    ry: r2,
  };
}

/** 보간 상태가 실제보다 얼마나 과거인지 (s): 보간 지연 + 왕복 지연 + 서버 틱 평균 대기 */
export function leadTime(clock, rttMs) {
  if (!clock.useServerTime) return 0;
  return Math.min(LEAD_MAX, (clock.delay + rttMs + 25) / 1000);
}
