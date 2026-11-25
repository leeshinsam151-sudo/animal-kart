// 카트 충돌 단위 테스트: 실행 node test/collision.test.mjs
import { CarController, BUMP_K } from '../public/js/physics.js';

const kart = (x, z, vx = 0, vz = 0, y = 0) => Object.assign(new CarController({}), { x, z, vx, vz, y });
let ok = true;
const check = (name, cond, detail = '') => { console.log(cond ? '✅' : '❌', name, detail); if (!cond) ok = false; };

// 1) 뒤에서 30m/s 로 정지한 카트를 박음
{
  const a = kart(0, 0), b = kart(0, -2.5, 0, 30);
  const hitB = b.collideWith(a.x, a.z, a.vx, a.vz, a.y);
  check('박은 쪽이 충돌 감지', !!hitB, `속도 ${hitB?.speed.toFixed(1)}m/s`);
  check('박은 쪽은 느려짐', b.vz < 30, `${30} → ${b.vz.toFixed(1)}m/s`);
  // 박힌 쪽: 상대가 보낸 충돌 알림 적용
  a.bump(-hitB.nx * hitB.speed * BUMP_K, -hitB.nz * hitB.speed * BUMP_K);
  check('박힌 쪽은 앞으로 밀려남', a.vz > 12, `0 → ${a.vz.toFixed(1)}m/s`);
  check('박은 쪽이 완전히 멈추지는 않음', b.vz > 8, `${b.vz.toFixed(1)}m/s 유지`);
}
// 2) 점프 중(높이 차 2m)이면 충돌 안 함
{
  const a = kart(0, 0), b = kart(0, -2, 0, 30, 2.0);
  check('높이 차 2m(점프 중)면 통과', b.collideWith(a.x, a.z, 0, 0, a.y) === null && b.vz === 30);
  const c = kart(0, -2, 0, 30, 1.0);
  check('높이 차 1m 면 충돌', c.collideWith(a.x, a.z, 0, 0, a.y) !== null);
}
// 3) 이미 알림으로 튕겼으면(impulse=false) 겹침만 풀고 속도는 그대로 → 두 번 튕기지 않음
{
  const b = kart(0, -2.5, 0, 30);
  const hit = b.collideWith(0, 0, 0, 0, 0, false);
  check('중복 방지: 겹침만 풀고 속도 유지', !!hit && b.vz === 30 && b.z <= -2.8 + 1e-9, `z=${b.z.toFixed(2)}`);
}
// 4) 멀어지는 중이면 충돌 처리 안 함
{
  const b = kart(0, -2.5, 0, -10);
  check('서로 멀어지는 중이면 무시', b.collideWith(0, 0, 0, 0, 0) === null);
}
process.exit(ok ? 0 : 1);
