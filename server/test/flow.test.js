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

test('대여 → 출발 버튼 → 도착 → QR 인증 → 대여 완료 → 복귀 → 방문 반납 → 복귀 → 회수 완료', async () => {
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
  assert.equal(robot.has('desk'), false, '대여를 마치고 돌아오면 회수할 물건이 없다');
  robot.send({ type: 'status', requestId: goTo2.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: goTo2.requestId, state: 'arrived' });

  // 반납은 QR 인증 없이 도착하면 바로 반납 완료를 누른다
  const arrived2 = await waitStatus(goTo2.requestId, user, 'arrived');
  assert.equal(arrived2.auth, undefined, '반납에는 QR을 주지 않는다');
  robot.send({ type: 'verify', requestId: goTo2.requestId, code: 'anything' });
  assert.equal((await robot.next('verifyResult')).ok, false);
  assert.equal((await call(`/requests/${goTo2.requestId}/complete`, { method: 'POST', body: { userId: user } })).status, 200, '앱에서도 완료할 수 있다');
  await robot.next('end');
  await robot.next('goHome');

  assert.equal((await call(`/rentals?userId=${user}`)).data[0].status, 'returned');
  assert.equal(await stockOf(itemId), before - 2, '회수 전에는 재고 미반영');

  // 데스크로 돌아오면 회수 완료를 받아야 재고가 돌아온다
  robot.backHome();
  const desk = await robot.next('desk');
  assert.equal(desk.mode, 'collect');
  assert.equal(desk.requestId, goTo2.requestId);
  assert.equal(desk.next, null);
  robot.send({ type: 'collected', requestId: desk.requestId });
  assert.equal((await robot.next('deskDone')).requestId, desk.requestId);
  assert.equal(await stockOf(itemId), before, '회수 완료하면 재고 반영');
  assert.equal((await call(`/rentals?userId=${user}`)).data[0].status, 'inspected');
  assert.equal((await fetch(`${base}/api/admin/rentals/${rental.id}/inspect`, { method: 'POST' })).status, 404, '웹 검수는 없어졌다');
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

test('이동이 계속 실패하면 재시도 후 복귀하고, 회수 완료를 받아 재고 복구', async () => {
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
  assert.equal(await stockOf(itemId), before - 1, '바구니에 있으니 회수 전에는 재고 미반영');

  robot.backHome();
  const desk = await robot.next('desk');
  assert.equal(desk.mode, 'collect');
  robot.send({ type: 'collected', requestId: desk.requestId });
  await robot.next('deskDone');
  assert.equal(await stockOf(itemId), before, '회수 완료하면 재고 복구');
  robot.close();
});

// 시간 초과를 빠르게 시험하는 서버
async function withFastServer(timeouts, fn) {
  const fast = await startServer({ port: 0, dbFile: ':memory:', log: silent, sweepIntervalMs: 20, timeouts });
  try {
    await fn(fast.port, `http://localhost:${fast.port}`);
  } finally {
    await fast.close();
  }
}

// 대여 요청을 QR 인증까지 진행한다
async function rentUntilVerified(robot, user, itemId, seat, root = base) {
  await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, seat } }, root);
  const goTo = await robot.next('goTo');
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
  const arrived = await waitStatus(goTo.requestId, user, 'arrived', root);
  robot.send({ type: 'verify', requestId: goTo.requestId, code: arrived.auth.payload });
  assert.equal((await robot.next('verifyResult')).ok, true);
  return goTo;
}

