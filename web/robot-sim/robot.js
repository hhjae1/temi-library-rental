import { $, esc } from '/shared/api.js';
import { drawMap } from '/shared/map.js';
import { illustration } from '/illustrations.js';
import { buildFakeMap, LOCATIONS, toMapData } from './fakeMap.js';

const HOME = 'home base';
const HOME_TRAVEL_SEC = 5;
const POSITION_MS = 300; // 실제 TEMI 앱과 비슷하게 1초에 몇 번 위치를 보낸다

// ── 로봇 드라이버 ─────────────────────────────
// 실제 TEMI에서는 temi-android/.../RobotBridge.kt가 같은 일을 SDK로 한다.
//   goTo      → robot.goTo(location) + OnGoToLocationStatusChangedListener
//   위치      → OnCurrentPositionChangedListener
//   speak     → robot.speak(TtsRequest)
// 이 시뮬레이터는 예시 맵 위에서 직선으로 움직이는 것처럼 흉내 낸다.
const pose = { x: LOCATIONS[0].x, y: LOCATIONS[0].y, yaw: 0 };

function createSimDriver() {
  let timer = null;
  return {
    goTo(location, travelSec, { onComplete, onAbort }) {
      this.stop();
      const goal = LOCATIONS.find((l) => l.name === location) ?? LOCATIONS[0];
      const from = { ...pose };
      const speed = Number($('#speed').value);
      const total = (travelSec * 1000) / speed;
      const failAt = $('#fail-next').checked ? total * 0.5 : null;
      $('#fail-next').checked = false;
      const startedAt = Date.now();
      pose.yaw = Math.atan2(goal.y - from.y, goal.x - from.x);
      timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const t = Math.min(1, elapsed / total);
        pose.x = from.x + (goal.x - from.x) * t;
        pose.y = from.y + (goal.y - from.y) * t;
        sendPosition();
        if (failAt !== null && elapsed >= failAt) {
          this.stop();
          return onAbort('장애물로 경로를 찾지 못함 (시뮬레이션)');
        }
        if (t >= 1) {
          this.stop();
          onComplete(location);
        }
      }, POSITION_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    speak(text) {
      if (!$('#tts').checked || !('speechSynthesis' in window)) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ko-KR';
      utterance.volume = 0.3; // 도서관이므로 저음량
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    },
  };
}

const driver = createSimDriver();
const fakeMap = buildFakeMap();
let mapData = null;
toMapData(fakeMap).then((d) => {
  mapData = d;
  paintMap();
});

function sendPosition() {
  send({ type: 'position', x: round(pose.x), y: round(pose.y), yaw: round(pose.yaw) }, { quiet: true });
  paintMap();
}

const round = (n) => Math.round(n * 100) / 100;

// ── 상태 ─────────────────────────────
// TEMI 화면: 대기 · 출발 대기(출발 버튼) · 이동 중(터치 없음, 지도) · 도착(QR 인증, 예비 PIN) · 인증 완료(수령 확인)
const sim = {
  screen: 'idle', // idle | ready | moving | arrived | pin | verified
  task: null, // 서버에서 받은 goTo 내용. 홈베이스로 복귀 중이면 null
  pin: '',
};

