// 서버 없이 정적 호스팅용 빌드 (dist/). 이 경우 게임은 'AI 봇과 연습' 오프라인 모드로 동작
import { cpSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
cpSync(path.join(root, 'public'), dist, { recursive: true });
const three = path.join(root, 'node_modules/three');
for (const f of [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/environments/RoomEnvironment.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  // 그래픽 '높음' 후처리 (앰비언트 오클루전 + 블룸)
  ...['EffectComposer', 'RenderPass', 'GTAOPass', 'UnrealBloomPass', 'OutputPass', 'ShaderPass', 'Pass', 'MaskPass'].map((f) => `examples/jsm/postprocessing/${f}.js`),
  ...['GTAOShader', 'PoissonDenoiseShader', 'CopyShader', 'LuminosityHighPassShader', 'OutputShader'].map((f) => `examples/jsm/shaders/${f}.js`),
  'examples/jsm/math/SimplexNoise.js',
]) {
  const to = path.join(dist, 'vendor/three', f);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(path.join(three, f), to);
}
console.log('dist/ 생성 완료 — 아무 정적 서버로 열면 됩니다 (예: npx serve dist)');
