// 네트워크 래퍼: WebSocket 서버에 접속. 서버가 없거나 연습 모드면 브라우저 안의 LocalServer(AI 봇)로 대체
// - 연결이 끊기면 자동 재접속 (서버가 준 token 으로 레이스 중이던 자리에 복귀)
// - 보낸 핑에 6초 넘게 아무 응답이 없으면 끊긴 것으로 보고 재접속 (와이파이 끊김은 close 이벤트가 안 올 때가 많음)
import { LocalServer } from './localserver.js';

const MAX_RETRIES = 5;
const PING_MS = 2000;
const DEAD_MS = 6000; // 레이스 중엔 초당 20번 스냅샷이 오므로 6초 무응답이면 확실히 끊긴 것

export class Net {
  constructor() {
    this.handlers = {};
    this.ws = null;
    this.local = null;
    this.offline = false;
    this.offlineContext = null; // { track, items } (main 에서 지정)
    this.token = null;
    this.retries = 0;
    this.everConnected = false;
    this.lastMsgAt = 0;
    this.rtt = 0;               // 왕복 지연 (ms)
    setInterval(() => this.heartbeat(), PING_MS);
  }

  on(type, fn) {
    this.handlers[type] = fn;
    return this;
  }

  dispatch(msg) {
    this.handlers[msg.type]?.(msg);
  }

  /** join: { name, room, char, color }, offline: true 면 바로 AI 연습 모드 */
  connect(join, offline = false) {
    if (offline) return this.startOffline(join);
    this.join = join;
    this.token = null;
    this.retries = 0;
    this.everConnected = false;
    this.open();
  }

  open() {
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      return this.everConnected ? this.retry() : this.startOffline(this.join);
    }
    this.ws = ws;
    ws.onopen = () => {
      this.everConnected = true;
      this.retries = 0;
      this.lastMsgAt = performance.now();
      this.pingAt = 0;
      this.send({ type: 'join', ...this.join, token: this.token });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.lastMsgAt = performance.now();
      if (msg.type === 'welcome' && msg.token) this.token = msg.token;
      if (msg.type === 'pong') { this.rtt = performance.now() - msg.t; return; }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 이미 버린 연결
      this.ws = null;
      // 처음부터 접속이 안 되면 서버가 없는 것 → 오프라인 연습 모드
      if (!this.everConnected) this.startOffline(this.join);
      else this.retry();
    };
  }

  retry() {
    if (this.retries >= MAX_RETRIES) { this.handlers.close?.(); return; }
    this.retries++;
    this.handlers.reconnecting?.({ attempt: this.retries, max: MAX_RETRIES });
    setTimeout(() => this.open(), 1000 * this.retries);
  }

  heartbeat() {
    const now = performance.now();
    // 이 타이머 자체가 늦게 불렸으면(탭이 백그라운드거나 화면이 잠깐 멈춤) 응답이 밀려 있을 수 있으니 이번엔 판정하지 않음
    const stalled = now - (this.lastBeat || now) > PING_MS * 1.5;
    this.lastBeat = now;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const waiting = this.pingAt && this.lastMsgAt < this.pingAt; // 보낸 핑 이후로 아무 메시지도 못 받음
    if (waiting && !stalled && now - this.pingAt > DEAD_MS) {
      // 응답 없는 연결은 버리고 새로 접속
      this.ws = null;
      ws.onclose = null;
      try { ws.close(); } catch {}
      this.retry();
      return;
    }
    if (!waiting) { ws.send(JSON.stringify({ type: 'ping', t: now })); this.pingAt = now; }
  }

  startOffline(join) {
    if (this.local) return;
    this.offline = true;
    if (this.ws) { this.ws.onclose = this.ws.onerror = null; try { this.ws.close(); } catch {} this.ws = null; }
    // 실제 네트워크처럼 비동기로 전달
    this.local = new LocalServer(this.offlineContext, (msg) => setTimeout(() => this.dispatch(msg), 0));
    this.local.receive({ type: 'join', ...join });
  }

  send(obj) {
    if (this.local) this.local.receive(obj);
    else if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