for (const { found, stock, rentals, label } of [
  { found: true, stock: 0, rentals: 0, label: '물건 있음 → 재고 복구' },
  { found: false, stock: -1, rentals: 1, label: '물건 없음 → 학생이 가져감, 대여 처리' },
]) {
  test(`인증 후 대여 완료 없이 시간이 지나면 데스크에서 확인: ${label}`, () =>
    withFastServer({ receiveMs: 100 }, async (port, root) => {
      const robot = await connectRobot(port);
      const user = 'S2024003';
      const itemId = 4; // 담요
      const before = await stockOf(itemId, root);
      const goTo = await rentUntilVerified(robot, user, itemId, '50', root);

      assert.equal((await robot.next('end')).status, 'expired');
      await robot.next('goHome');
      const { data } = await call(`/requests/${goTo.requestId}?userId=${user}`, {}, root);
      assert.match(data.fail_reason, /바구니 확인 필요/);
      assert.equal(await stockOf(itemId, root), before - 1, '확인 전에는 재고를 정하지 않는다');

      robot.backHome();
      const desk = await robot.next('desk');
      assert.equal(desk.mode, 'check');
      assert.equal(desk.next, null);
      robot.send({ type: 'collected', requestId: desk.requestId }); // 고르지 않으면 처리되지 않는다
      await robot.next('deskDone');
      assert.equal((await call(`/requests/${goTo.requestId}?userId=${user}`, {}, root)).data.desk_state, 'check');

      robot.send({ type: 'status', state: 'idle' });
      const again = await robot.next('desk');
      robot.send({ type: 'collected', requestId: again.requestId, found });
      await robot.next('deskDone');
      assert.equal(await stockOf(itemId, root), before + stock);
      const list = (await call(`/rentals?userId=${user}`, {}, root)).data;
      assert.equal(list.length, rentals);
      if (rentals) assert.equal(list[0].status, 'active');
      robot.close();
    }));
}

for (const { found, status, stock, label } of [
  { found: true, status: 'inspected', stock: 1, label: '물건 있음 → 반납 처리' },
  { found: false, status: 'active', stock: 0, label: '물건 없음 → 계속 대여 중' },
]) {
  test(`도착 후 반납 완료 없이 시간이 지나면 데스크에서 확인: ${label}`, () =>
    withFastServer({ arrivalMs: 150 }, async (port, root) => {
      const robot = await connectRobot(port);
      const user = 'S2024004';
      const itemId = 4;
      const goTo = await rentUntilVerified(robot, user, itemId, '50', root);
      robot.send({ type: 'complete', requestId: goTo.requestId });
      await robot.next('end');
      await robot.next('goHome');
      const [rental] = (await call(`/rentals?userId=${user}`, {}, root)).data;
      const before = await stockOf(itemId, root);

      await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, seat: '50' } }, root);
      robot.backHome();
      const ret = await robot.next('goTo');
      robot.send({ type: 'status', requestId: ret.requestId, state: 'moving' });
      robot.send({ type: 'status', requestId: ret.requestId, state: 'arrived' });
      assert.equal((await robot.next('end')).status, 'expired');
      await robot.next('goHome');
      assert.equal((await call(`/rentals?userId=${user}`, {}, root)).data[0].status, 'returning');

      robot.backHome();
      const desk = await robot.next('desk');
      assert.equal(desk.mode, 'check');
      robot.send({ type: 'collected', requestId: desk.requestId, found });
      await robot.next('deskDone');
      assert.equal((await call(`/rentals?userId=${user}`, {}, root)).data[0].status, status);
      assert.equal(await stockOf(itemId, root), before + stock);
      robot.close();
    }));
}

