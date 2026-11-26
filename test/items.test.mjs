// 방어막 단위 테스트: 실행 node test/items.test.mjs
import { CarController, SHIELD_TIME } from '../public/js/physics.js';

let ok = true;
const check = (name, cond, detail = '') => { console.log(cond ? '✅' : '❌', name, detail); if (!cond) ok = false; };
const kart = () => new CarController({});

for (const hit of ['spinOut', 'trap', 'blast']) {
  const k = kart();
  let broke = 0;
  k.onShieldBreak = () => broke++;
  k.shieldTime = SHIELD_TIME;
  const first = k[hit]();
  check(`방어막이 ${hit} 1번 막음`, first === false && !k.stunned && k.shieldTime === 0 && broke === 1);
  const second = k[hit]();
  check(`방어막이 사라진 뒤 ${hit} 은 맞음`, second === true && k.stunned);
}
{
  const k = kart();
  check('방어막 없으면 바로 맞음', k.spinOut() === true && k.spinTime > 0);
  check('이미 스핀 중 물폭탄은 갇힘 (기존 동작 유지)', k.trap() === true && k.trapTime > 0);
}
{
  const k = kart();
  k.magnetTime = 3;
  k.spinOut();
  check('맞으면 자석 효과 끝남', k.magnetTime === 0);
}
process.exit(ok ? 0 : 1);
