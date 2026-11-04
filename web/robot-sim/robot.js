import { $, esc } from '/shared/api.js';

const HOME = 'home base';
const HOME_TRAVEL_SEC = 5;

// ── 로봇 드라이버 ─────────────────────────────
// 실제 TEMI에서는 temi-android/RobotBridge.kt가 같은 일을 SDK로 한다.
//   goTo      → robot.goTo(location) + OnGoToLocationStatusChangedListener
//   speak     → robot.speak(TtsRequest)
// 이 시뮬레이터는 타이머로 이동을 흉내 낸다.
function createSimDriver() {
  let timer = null;
  return {
    goTo(location, travelSec, { onProgress, onComplete, onAbort }) {
      this.stop();
      const speed = Number($('#speed').value);
      const total = (travelSec * 1000) / speed;
      const failAt = $('#fail-next').checked ? total * 0.5 : null;
      $('#fail-next').checked = false;
      const startedAt = Date.now();
      timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (failAt !== null && elapsed >= failAt) {
          this.stop();
          return onAbort('장애물로 경로를 찾지 못함 (시뮬레이션)');
        }
        onProgress(Math.min(1, elapsed / total));
        if (elapsed >= total) {
          this.stop();
          onComplete(location);
        }
      }, 200);
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

// ── 상태 ─────────────────────────────
// TEMI 화면은 네 가지뿐이다: 대기 · 출발 대기(출발 버튼) · 이동 중(터치 없음) · 도착(QR 인증 → 수령 확인)
const sim = {
  screen: 'idle', // idle | ready | moving | arrived | verified
  task: null, // 서버에서 받은 goTo 내용. 홈베이스로 복귀 중이면 null
};

// ── 서버 연결 ─────────────────────────────
let ws = null;
let manualOffline = false;

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/robot`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    setConn(true);
    send({ type: 'hello', robotId: 'temi-sim', state: robotState() });
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

function send(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return log('err', `전송 실패(연결 없음): ${msg.type}`);
  ws.send(JSON.stringify(msg));
  log('out', msg);
}

function robotState() {
  if (sim.screen === 'moving') return sim.task ? 'moving' : 'returning';
  return { ready: 'ready', arrived: 'arrived', verified: 'arrived' }[sim.screen] ?? 'idle';
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
      onProgress() {},
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
    onProgress() {},
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

// ── 화면 ─────────────────────────────
function setScreen(screen) {
  sim.screen = screen;
  render();
}

function render() {
  const t = sim.task;
  const rental = t?.requestType === 'rental';
  const views = {
    idle: () => `
      <div class="scr">
        <div class="eyes"><span></span><span></span></div>
        <h1>TEMI 물품 대여</h1>
        <p>앱에서 신청하면 자리로 찾아가요</p>
      </div>`,
    ready: () => `
      <div class="scr">
        <p class="eyebrow">${rental ? '대여 · 출발 준비' : '반납 · 출발 준비'}</p>
        <h1>${esc(t.seat)}번 좌석</h1>
        <p>${esc(t.itemName)} ${t.quantity}개</p>
        <p class="big">${rental ? '바구니에 물품을 담고 출발을 눌러 주세요' : '준비되면 출발을 눌러 주세요'}</p>
        <button class="temi-btn" data-key="depart">출발</button>
      </div>`,
    // 이동 중에는 화면을 어둡게 하고 터치를 받지 않는다
    moving: () => `<div class="scr"><p class="moving-text">이동 중입니다</p></div>`,
    arrived: () => `
      <div class="scr">
        <p class="eyebrow">도착했습니다</p>
        <h1>${esc(t.seat)}번 좌석 ${rental ? '대여' : '반납'}</h1>
        <p>${esc(t.itemName)} ${t.quantity}개</p>
        <p class="big">앱의 QR 코드를 카메라에 보여 주세요</p>
      </div>`,
    verified: () => `
      <div class="scr">
        <p class="eyebrow">인증 완료</p>
        <h1>${rental ? '바구니에서 물품을 꺼내 주세요' : '바구니에 물품을 넣어 주세요'}</h1>
        <p>${esc(t.itemName)} ${t.quantity}개 · 다 되었으면 아래 버튼을 눌러 주세요</p>
        <button class="temi-btn" data-key="complete">${rental ? '수령 확인' : '반납 확인'}</button>
      </div>`,
  };
  const screen = $('#screen');
  screen.dataset.state = sim.screen;
  screen.innerHTML = views[sim.screen]();
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
  if (key === 'depart' && sim.screen === 'ready') startMove(sim.task); // 출발 버튼
  if (key === 'complete' && sim.screen === 'verified') send({ type: 'complete', requestId: sim.task.requestId });
});

// 실제 TEMI에서는 카메라로 QR을 읽는다 (SDK 지원 여부 검증 필요)
$('#scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#scan-input').value.trim();
  if (!code) return;
  if (sim.screen !== 'arrived' || !sim.task) return banner('도착 상태에서만 스캔할 수 있어요', true);
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

render();
connect();