test('반납을 회수할 때 다음 요청이 있으면 버튼 하나로 바로 출발한다', async () => {
  const robot = await connectRobot();
  const user = 'S2024005';
  const itemId = 4;
  const goTo = await rentUntilVerified(robot, user, itemId, '30');
  robot.send({ type: 'complete', requestId: goTo.requestId });
  await robot.next('end');
  await robot.next('goHome');
  const [rental] = (await call(`/rentals?userId=${user}`)).data;
  robot.backHome();
  await sleep(30);

  await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, seat: '30' } });
  const ret = await robot.next('goTo');
  robot.send({ type: 'status', requestId: ret.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: ret.requestId, state: 'arrived' });
  await waitStatus(ret.requestId, user, 'arrived');
  robot.send({ type: 'complete', requestId: ret.requestId });
  await robot.next('end');
  await robot.next('goHome');

  // temi가 돌아오는 사이 다음 대여 요청이 들어온다
  const other = await call('/requests', { method: 'POST', body: { userId: 'S2024006', type: 'rental', itemId: 5, seat: '60' } });
  robot.backHome();
  const desk = await robot.next('desk');
  assert.equal(desk.next.requestId, other.data.id, '회수 화면에서 다음 요청을 보여 준다');
  assert.equal(desk.next.seat, '60');
  await sleep(30);
  assert.equal(robot.has('goTo'), false, '회수 완료 전에는 배정하지 않는다');

  robot.send({ type: 'collected', requestId: desk.requestId, nextRequestId: desk.next.requestId });
  await robot.next('deskDone');
  const next = await robot.next('goTo');
  assert.equal(next.requestId, other.data.id);
  assert.equal(next.immediate, true, '출발 버튼을 다시 누르지 않는다');
  robot.send({ type: 'status', requestId: next.requestId, state: 'moving' });
  await waitStatus(next.requestId, 'S2024006', 'moving');
  await call(`/requests/${next.requestId}/cancel`, { method: 'POST', body: { userId: 'S2024006' } });
  await robot.next('end');
  await robot.next('goHome');
  robot.backHome();
  const leftover = await robot.next('desk');
  assert.equal(leftover.mode, 'collect', '이동 중 취소한 대여는 바구니에 물건이 있다');
  robot.send({ type: 'collected', requestId: leftover.requestId });
  await robot.next('deskDone');
  robot.close();
});

test('회수 화면에 있는 동안 다음 요청이 들어오면 화면을 다시 알려 준다', async () => {
  const robot = await connectRobot();
  const user = 'S2024007';
  const itemId = 4;
  const goTo = await rentUntilVerified(robot, user, itemId, '30');
  await call(`/requests/${goTo.requestId}/complete`, { method: 'POST', body: { userId: user } });
  await robot.next('end');
  await robot.next('goHome');
  const [rental] = (await call(`/rentals?userId=${user}`)).data;
  await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, seat: '30' } });
  robot.backHome();
  const ret = await robot.next('goTo');
  robot.send({ type: 'status', requestId: ret.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: ret.requestId, state: 'arrived' });
  await waitStatus(ret.requestId, user, 'arrived');
  robot.send({ type: 'complete', requestId: ret.requestId });
  await robot.next('end');
  await robot.next('goHome');
  robot.backHome();
  const desk = await robot.next('desk');
  assert.equal(desk.next, null);

  const other = await call('/requests', { method: 'POST', body: { userId: 'S2024008', type: 'rental', itemId: 5, seat: '60' } });
  const updated = await robot.next('desk');
  assert.equal(updated.next.requestId, other.data.id);
  // 화면이 바뀌기 전에 눌렀어도(nextRequestId 없음) 다음 요청은 출발 준비 화면으로 간다
  robot.send({ type: 'collected', requestId: desk.requestId });
  await robot.next('deskDone');
  const next = await robot.next('goTo');
  assert.equal(next.immediate, false);
  await call(`/requests/${next.requestId}/cancel`, { method: 'POST', body: { userId: 'S2024008' } });
  await robot.next('end');
  assert.equal(robot.has('desk'), false, '출발 전 취소는 회수할 것이 없다');
  robot.close();
});

test('반납하러 가는 중에 취소하면 바구니가 비어 있어 회수 없이 끝난다', async () => {
  const robot = await connectRobot();
  const user = 'S2024010';
  const itemId = 4;
  const goTo = await rentUntilVerified(robot, user, itemId, '30');
  robot.send({ type: 'complete', requestId: goTo.requestId });
  await robot.next('end');
  await robot.next('goHome');
  const [rental] = (await call(`/rentals?userId=${user}`)).data;
  const before = await stockOf(itemId);
  await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, seat: '30' } });
  robot.backHome();
  const ret = await robot.next('goTo');
  robot.send({ type: 'status', requestId: ret.requestId, state: 'moving' });
  await waitStatus(ret.requestId, user, 'moving');
  await call(`/requests/${ret.requestId}/cancel`, { method: 'POST', body: { userId: user } });
  await robot.next('end');
  await robot.next('goHome');
  robot.backHome();
  await sleep(50);
  assert.equal(robot.has('desk'), false);
  assert.equal((await call(`/rentals?userId=${user}`)).data[0].status, 'active');
  assert.equal(await stockOf(itemId), before);
  robot.close();
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
