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

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

// 시뮬레이터 대신 테스트에서 직접 로봇 역할을 하는 클라이언트
async function connectRobot() {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws/robot`);
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
    close: () => ws.close(),
  };
  robot.send({ type: 'hello', robotId: 'test-robot', state: 'idle' });
  return robot;
}

const stockOf = async (itemId) => (await call('/items')).data.find((i) => i.id === itemId).stock;
const waitStatus = async (id, userId, status) => {
  for (let i = 0; i < 50; i++) {
    const { data } = await call(`/requests/${id}?userId=${userId}`);
    if (data.status === status) return data;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`요청 #${id}가 ${status} 상태가 되지 않음`);
};

test('대여 → 도착 → QR 인증 → 수령 → 방문 반납 → 검수', async () => {
  const robot = await connectRobot();
  const user = 'S2024001';
  const itemId = 1; // USB-C 충전기
  const before = await stockOf(itemId);

  const created = await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, quantity: 2, stationId: 1, seat: '128' } });
  assert.equal(created.status, 200);
  assert.equal(await stockOf(itemId), before - 2, '신청 시 수량만큼 재고 예약');

  const goTo = await robot.next('goTo');
  assert.equal(goTo.requestId, created.data.id);
  assert.equal(goTo.location, 'f1-humanities');
  assert.equal(goTo.seat, '128');
  assert.equal(goTo.quantity, 2);
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'moving' });
  robot.send({ type: 'status', requestId: goTo.requestId, state: 'arrived' });
  const arrived = await waitStatus(goTo.requestId, user, 'arrived');
  assert.match(arrived.auth.payload, /^TLR1:/);
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

  // 반납: PIN으로 인증하고 앱에서 완료
  const ret = await call('/requests', { method: 'POST', body: { userId: user, type: 'return', rentalId: rental.id, stationId: 2, seat: '15' } });
  assert.equal(ret.status, 200);
  const goTo2 = await robot.next('goTo');
  robot.send({ type: 'status', requestId: goTo2.requestId, state: 'arrived' });
  const arrived2 = await waitStatus(goTo2.requestId, user, 'arrived');
  robot.send({ type: 'verify', requestId: goTo2.requestId, code: arrived2.auth.pin });
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

test('마지막 재고에 동시 신청하면 한 명만 성공', async () => {
  const itemId = 2;
  const stock = await stockOf(itemId);
  await call(`/admin/items/${itemId}`, { method: 'PUT', body: { stock: 1 } });
  const results = await Promise.all(
    ['U1', 'U2', 'U3'].map((userId) =>
      call('/requests', { method: 'POST', body: { userId, type: 'rental', itemId, stationId: 1, seat: '1' } }),
    ),
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
  const created = await call('/requests', { method: 'POST', body: { userId: user, type: 'rental', itemId, stationId: 3, seat: 'A-7' } });

  const first = await robot.next('goTo');
  robot.send({ type: 'status', requestId: first.requestId, state: 'failed', detail: '경로 막힘' });
  const retry = await robot.next('goTo');
  assert.equal(retry.attempt, 2);
  robot.send({ type: 'status', requestId: retry.requestId, state: 'failed', detail: '경로 막힘' });
  assert.equal((await robot.next('end')).status, 'failed');

  const { data } = await call(`/requests/${created.data.id}?userId=${user}`);
  assert.equal(data.status, 'failed');
  assert.equal(data.fail_reason, '경로 막힘');
  assert.equal(await stockOf(itemId), before);
  robot.close();
});
