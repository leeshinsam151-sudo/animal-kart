// 원격 카트 보간 단위 테스트: 가상 시계로 네트워크 지연/흔들림을 재현해서 부드러움 측정
// 실행: node test/interp.test.mjs
import { NetClock, sampleAt, smoothPosition, predict, leadTime } from '../public/js/interp.js';

const SPEED = 60; // m/s, 일정 속도로 직진하는 카트
const profiles = [
  { name: '좋은 유선', base: 20, jitter: 15, spikeP: 0, spike: 0 },
  { name: '보통 와이파이', base: 50, jitter: 100, spikeP: 0.01, spike: 200 },
  { name: '나쁜 와이파이', base: 80, jitter: 200, spikeP: 0.03, spike: 400 },
  { name: '모바일 LTE', base: 120, jitter: 250, spikeP: 0.05, spike: 600 },
];

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

function run(p, legacy, seed = 7) {
  const rand = rng(seed);
  const clock = new NetClock();
  clock.useServerTime = !legacy;
  clock.extrapolate = !legacy;
  const SKEW = 123456; // 서버와 내 시계는 기준이 다름
  // 서버 → 클라이언트 메시지 (TCP: 도착 순서 유지)
  const msgs = [];
  let lastArr = 0;
  for (let ts = 0; ts < 60000; ts += 50) {
    let d = p.base + rand() * p.jitter + (rand() < p.spikeP ? p.spike : 0);
    const arr = Math.max(lastArr, ts + d);
    lastArr = arr;
    msgs.push({ ts, arr, x: (SPEED * ts) / 1000 });
  }
  const buf = [];
  const st = {};
  let mi = 0, prevX = null, bad = 0, n = 0, maxErr = 0, lagSum = 0;
  for (let now = 2000; now < 59000; now += 1000 / 60) {
    while (mi < msgs.length && msgs[mi].arr <= now) {
      const m = msgs[mi++];
      const t = clock.arrival(m.ts + SKEW, now + SKEW * 0) ; // 서버 시각에 기준 차이(SKEW) 포함
      const tt = legacy ? now : t;
      if (!buf.length || tt > buf[buf.length - 1].t) buf.push({ t: tt, x: m.x, z: 0, ry: Math.PI / 2, sp: SPEED, st: 0, fl: 0, y: 0 });
    }
    const raw = sampleAt(buf, clock.renderTime(now), clock.extrapolate);
    if (!raw) continue;
    const s = legacy ? raw : { ...raw, ...smoothPosition(st, raw, 1 / 60) };
    if (prevX != null && now > 5000) {
      const v = (s.x - prevX) * 60;
      n++;
      if (Math.abs(v - SPEED) > SPEED * 0.25) bad++;
      maxErr = Math.max(maxErr, Math.abs(v - SPEED));
      lagSum += (SPEED * (now / 1000) - s.x) / SPEED * 1000; // 실제 위치보다 얼마나 늦게 보이는지 (ms)
    }
    prevX = s.x;
  }
  return { bad: (bad / n) * 100, maxErr, lag: lagSum / n };
}

let pass = true;
console.log('네트워크'.padEnd(10), '| 방식 |  튐/멈춘 프레임 | 최대 속도 오차 | 화면 지연');
for (const p of profiles) {
  const a = run(p, true), b = run(p, false);
  console.log(p.name.padEnd(10), '| 이전 |', `${a.bad.toFixed(1)}%`.padStart(14), '|', `${a.maxErr.toFixed(0)} m/s`.padStart(12), '|', `${a.lag.toFixed(0)}ms`);
  console.log(''.padEnd(10), '| 새   |', `${b.bad.toFixed(1)}%`.padStart(14), '|', `${b.maxErr.toFixed(0)} m/s`.padStart(12), '|', `${b.lag.toFixed(0)}ms`);
  if (b.bad > a.bad + 0.1) pass = false;
}
console.log(pass ? '\n✅ 모든 네트워크 조건에서 새 방식이 같거나 더 부드러움' : '\n❌ 새 방식이 더 나쁜 조건이 있음');

// ---- 현재 위치 예측: 반지름 40m 원을 50m/s 로 도는 카트 (트랙에서 가장 급한 커브 수준) ----
// 화면에 그린 위치가 "지금 실제 위치"와 얼마나 떨어져 있는지 (충돌 판정 정확도)
function predictRun(p, usePredict, seed = 3) {
  const rand = rng(seed);
  const clock = new NetClock();
  const R = 40, V = 50, W = V / R;
  const truth = (tMs) => { const a = (W * tMs) / 1000; return { x: R * Math.sin(a), z: R * Math.cos(a), ry: a + Math.PI / 2 }; };
  const UP = p.base / 2; // 상대 → 서버 지연
  const msgs = [];
  let lastArr = 0;
  for (let ts = 0; ts < 30000; ts += 50) {
    const st = truth(ts - UP - 25); // 서버가 보내는 시점의 상대 상태는 그만큼 과거
    const arr = Math.max(lastArr, ts + p.base / 2 + rand() * p.jitter + (rand() < p.spikeP ? p.spike : 0));
    lastArr = arr;
    msgs.push({ ts, arr, ...st });
  }
  const buf = [], r = {};
  let mi = 0, sum = 0, n = 0, worst = 0;
  for (let now = 2000; now < 29000; now += 1000 / 60) {
    while (mi < msgs.length && msgs[mi].arr <= now) {
      const m = msgs[mi++];
      const t = clock.arrival(m.ts, now);
      if (!buf.length || t > buf[buf.length - 1].t) buf.push({ t, x: m.x, z: m.z, ry: m.ry, sp: V, st: 0, fl: 0, y: 0 });
    }
    const s = sampleAt(buf, clock.renderTime(now), true);
    if (!s || now < 5000) continue;
    const pr = usePredict ? { ...s, ...predict(s, leadTime(clock, p.base + p.jitter / 2)) } : s;
    const pos = smoothPosition(r, pr, 1 / 60);
    const tr = truth(now);
    const e = Math.hypot(pos.x - tr.x, pos.z - tr.z);
    sum += e; n++; worst = Math.max(worst, e);
  }
  return { avg: sum / n, worst };
}
console.log('\n네트워크'.padEnd(11), '| 실제 위치와의 거리 (평균 / 최악)  예측 없음  →  곡선 예측');
let pass2 = true;
for (const p of profiles) {
  const a = predictRun(p, false), b = predictRun(p, true);
  console.log(p.name.padEnd(10), '|', `${a.avg.toFixed(1)}m / ${a.worst.toFixed(1)}m`.padStart(16), ' → ', `${b.avg.toFixed(1)}m / ${b.worst.toFixed(1)}m`);
  if (b.avg > a.avg) pass2 = false;
}
console.log(pass2 ? '✅ 예측으로 화면 위치가 실제 위치에 더 가까워짐 (충돌 판정 정확도 향상)' : '❌ 예측이 오히려 멀어지는 조건이 있음');
process.exit(pass && pass2 ? 0 : 1);
