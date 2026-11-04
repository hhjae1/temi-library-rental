import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../src/app.js';

const silent = { info() {}, warn() {}, error() {} };
let server;
let base;

before(async () => {
  server = await startServer({ port: 0, dbFile: ':memory:', log: silent, sweepIntervalMs: 60_000 });
  base = `http://localhost:${server.port}`;
});
after(() => server.close());

async function call(path, { method = 'GET', body } = {}, root = base) {
  const res = await fetch(`${root}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

// 시뮬레이터 대신 테스트에서 직접 로봇 역할을 하는 클라이언트
async function connectRobot(port = server.port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/robot`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((resolve) => ws.once('open', resolve));
  const robot = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    has: (type) => inbox.some((m) => m.type === type),
    // 홈베이스로 돌아왔다고 보고 — 이때 다음 요청이 배정된다
    backHome() {
      this.send({ type: 'status', state: 'returning' });
      this.send({ type: 'status', state: 'idle' });
    },
    close: () => ws.close(),
  };
  robot.send({ type: 'hello', robotId: 'test-robot', state: 'idle' });
  return robot;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stockOf = async (itemId, root = base) => (await call('/items', {}, root)).data.find((i) => i.id === itemId).stock;
const waitStatus = async (id, userId, status, root = base) => {
  for (let i = 0; i < 50; i++) {
    const { data } = await call(`/requests/${id}?userId=${userId}`, {}, root);
    if (data.status === status) return data;
    await sleep(20);
  }
  assert.fail(`요청 #${id}가 ${status} 상태가 되지 않음`);
};

test('대여 → 출발 버튼 → 도착 → QR 인증 → 수령 → 홈 복귀 → 방문 반납 → 검수', async () => {
  const robot = await connectRobot();
  const user = 'S2024001';
  const itemId = 1; // USB-C 충전기
  const before = await stockOf(itemId);

  const created = await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, quantity: 2, seat: '128' } });
  assert.equal(created.status, 400, '서비스 구역 밖 좌석은 거절');
  const ok = await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, quantity: 2, seat: '095' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.seat, '95', '좌석 번호 정규화');
  assert.equal(await stockOf(itemId), before - 2, '신청 시 수량만큼 재고 예약');

  const goTo = await robot.next('goTo');
  assert.equal(goTo.requestId, ok.data.id);
  assert.equal(goTo.location, 'humanities-c', '좌석 범위로 지점 결정');
  assert.equal(goTo.seat, '95');
  assert.equal(goTo.quantity, 2);
  assert.equal(goTo.attempt, 1);
  assert.equal(goTo.area, '인문자료실');

  // 출발 버튼 전에는 출발 준비 상태이고, 이동 보고 없이 온 도착 보고는 무시한다
  const preparing = await waitStatus(goTo.requestId, user, 'preparing');
  assert.match(preparing.auth.payload, /^TLR1:/, '배정되면 QR을 미리 받는다');
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
  await sleep(50);
  assert.equal((await call(`/requests/${goTo.requestId}?userId=${user}`)).data.status, 'preparing');

  robot.send({ type: 'status', requestId: goTo.requestId, state: 'moving' }); // 출발 버튼
  const moving = await waitStatus(goTo.requestId, user, 'moving');
  assert.ok(moving.departed_at, '출발 시각 기록');
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
  const arrived = await waitStatus(goTo.requestId, user, 'arrived');
  assert.match(arrived.auth.qrDataUrl, /^data:image\/png;base64,/);

  robot.send({ type: 'verify', requestId: goTo.requestId, code: 'wrong' });
  assert.equal((await robot.next('verifyResult')).ok, false);
  robot.send({ type: 'verify', requestId: goTo.requestId, code: arrived.auth.payload });
  assert.equal((await robot.next('verifyResult')).ok, true);

  robot.send({ type: 'complete', requestId: goTo.requestId });
  assert.equal((await robot.next('end')).status, 'completed');
  assert.equal((await robot.next('goHome')).location, 'home base');

  const [rental] = (await call(`/rentals?userId=${user}`)).data;
  assert.equal(rental.status, 'active');
  assert.equal(rental.seat, '95');

  // 반납: 로봇이 홈베이스로 돌아온 뒤에 배정된다
  const ret = await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, seat: '15' } });
  assert.equal(ret.status, 200);
  await sleep(50);
  assert.equal(robot.has('goTo'), false, '복귀 전에는 배정하지 않음');
  robot.backHome();
  const goTo2 = await robot.next('goTo');
  assert.equal(goTo2.location, 'humanities-a');
  robot.send({ type: 'status', requestId: goTo2.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: goTo2.requestId, state: 'arrived' });
  const arrived2 = await waitStatus(goTo2.requestId, user, 'arrived');
  robot.send({ type: 'verify', requestId: goTo2.requestId, code: arrived2.auth.payload });
  assert.equal((await robot.next('verifyResult')).ok, true);
  assert.equal((await call(`/requests/${goTo2.requestId}/complete`, { method: 'POST', body: { userId: user } })).status, 200);
  await robot.next('end');
  await robot.next('goHome');

  assert.equal((await call(`/rentals?userId=${user}`)).data[0].status, 'returned');
  assert.equal(await stockOf(itemId), before - 2, '검수 전에는 재고 미반영');
  assert.equal((await call(`/admin/rentals/${rental.id}/inspect`, { method: 'POST' })).status, 200);
  assert.equal(await stockOf(itemId), before, '검수 후 재고 반영');
  robot.close();
});