// ── 서버 연결 ─────────────────────────────
let ws = null;
let manualOffline = false;

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/robot`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    setConn(true);
    send({ type: 'hello', robotId: 'temi-sim', state: robotState(), locations: LOCATIONS.map((l) => l.name) });
    send({ type: 'map', ...fakeMap }, { quiet: true });
    log('out', `map (${fakeMap.width}x${fakeMap.height}, 위치 ${LOCATIONS.length}개)`);
    sendPosition();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    log('in', msg);
    handlers[msg.type]?.(msg);
  };
  ws.onclose = () => {
    setConn(false);
    if (!manualOffline) setTimeout(connect, 2000);
  };
}

function send(msg, { quiet = false } = {}) {
  if (ws?.readyState !== WebSocket.OPEN) return quiet || log('err', `전송 실패(연결 없음): ${msg.type}`);
  ws.send(JSON.stringify(msg));
  if (!quiet) log('out', msg);
}

function robotState() {
  if (sim.screen === 'moving') return sim.task ? 'moving' : 'returning';
  return { ready: 'ready', arrived: 'arrived', pin: 'arrived', verified: 'arrived' }[sim.screen] ?? 'idle';
}

// ── 서버 메시지 처리 ─────────────────────────────
const handlers = {
  // 첫 시도는 데스크에서 물품을 담고 출발 버튼을 눌러야 출발한다. 재시도는 바로 다시 이동한다.
  goTo(msg) {
    sim.task = msg;
    if (msg.attempt > 1) return startMove(msg);
    setScreen('ready');
    send({ type: 'status', requestId: msg.requestId, state: 'ready' });
  },
  goHome() {
    sim.task = null;
    setScreen('moving');
    send({ type: 'status', state: 'returning' });
    driver.goTo(HOME, HOME_TRAVEL_SEC, {
      onComplete: () => {
        setScreen('idle');
        send({ type: 'status', state: 'idle' });
      },
      onAbort: () => send({ type: 'status', state: 'idle' }),
    });
  },
  verifyResult(msg) {
    if (msg.ok) {
      setScreen('verified');
      const rental = sim.task?.requestType === 'rental';
      driver.speak(rental ? '인증되었습니다. 바구니에서 물품을 꺼내 주세요.' : '인증되었습니다. 바구니에 물품을 넣어 주세요.');
    } else {
      sim.pin = '';
      if (sim.screen === 'pin') render();
      banner(msg.reason ?? '인증 실패', true);
    }
  },
  end(msg) {
    driver.stop();
    const text = {
      completed: '이용해 주셔서 감사합니다',
      cancelled: '요청이 취소되었습니다',
      expired: `요청이 만료되었습니다 · ${msg.reason ?? ''}`,
      failed: `요청을 처리하지 못했습니다 · ${msg.reason ?? ''}`,
    }[msg.status];
    banner(text, msg.status !== 'completed');
    if (msg.status === 'completed') driver.speak('감사합니다.');
    sim.task = null;
    setScreen('idle'); // 밖에 있으면 곧 goHome이 온다
  },
  // 재연결 시 서버가 진행 중이던 요청을 다시 알려 준다
  sync(msg) {
    sim.task = msg;
    if (msg.status === 'preparing') setScreen('ready');
    else if (msg.status === 'moving') startMove(msg);
    else setScreen(msg.status === 'verified' ? 'verified' : 'arrived');
  },
};

function startMove(task) {
  setScreen('moving');
  send({ type: 'status', requestId: task.requestId, state: 'moving' });
  driver.goTo(task.location, task.simTravelSec ?? 8, {
    onComplete: () => {
      setScreen('arrived');
      send({ type: 'status', requestId: task.requestId, state: 'arrived' });
      driver.speak(`${task.seat}번 좌석에 도착했습니다. 앱의 QR 코드를 보여 주세요.`);
    },
    onAbort: (detail) => {
      send({ type: 'status', requestId: task.requestId, state: 'failed', detail });
      banner('이동 실패 · 서버 지시를 기다리는 중', true);
    },
  });
}

// ── 화면 (학생 앱 "도서관 온기"와 같은 디자인) ─────────────────────────────
function setScreen(screen) {
  sim.screen = screen;
  render();
}

const chip = (text, cls = '') => `<span class="t-chip ${cls}">${esc(text)}</span>`;
const kv = (k, v) => `<div class="t-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;

