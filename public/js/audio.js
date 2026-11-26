// 소리: 파일 없이 WebAudio 로 전부 합성 (엔진음, 효과음, 구역별 배경음악)
// 브라우저 정책상 사용자가 버튼을 누른 뒤 start() 해야 소리가 남

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ---------------- 배경음악 테마 ----------------
// scale: 음계(반음 간격), prog: 마디별 화음(음계 도수), 16스텝 패턴
const THEMES = {
  menu: { bpm: 96, root: 60, scale: [0, 2, 4, 5, 7, 9, 11], prog: [0, 5, 3, 4], lead: 'sine', bass: 'triangle', arp: [0, 2, 4, 2, 0, 2, 4, 6], drums: 'soft', vol: 0.8 },
  forest: { bpm: 132, root: 55, scale: [0, 2, 4, 5, 7, 9, 11], prog: [0, 4, 5, 3], lead: 'triangle', bass: 'square', arp: [0, 2, 4, 7, 4, 2, 4, 7], drums: 'pop', vol: 0.75 },
  glacier: { bpm: 108, root: 62, scale: [0, 2, 3, 5, 7, 9, 10], prog: [0, 3, 6, 4], lead: 'bell', bass: 'sine', arp: [0, 4, 7, 9, 7, 4, 2, 4], drums: 'sparse', vol: 0.75 },
  desert: { bpm: 122, root: 52, scale: [0, 1, 4, 5, 7, 8, 10], prog: [0, 1, 0, 6], lead: 'square', bass: 'triangle', arp: [0, 1, 4, 1, 0, 4, 5, 4], drums: 'tamb', vol: 0.65 },
  city: { bpm: 126, root: 57, scale: [0, 2, 3, 5, 7, 8, 10], prog: [0, 5, 3, 6], lead: 'saw', bass: 'square', arp: [0, 4, 2, 4, 7, 4, 2, 4], drums: 'funk', vol: 0.6 },
  block: { bpm: 142, root: 60, scale: [0, 2, 4, 7, 9, 12, 14], prog: [0, 3, 4, 1], lead: 'toy', bass: 'triangle', arp: [0, 1, 2, 3, 4, 3, 2, 1], drums: 'pop', vol: 0.75 },
};

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicVol = 0.5;
    this.sfxVol = 0.8;
    this.theme = null;
    this.nextTheme = null;
  }

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.applyVolumes();

    // 엔진음
    this.osc1 = ctx.createOscillator();
    this.osc2 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2.type = 'square';
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.35;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc1.connect(this.filter);
    this.osc2.connect(mix2).connect(this.filter);
    this.filter.connect(this.gain).connect(this.sfxBus);
    this.osc1.start();
    this.osc2.start();

    // 노이즈 버퍼 (타이어·물·폭발 등)
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // 드리프트 타이어 소리 (계속 재생, 볼륨만 조절)
    const skid = ctx.createBufferSource();
    skid.buffer = this.noiseBuf;
    skid.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skid.connect(bp).connect(this.skidGain).connect(this.sfxBus);
    skid.start();

    // 음악 스케줄러 (조금 앞서 예약)
    this.step = 0;
    this.nextNoteTime = ctx.currentTime + 0.1;
    setInterval(() => this.schedule(), 25);
    if (this.nextTheme) this.playMusic(this.nextTheme);
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.sfxVol, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.musicVol * 0.5, t, 0.05);
  }

  setVolumes(music, sfx) {
    this.musicVol = music;
    this.sfxVol = sfx;
    this.applyVolumes();
  }

  toggle() {
    this.muted = !this.muted;
    this.applyVolumes();
    return this.muted;
  }

  // ---------------- 엔진 / 드리프트 ----------------
  /** speedRatio: 0~1, throttle: 0/1 */
  update(speedRatio, throttle, active = true, drifting = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // 5단 기어 느낌: 단마다 회전수가 올라갔다 떨어짐
    const g = Math.min(speedRatio, 0.999) * 5;
    const rpm = g - Math.floor(g);
    const f = 45 + rpm * 85 + Math.floor(g) * 10 + throttle * 8;
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.filter.frequency.setTargetAtTime(500 + rpm * 900 + throttle * 400, t, 0.08);
    const vol = !active ? 0 : 0.03 + throttle * 0.03 + speedRatio * 0.02;
    this.gain.gain.setTargetAtTime(vol, t, 0.1);
    this.skidGain.gain.setTargetAtTime(active && drifting ? 0.05 + speedRatio * 0.05 : 0, t, 0.05);
  }

  // ---------------- 합성 도구 ----------------
  tone(freq, dur, { type = 'square', vol = 0.15, attack = 0.005, slideTo = null, when = 0, bus = this.sfxBus } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, { vol = 0.2, type = 'lowpass', freq = 1000, slideTo = null, q = 1, when = 0, bus = this.sfxBus } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // ---------------- 효과음 ----------------
  click() { this.tone(880, 0.06, { type: 'triangle', vol: 0.08 }); }
  count() { this.tone(523, 0.25, { type: 'square', vol: 0.12 }); }
  go() { this.tone(1047, 0.5, { type: 'square', vol: 0.14 }); this.tone(1568, 0.5, { type: 'triangle', vol: 0.08 }); }
  beep(freq = 880, dur = 0.08) { this.tone(freq, dur, { type: 'square', vol: 0.06 }); }

  /** 쿵 (충돌·착지). strength 0~1 */
  thud(strength = 1) {
    this.noise(0.25, { vol: 0.25 * strength, freq: 500 + strength * 700 });
    this.tone(120, 0.22, { type: 'sine', vol: 0.3 * strength, slideTo: 45 });
  }

  box() { [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.12, { type: 'triangle', vol: 0.08, when: i * 0.04 })); }
  tick() { this.tone(1400 + Math.random() * 400, 0.03, { type: 'square', vol: 0.03 }); }
  itemGet() { this.tone(1047, 0.12, { type: 'triangle', vol: 0.1 }); this.tone(1568, 0.25, { type: 'triangle', vol: 0.1, when: 0.08 }); }
  charge() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.18, { type: 'square', vol: 0.06, when: i * 0.05 })); this.noise(0.4, { vol: 0.08, type: 'highpass', freq: 4000, when: 0.1 }); }
  chime() { [1319, 1760].forEach((f, i) => this.tone(f, 0.2, { type: 'sine', vol: 0.09, when: i * 0.07 })); }
  drop() { this.tone(300, 0.15, { type: 'sine', vol: 0.15, slideTo: 120 }); }
  slip() { this.tone(500, 0.6, { type: 'sine', vol: 0.15, slideTo: 150 }); this.tone(800, 0.25, { type: 'triangle', vol: 0.08, slideTo: 1400, when: 0.05 }); }
  throwIt() { this.noise(0.35, { vol: 0.12, type: 'bandpass', freq: 600, slideTo: 2000, q: 2 }); }
  splash(v = 1) { this.noise(0.6, { vol: 0.35 * v, type: 'lowpass', freq: 3000, slideTo: 300 }); this.tone(200, 0.2, { type: 'sine', vol: 0.15 * v, slideTo: 80 }); }
  trapped() { for (let i = 0; i < 5; i++) this.tone(400 + Math.random() * 500, 0.08, { type: 'sine', vol: 0.08, slideTo: 900, when: i * 0.07 }); }
  shield() { [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.5, { type: 'sine', vol: 0.07, when: i * 0.04 })); this.noise(0.5, { vol: 0.05, type: 'highpass', freq: 5000 }); }
  shieldBreak() { this.tone(1200, 0.25, { type: 'triangle', vol: 0.12, slideTo: 400 }); this.noise(0.25, { vol: 0.12, type: 'highpass', freq: 3000 }); }
  magnet() { this.tone(110, 0.9, { type: 'sawtooth', vol: 0.06, slideTo: 440 }); this.tone(220, 0.9, { type: 'square', vol: 0.03, slideTo: 880, when: 0.05 }); }
  cloud() { this.noise(1.2, { vol: 0.12, type: 'lowpass', freq: 400, slideTo: 150 }); this.tone(70, 1, { type: 'sine', vol: 0.12, slideTo: 50 }); }
  thunder(v = 1) { this.noise(0.12, { vol: 0.5 * v, type: 'highpass', freq: 2500 }); this.noise(1.4, { vol: 0.45 * v, freq: 900, slideTo: 60, when: 0.05 }); this.tone(55, 1.2, { type: 'sine', vol: 0.35 * v, slideTo: 30, when: 0.05 }); }
  pop() { this.tone(900, 0.08, { type: 'sine', vol: 0.15, slideTo: 300 }); this.noise(0.08, { vol: 0.1, type: 'highpass', freq: 2000 }); }
  missile() { this.noise(0.5, { vol: 0.15, type: 'bandpass', freq: 400, slideTo: 3000, q: 1.5 }); this.tone(200, 0.4, { type: 'sawtooth', vol: 0.05, slideTo: 800 }); }
  explosion(v = 1) { this.noise(0.9, { vol: 0.5 * v, freq: 1800, slideTo: 100 }); this.tone(90, 0.6, { type: 'sine', vol: 0.4 * v, slideTo: 30 }); }
  boost() { this.noise(0.6, { vol: 0.18, type: 'bandpass', freq: 300, slideTo: 2500, q: 1 }); this.tone(220, 0.5, { type: 'sawtooth', vol: 0.05, slideTo: 660 }); }
  jump() { this.tone(300, 0.3, { type: 'triangle', vol: 0.08, slideTo: 700 }); }
  zone() { [659, 880, 1319].forEach((f, i) => this.tone(f, 0.3, { type: 'sine', vol: 0.07, when: i * 0.09 })); }
  lap() { [784, 1047].forEach((f, i) => this.tone(f, 0.25, { type: 'square', vol: 0.08, when: i * 0.12 })); }
  finalLap() { [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.22, { type: 'square', vol: 0.09, when: i * 0.1 })); }
  finish(place = 1) {
    const notes = place === 1 ? [523, 659, 784, 1047, 784, 1047] : place <= 3 ? [523, 659, 784, 1047] : [523, 587, 659];
    notes.forEach((f, i) => this.tone(f, 0.3, { type: 'square', vol: 0.1, when: i * 0.14 }));
  }

  // ---------------- 배경음악 ----------------
  /** name: menu | forest | glacier | desert | city | block | null(정지). 다음 마디부터 바뀜 */
  playMusic(name) {
    this.nextTheme = name;
    if (!this.ctx) return;
    if (!this.theme) { this.theme = name; this.step = 0; }
  }

  schedule() {
    const ctx = this.ctx;
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      // 마디 시작에서 테마 전환
      if (this.step % 16 === 0 && this.nextTheme !== this.theme) { this.theme = this.nextTheme; this.step = 0; }
      const th = THEMES[this.theme];
      const spb = th ? 60 / th.bpm / 4 : 0.1; // 16분음표 길이
      if (th) this.playStep(th, this.step, this.nextNoteTime - ctx.currentTime, spb);
      this.nextNoteTime += spb;
      this.step = (this.step + 1) % 64;
    }
  }

  playStep(th, step, when, spb) {
    const bar = Math.floor(step / 16), s = step % 16;
    const deg = th.prog[bar % th.prog.length];
    const note = (d, oct = 0) => {
      const sc = th.scale, n = sc.length;
      return th.root + sc[((d % n) + n) % n] + 12 * (Math.floor(d / n) + oct);
    };
    const bus = this.musicBus, v = th.vol;
    // 베이스: 8분음표 (도시는 엇박)
    const bassHit = th.drums === 'funk' ? [0, 3, 6, 8, 10, 14].includes(s) : s % 4 === 0 || s % 4 === 2;
    if (bassHit) this.tone(midi(note(deg, -2) + (s % 8 === 6 ? 7 : 0)), spb * 1.8, { type: th.bass, vol: 0.12 * v, when, bus });
    // 아르페지오 리드: 8분음표
    if (s % 2 === 0) {
      const d = deg + th.arp[(s / 2) % th.arp.length];
      const f = midi(note(d, 0));
      if (th.lead === 'bell') { this.tone(f, spb * 6, { type: 'sine', vol: 0.07 * v, when, bus }); this.tone(f * 2.01, spb * 3, { type: 'sine', vol: 0.025 * v, when, bus }); }
      else if (th.lead === 'toy') this.tone(f * 2, spb * 1.5, { type: 'triangle', vol: 0.06 * v, when, bus });
      else if (th.lead === 'saw') this.tone(f, spb * 1.6, { type: 'sawtooth', vol: 0.025 * v, when, bus });
      else this.tone(f, spb * 1.8, { type: th.lead, vol: (th.lead === 'square' ? 0.03 : 0.06) * v, when, bus });
    }
    // 드럼
    const kick = (vol) => this.tone(110, 0.15, { type: 'sine', vol: vol * v, slideTo: 40, when, bus });
    const hat = (vol, dur = 0.04) => this.noise(dur, { vol: vol * v, type: 'highpass', freq: 7000, when, bus });
    const snare = (vol) => this.noise(0.12, { vol: vol * v, type: 'bandpass', freq: 1800, q: 0.8, when, bus });
    switch (th.drums) {
      case 'soft': if (s === 0) kick(0.15); if (s % 4 === 2) hat(0.03); break;
      case 'sparse': if (s === 0 || s === 10) kick(0.18); if (s % 8 === 4) hat(0.04, 0.2); break;
      case 'tamb': if (s % 4 === 0) kick(0.22); if (s % 2 === 1) hat(0.05, 0.06); if (s === 4 || s === 12) snare(0.1); break;
      case 'funk': if ([0, 7, 10].includes(s)) kick(0.25); if (s === 4 || s === 12) snare(0.14); if (s % 2 === 0) hat(0.04); break;
      default: if (s % 4 === 0) kick(0.25); if (s === 4 || s === 12) snare(0.12); if (s % 2 === 1) hat(0.04); break;
    }
  }
}