test('좌석 번호는 숫자이고 서비스 구역 안이어야 한다', async () => {
  for (const seat of ['', 'A-7', '12a', '0', '121', '99999']) {
    const { status } = await call('/requests', { method: 'POST', body: { userId: 'S-seat', type: 'rental', itemId: 3, seat } });
    assert.equal(status, 400, `좌석 '${seat}'`);
  }
  const info = await call('/info');
  assert.deepEqual(info.data, { serviceArea: '인문자료실', seatMin: 1, seatMax: 120 });
});

test('마지막 재고에 동시 신청하면 한 명만 성공', async () => {
  const itemId = 2;
  const stock = await stockOf(itemId);
  await call(`/admin/items/${itemId}`, { method: 'PUT', body: { stock: 1 } });
  const results = await Promise.all(
    ['U1', 'U2', 'U3'].map((userId) => call('/requests', { method: 'POST', body: { userId, type: 'rental', itemId, seat: '1' } })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  const winner = results.find((r) => r.status === 200).data;
  await call(`/requests/${winner.id}/cancel`, { method: 'POST', body: { userId: winner.user_id } });
  assert.equal(await stockOf(itemId), 1, '취소 시 재고 복구');
  await call(`/admin/items/${itemId}`, { method: 'PUT', body: { stock } });
});

test('이동이 계속 실패하면 재시도 후 실패 처리하고 재고 복구', async () => {
  const robot = await connectRobot();
  const user = 'S2024002';
  const itemId = 4; // 담요
  const before = await stockOf(itemId);
  const created = await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, seat: '7' } });

  const first = await robot.next('goTo');
  robot.send({ type: 'status', requestId: first.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: first.requestId, state: 'failed', detail: '경로 막힘' });
  const retry = await robot.next('goTo');
  assert.equal(retry.attempt, 2, '재시도는 출발 버튼 없이 바로 이동');
  robot.send({ type: 'status', requestId: retry.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: retry.requestId, state: 'failed', detail: '경로 막힘' });
  assert.equal((await robot.next('end')).status, 'failed');
  await robot.next('goHome');

  const { data } = await call(`/requests/${created.data.id}?userId=${user}`);
  assert.equal(data.status, 'failed');
  assert.equal(data.fail_reason, '경로 막힘');
  assert.equal(await stockOf(itemId), before);
  robot.close();
});

test('인증 후 수령 확인이 없으면 만료하고 재고를 되돌린다', async () => {
  const fast = await startServer({
    port: 0, dbFile: ':memory:', log: silent, sweepIntervalMs: 20, timeouts: { receiveMs: 100 },
  });
  const root = `http://localhost:${fast.port}`;
  try {
    const robot = await connectRobot(fast.port);
    const user = 'S2024003';
    const itemId = 5; // 물티슈
    const before = await stockOf(itemId, root);
    await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, seat: '50' } }, root);
    const goTo = await robot.next('goTo');
    robot.send({ type: 'status', requestId: goTo.requestId, state: 'moving' });
    robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
    const arrived = await waitStatus(goTo.requestId, user, 'arrived', root);
    robot.send({ type: 'verify', requestId: goTo.requestId, code: arrived.auth.payload });
    assert.equal((await robot.next('verifyResult')).ok, true);

    const end = await robot.next('end');
    assert.equal(end.status, 'expired');
    const { data } = await call(`/requests/${goTo.requestId}?userId=${user}`, {}, root);
    assert.equal(data.status, 'expired');
    assert.match(data.fail_reason, /바구니 확인 필요/);
    assert.equal(await stockOf(itemId, root), before, '만료되면 재고 복구');
    assert.equal((await call(`/rentals?userId=${user}`, {}, root)).data.length, 0, '대여 기록 없음');
    robot.close();
  } finally {
    await fast.close();
  }
});

test('QR이 안 되면 앱의 PIN으로도 인증할 수 있다 (예비 인증)', async () => {
  const robot = await connectRobot();
  const user = 'S2024009';
  await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId: 5, seat: '50' } }); // 물티슈
  const goTo = await robot.next('goTo');
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
  const arrived = await waitStatus(goTo.requestId, user, 'arrived');
  assert.match(arrived.auth.pin, /^\d{4}$/);
  robot.send({ type: 'verify', requestId: goTo.requestId, code: arrived.auth.pin });
  assert.equal((await robot.next('verifyResult')).ok, true);
  robot.send({ type: 'complete', requestId: goTo.requestId });
  assert.equal((await robot.next('end')).status, 'completed');
  await robot.next('goHome');
  robot.backHome();
  robot.close();
});

test('TEMI 맵과 실시간 위치를 받아 화면에 넘겨준다', async () => {
  const robot = await connectRobot();
  const png = Buffer.from('fake-png').toString('base64');
  robot.send({
    type: 'map', png, width: 200, height: 100, originX: -2, originY: -1, resolution: 0.05,
    locations: [{ name: 'home base', x: 0, y: 0 }, { name: 'humanities-a', x: 3, y: 1.5 }, { name: 1, x: 'bad' }],
  });
  let snap;
  for (let i = 0; i < 50 && !snap?.mapVersion; i++) {
    await sleep(20);
    snap = (await call('/robot')).data;
  }
  assert.ok(snap.mapVersion, '맵을 받으면 mapVersion이 생긴다');
  const { map } = (await call('/robot/map')).data;
  assert.equal(map.png, png);
  assert.deepEqual(map.locations.map((l) => l.name), ['home base', 'humanities-a'], '잘못된 위치는 버린다');

  robot.send({ type: 'position', x: 1.25, y: 0.5, yaw: 1.57 });
  let position;
  for (let i = 0; i < 50 && !position; i++) {
    await sleep(20);
    position = (await call('/robot')).data.position;
  }
  assert.deepEqual({ x: position.x, y: position.y, yaw: position.yaw }, { x: 1.25, y: 0.5, yaw: 1.57 });
  robot.close();
});