function render() {
  const t = sim.task;
  const rental = t?.requestType === 'rental';
  const kind = rental ? '대여' : '반납';
  const item = t ? `${t.itemName} · ${t.quantity}개` : '';
  const zone = t ? `${t.area ?? ''} ${t.zoneName ?? ''}`.trim() : '';
  const views = {
    idle: () => `
      <div class="t-split">
        <div class="t-col">
          <div class="t-brand">도서관 온기</div>
          <h1 class="t-title">책에 집중하는 시간,<br />필요한 건 temi에게.</h1>
          <p class="t-lead">앱에서 물품을 고르고 좌석 번호를 입력하면<br />자리로 찾아가요.</p>
        </div>
        <div class="t-art">${illustration('temi')}</div>
      </div>`,
    ready: () => `
      <div class="t-split">
        <div class="t-col">
          ${chip(`${kind} · 출발 준비`)}
          <h1 class="t-title big">${esc(t.seat)}번 좌석</h1>
          <div class="t-card">${kv(rental ? '담을 물품' : '받을 물품', item)}${kv('구역', zone)}</div>
        </div>
        <div class="t-col">
          <div class="t-notice">${rental ? '바구니에 물품을 담은 뒤\n출발을 눌러 주세요' : '준비되면 출발을 눌러 주세요'}</div>
          <button class="t-btn" data-key="depart">출발</button>
        </div>
      </div>`,
    // 이동 중에는 터치를 받지 않는다. 지도에 현재 위치를 보여 준다
    moving: () => `
      <div class="t-split map">
        <canvas id="sim-map" class="t-map" aria-label="temi 현재 위치"></canvas>
        <div class="t-col">
          ${chip(t ? (rental ? '배달 중' : '방문 중') : '복귀 중')}
          <h1 class="t-title">${t ? `${esc(t.seat)}번 좌석으로<br />가는 중이에요` : '데스크로<br />돌아가는 중이에요'}</h1>
          <p class="t-lead">길을 비켜 주시면 감사하겠습니다.</p>
        </div>
      </div>`,
    arrived: () => `
      <div class="t-split">
        <div class="t-camera">카메라<br /><small>시뮬레이터에서는 오른쪽 패널의<br />'QR 스캔 흉내'를 쓰세요</small></div>
        <div class="t-col">
          ${chip('도착 · QR 인증 대기')}
          <h1 class="t-title">${esc(t.seat)}번 좌석 ${kind}</h1>
          <div class="t-card">${kv(rental ? '받을 물품' : '돌려줄 물품', item)}</div>
          <p class="t-lead strong">앱의 QR 코드를 카메라에 보여 주세요</p>
          <button class="t-btn ghost" data-key="pin">PIN으로 인증</button>
        </div>
      </div>`,
    pin: () => `
      <div class="t-split">
        <div class="t-col">
          ${chip(`PIN 인증 · ${t.seat}번 좌석`)}
          <h1 class="t-title">앱에 표시된<br />PIN을 입력해 주세요</h1>
          <div class="t-pin" aria-label="입력한 PIN">${[0, 1, 2, 3].map((i) => `<span>${i < sim.pin.length ? '●' : ''}</span>`).join('')}</div>
        </div>
        <div class="t-keys">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-key="${n}">${n}</button>`).join('')}
          <button data-key="qr" class="sub" aria-label="QR로 돌아가기">QR</button>
          <button data-key="0">0</button>
          <button data-key="clear" class="sub" aria-label="지우기">⌫</button>
        </div>
      </div>`,
    verified: () => `
      <div class="t-split">
        <div class="t-col">
          ${chip('인증 완료')}
          <h1 class="t-title">${rental ? '바구니에서<br />물품을 꺼내 주세요' : '바구니에<br />물품을 넣어 주세요'}</h1>
          <div class="t-card">${kv(rental ? '받을 물품' : '돌려줄 물품', item)}
            <div class="t-warn">${rental ? "확인을 눌러야 '대여 중'이 돼요" : '관리자 검수 후 반납이 완료돼요'}</div>
          </div>
        </div>
        <div class="t-col">
          <button class="t-btn" data-key="complete">${rental ? '수령 확인' : '반납 확인'}</button>
        </div>
      </div>`,
  };
  const screen = $('#screen');
  screen.dataset.state = sim.screen;
  screen.innerHTML = views[sim.screen]();
  paintMap();
}

function paintMap() {
  const canvas = $('#sim-map');
  if (!canvas || !mapData) return;
  drawMap(canvas, mapData, {
    robot: pose,
    target: sim.task?.location ?? HOME,
    targetLabel: sim.task ? `${sim.task.seat}번 좌석` : '데스크',
    aspect: 1.25,
  });
}

let bannerTimer = null;
function banner(text, isError = false) {
  const el = $('#banner');
  el.textContent = text;
  el.className = `banner ${isError ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.hidden = true), 3500);
}

function setConn(on) {
  const el = $('#conn');
  el.textContent = on ? '서버 연결됨' : '연결 안 됨';
  el.className = `pill ${on ? 'on' : 'off'}`;
  $('#conn-toggle').textContent = on ? '연결 끊기 (Wi-Fi 끊김 흉내)' : '다시 연결';
}

function log(kind, msg) {
  const li = document.createElement('li');
  li.className = kind;
  const arrow = { in: '← ', out: '→ ', err: '! ' }[kind];
  li.textContent = `${new Date().toLocaleTimeString('ko-KR')} ${arrow}${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  const list = $('#log');
  list.prepend(li);
  while (list.children.length > 80) list.lastChild.remove();
}

// ── 입력 ─────────────────────────────
$('#screen').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (!key || !sim.task) return;
  if (key === 'depart' && sim.screen === 'ready') return startMove(sim.task); // 출발 버튼
  if (key === 'complete' && sim.screen === 'verified') return send({ type: 'complete', requestId: sim.task.requestId });
  if (key === 'pin' && sim.screen === 'arrived') {
    sim.pin = '';
    return setScreen('pin');
  }
  if (sim.screen !== 'pin') return;
  if (key === 'qr') return setScreen('arrived');
  if (key === 'clear') sim.pin = sim.pin.slice(0, -1);
  else if (/^\d$/.test(key) && sim.pin.length < 4) sim.pin += key;
  render();
  if (sim.pin.length === 4) send({ type: 'verify', requestId: sim.task.requestId, code: sim.pin });
});

// 실제 TEMI에서는 카메라로 QR을 읽는다
$('#scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#scan-input').value.trim();
  if (!code) return;
  if (!['arrived', 'pin'].includes(sim.screen) || !sim.task) return banner('도착 상태에서만 스캔할 수 있어요', true);
  send({ type: 'verify', requestId: sim.task.requestId, code });
  $('#scan-input').value = '';
});

$('#conn-toggle').addEventListener('click', () => {
  if (ws?.readyState === WebSocket.OPEN) {
    manualOffline = true;
    ws.close();
  } else {
    manualOffline = false;
    connect();
  }
});

window.addEventListener('resize', paintMap);

render();
connect();
