// DOM 기반 UI: 메뉴, 차고(캐릭터 선택), 로비, HUD, 미니맵, 결과
import { CHARACTERS, CHARACTER_IDS } from './kart.js';
import { ZONES, TRACKS } from './track.js';
import { ITEM_INFO } from './items.js';

const $ = (id) => document.getElementById(id);

export const COLORS = ['#e63946', '#1d8cf8', '#ffb703', '#2ec4b6', '#9b5de5', '#f15bb5', '#fb8500', '#8ac926'];

export function formatTime(ms) {
  if (ms == null) return 'DNF';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const charEmoji = (id) => CHARACTERS[id]?.emoji || '❔';

export class UI {
  constructor(track) {
    this.track = track;
    this.minimap = $('minimap');
    this.mm = this.minimap.getContext('2d');
    this.prepareMinimap();
    this.toastTimer = null;
    this.countdownTimers = [];
    this.lastItems = 0;
  }

  /** 트랙이 바뀌면 미니맵 다시 그리기 */
  setTrack(track) {
    this.track = track;
    this.prepareMinimap();
  }

  /** 로비 트랙 카드 (모양 미리보기 + 길이·바퀴 수). 방장만 누를 수 있음 */
  renderTrackPicker(selected, isHost, canPick) {
    // 로비 메시지마다 다시 그리면 누르는 도중 버튼이 바뀌어 클릭이 사라짐 → 바뀐 게 있을 때만
    const key = `${selected}|${isHost}|${canPick}`;
    if (key === this.trackPickKey) return;
    this.trackPickKey = key;
    const shape = (pts) => {
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), z0 = Math.min(...zs), k = 28 / Math.max(Math.max(...xs) - x0, Math.max(...zs) - z0);
      const ox = (34 - (Math.max(...xs) - x0) * k) / 2, oz = (34 - (Math.max(...zs) - z0) * k) / 2;
      return pts.map((p) => `${(ox + (p[0] - x0) * k).toFixed(1)},${(oz + (p[1] - z0) * k).toFixed(1)}`).join(' ');
    };
    $('trackPick').innerHTML = TRACKS.map((t) => {
      const color = t.theme ? ZONES.find((z) => z.id === t.theme).map : '#ffffff';
      const sel = t.id === selected;
      return `<button type="button" class="trk${sel ? ' sel' : ''}" data-track="${t.id}" style="--tc:${color}" title="${esc(t.desc)}" ${isHost && canPick ? '' : 'disabled'}>
        <svg viewBox="0 0 34 34"><polygon points="${shape(t.points)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round"/></svg>
        <span>${t.emoji} ${esc(t.name)}</span><small>${(t.len / 1000).toFixed(1)}km · ${t.laps}바퀴</small>
      </button>`;
    }).join('');
    const cur = TRACKS.find((t) => t.id === selected);
    $('trackHint').textContent = cur ? `— ${cur.desc}${isHost ? '' : ' (방장이 선택)'}` : '';
  }

  show(id, visible = true) {
    $(id).classList.toggle('hidden', !visible);
  }

  // ---------- 메뉴 / 차고 / 로비 ----------
  menuMessage(text) { $('menuMsg').textContent = text || ''; }

  /** 캐릭터 카드 + 카트 색상 선택 */
  renderGarage(profile, takenColors = new Set()) {
    $('charGrid').innerHTML = CHARACTER_IDS.map((id) => `
      <button type="button" class="char${id === profile.char ? ' sel' : ''}" data-char="${id}" style="--c:${CHARACTERS[id].outfit}">
        <span class="emoji">${CHARACTERS[id].emoji}</span><span>${CHARACTERS[id].name}</span>
      </button>`).join('');
    $('colorRow').innerHTML = COLORS.map((c) => {
      const taken = takenColors.has(c) && c !== profile.color;
      return `<button type="button" class="swatch${c === profile.color ? ' sel' : ''}${taken ? ' taken' : ''}" data-color="${c}" style="background:${c}" ${taken ? 'disabled title="다른 플레이어가 사용 중"' : ''}></button>`;
    }).join('');
  }

  updateLobby({ players, hostId, phase, track }, myId, room) {
    $('roomCode').textContent = room;
    if (track) this.renderTrackPicker(track, myId === hostId, phase === 'lobby');
    $('playerList').innerHTML = players.map((p) => `
      <li>
        <span class="avatar" style="background:${p.color}">${charEmoji(p.char)}</span>
        <span class="pname">${esc(p.name)}${p.id === myId ? ' <em>(나)</em>' : ''}${p.away ? ' <em class="away">연결 끊김…</em>' : ''}</span>
        ${p.id === hostId ? '<span class="badge">방장</span>' : ''}
      </li>`).join('');
    const isHost = myId === hostId;
    $('startBtn').classList.toggle('hidden', !(isHost && phase === 'lobby'));
    let msg = '';
    if (room === 'offline') msg = '오프라인 연습 모드: AI 봇 5명과 6명이 달립니다. 레이스 시작을 눌러주세요!';
    else if (phase !== 'lobby') msg = '레이스 진행 중입니다. 다음 판에 참가할 수 있어요. (관전 중)';
    else if (!isHost) msg = '방장이 레이스를 시작하기를 기다리는 중…';
    else if (players.length === 1) msg = '혼자서도 연습 주행할 수 있어요. 초대 링크로 친구를 불러보세요!';
    $('lobbyMsg').textContent = msg;
  }

  // ---------- 카운트다운 / 토스트 ----------
  countdown(ms) {
    this.countdownTimers.forEach(clearTimeout);
    const el = $('countdown');
    const steps = Math.round(ms / 1000);
    for (let i = 0; i < steps; i++) {
      this.countdownTimers.push(setTimeout(() => {
        el.textContent = String(steps - i);
        el.className = 'pop';
        void el.offsetWidth;
        el.className = 'pop anim';
      }, i * 1000));
    }
  }

  go() {
    this.countdownTimers.forEach(clearTimeout);
    const el = $('countdown');
    el.textContent = 'GO!';
    el.className = 'pop anim go';
    this.countdownTimers.push(setTimeout(() => { el.className = 'hidden'; }, 900));
  }

  hideCountdown() {
    this.countdownTimers.forEach(clearTimeout);
    $('countdown').className = 'hidden';
  }

  toast(text, ms = 2500) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
  }

  // ---------- HUD ----------
  updateHud({ speed, lap, laps, pos, total, time, standings, wrongWay, finished, myId, gauge, items, boosting, held = [], rolling, ping }) {
    $('speedText').textContent = Math.round(speed);
    $('posText').innerHTML = `${pos}<small>/${total}</small>`;
    $('lapText').textContent = finished ? '완주!' : `LAP ${lap}/${laps}`;
    $('timeText').textContent = formatTime(time);
    const pingEl = $('pingText');
    pingEl.textContent = ping == null ? '' : `핑 ${ping}ms`;
    pingEl.className = ping == null ? '' : ping < 120 ? 'good' : ping < 250 ? 'ok' : 'bad';
    $('wrongWay').classList.toggle('hidden', !wrongWay);
    $('standings').innerHTML = standings.map((s, i) => `
      <div class="row${s.id === myId ? ' me' : ''}">
        <b>${i + 1}</b><span class="avatar sm" style="background:${s.color}">${charEmoji(s.char)}</span>${esc(s.name)}${s.finished ? ' 🏁' : ''}
      </div>`).join('');

    // 부스터 게이지 + 아이템 슬롯
    $('gaugeFill').style.width = `${Math.min(1, gauge) * 100}%`;
    $('gauge').classList.toggle('full', gauge >= 1);
    const slots = $('items').children;
    for (let i = 0; i < slots.length; i++) slots[i].classList.toggle('on', i < items);
    if (items > this.lastItems) {
      const el = slots[items - 1];
      el.classList.remove('got'); void el.offsetWidth; el.classList.add('got');
    }
    this.lastItems = items;
    document.body.classList.toggle('boosting', !!boosting);

    // 아이템 슬롯 2칸 (첫 칸 = Z 로 쓸 아이템, 둘째 칸 = 다음 아이템). 룰렛 중인 칸은 아이콘이 돌아감
    const itemSlots = [...held];
    if (rolling) itemSlots.push('?');
    const spin = Object.values(ITEM_INFO)[Math.floor(performance.now() / 90) % Object.keys(ITEM_INFO).length].emoji;
    const iconOf = (it) => (it === '?' ? spin : it ? ITEM_INFO[it].emoji : '');
    const first = itemSlots[0], second = itemSlots[1];
    if ($('itemIcon').textContent !== iconOf(first)) $('itemIcon').textContent = iconOf(first);
    if ($('itemIcon2').textContent !== iconOf(second)) $('itemIcon2').textContent = iconOf(second);
    const slot = $('itemSlot');
    slot.classList.toggle('ready', !!first && first !== '?');
    slot.classList.toggle('rolling', first === '?');
    $('itemSlot2').classList.toggle('filled', !!second);
    $('itemSlot2').classList.toggle('rolling', second === '?');
    $('itemName').textContent = first && first !== '?' ? ITEM_INFO[first].name : '';
  }

  /** 내 머리 위 번개 구름: 남은 초 (없으면 null) */
  cloudWarning(sec) {
    const on = sec != null;
    if (on !== this.cloudOn) { $('cloudWarn').classList.toggle('hidden', !on); this.cloudOn = on; }
    if (on) { const t = sec.toFixed(1); if ($('cloudSec').textContent !== t) $('cloudSec').textContent = t; }
  }

  missileWarning(on) {
    $('missileWarn').classList.toggle('hidden', !on);
    document.body.classList.toggle('missile-danger', on);
  }

  /** 새 구역 진입 배너 */
  zoneBanner(zone) {
    const el = $('zoneBanner');
    el.innerHTML = `<span>${zone.emoji}</span> ${zone.name}${zone.suffix ?? ' 지대'} <small>${zone.label}</small>`;
    el.style.setProperty('--zc', zone.map);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }

  prepareMinimap() {
    const { points, bounds } = this.track;
    const W = this.minimap.width, pad = 14;
    const sx = bounds.max.x - bounds.min.x, sz = bounds.max.z - bounds.min.z;
    const scale = (W - pad * 2) / Math.max(sx, sz);
    const ox = (W - sx * scale) / 2, oz = (W - sz * scale) / 2;
    this.toMap = (x, z) => [ox + (x - bounds.min.x) * scale, oz + (z - bounds.min.z) * scale];

    const bg = document.createElement('canvas');
    bg.width = bg.height = W;
    const g = bg.getContext('2d');
    g.lineJoin = 'round';
    g.beginPath();
    points.forEach((p, i) => { const [x, y] = this.toMap(p.x, p.z); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 8; g.stroke();
    // 구역별 색으로 트랙 칠하기
    g.lineWidth = 4;
    g.lineCap = 'round';
    for (let i = 0; i < points.length; i += 3) {
      const a = points[i], b = points[(i + 3) % points.length];
      g.strokeStyle = ZONES[this.track.zone[i]].map;
      g.beginPath();
      g.moveTo(...this.toMap(a.x, a.z));
      g.lineTo(...this.toMap(b.x, b.z));
      g.stroke();
    }
    const [sx0, sy0] = this.toMap(points[0].x, points[0].z);
    g.fillStyle = '#fff'; g.fillRect(sx0 - 2, sy0 - 6, 4, 12);
    this.minimapBg = bg;
  }

  drawMinimap(cars) {
    const ctx = this.mm, W = this.minimap.width;
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(this.minimapBg, 0, 0);
    for (const c of cars) {
      const [x, y] = this.toMap(c.x, c.z);
      ctx.beginPath();
      ctx.arc(x, y, c.me ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c.color;
      ctx.fill();
      if (c.me) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    }
  }

  // ---------- 결과 ----------
  showResults(results, myId, players) {
    $('resultsTable').innerHTML = `
      <tr><th>순위</th><th>드라이버</th><th>기록</th></tr>
      ${results.map((r) => `
        <tr class="${r.id === myId ? 'me' : ''}">
          <td>${r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : r.place}</td>
          <td><span class="avatar sm" style="background:${r.color}">${charEmoji(players.get(r.id)?.char)}</span>${esc(r.name)}</td>
          <td>${formatTime(r.time)}</td>
        </tr>`).join('')}`;
    this.show('results', true);
  }
}
