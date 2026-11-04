import { WebSocketServer } from 'ws';
import { RobotState } from './protocol.js';

const HEARTBEAT_MS = 15_000;

// TEMI(또는 시뮬레이터)와의 WebSocket 연결. 로봇은 1대만 가정한다.
export function createRobotLink({ server, bus, path = '/ws/robot', log = console }) {
  const wss = new WebSocketServer({ server, path });
  const handlers = [];
  let socket = null;
  const snapshot = {
    connected: false,
    state: RobotState.OFFLINE,
    robotId: null,
    requestId: null,
    lastSeen: null,
    position: null, // TEMI 맵 좌표 { x, y, yaw, at }
    mapVersion: null, // 맵을 받을 때마다 바뀐다. 화면은 바뀌면 GET /api/robot/map 으로 다시 받는다
  };
  let map = null; // TEMI 맵 이미지(PNG)와 좌표 정보. 크기가 커서 snapshot과 따로 둔다

  function update(patch) {
    Object.assign(snapshot, patch);
    bus.emit('robot', { ...snapshot });
  }

  // 위치는 1초에 몇 번씩 오므로 'robot' 전체 대신 가벼운 'position' 이벤트만 보낸다
  function onPosition(msg) {
    const { x, y, yaw } = msg;
    if (![x, y].every(Number.isFinite)) return;
    snapshot.position = { x, y, yaw: Number.isFinite(yaw) ? yaw : 0, at: Date.now() };
    snapshot.lastSeen = snapshot.position.at;
    bus.emit('position', snapshot.position);
  }

  function onMap(msg) {
    const { png, width, height, originX, originY, resolution } = msg;
    if (typeof png !== 'string' || ![width, height, originX, originY, resolution].every(Number.isFinite)) {
      return log.warn('[robot] 잘못된 map 메시지');
    }
    const locations = (msg.locations ?? [])
      .filter((l) => typeof l?.name === 'string' && Number.isFinite(l.x) && Number.isFinite(l.y))
      .map(({ name, x, y }) => ({ name, x, y }));
    map = { png, width, height, originX, originY, resolution, locations, name: msg.name ?? null };
    update({ mapVersion: Date.now(), lastSeen: Date.now() });
    log.info(`[robot] 맵 수신 ${width}x${height}, 위치 ${locations.length}개`);
  }

  wss.on('connection', (ws) => {
    if (socket) socket.terminate(); // 새 연결이 오면 이전 연결은 끊는다
    socket = ws;
    ws.isAlive = true;
    update({ connected: true, state: RobotState.IDLE, lastSeen: Date.now() });
    log.info('[robot] connected');

    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return log.warn('[robot] invalid JSON');
      }
      if (msg.type === 'position') return onPosition(msg);
      if (msg.type === 'map') return onMap(msg);
      const patch = { lastSeen: Date.now() };
      if (msg.type === 'hello') Object.assign(patch, { robotId: msg.robotId ?? null, state: msg.state ?? RobotState.IDLE });
      if (msg.type === 'status') {
        patch.state = msg.state === 'failed' ? RobotState.STOPPED : msg.state; // 실패하면 길 위에 멈춰 있다 (홈베이스 아님)
        patch.requestId = msg.requestId ?? null;
      }
      update(patch);
      for (const fn of handlers) fn(msg);
    });
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      update({ connected: false, state: RobotState.OFFLINE });
      log.info('[robot] disconnected');
    });
  });

  // Wi-Fi 끊김 등으로 죽은 연결을 정리한다
  const heartbeat = setInterval(() => {
    if (!socket) return;
    if (!socket.isAlive) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  }, HEARTBEAT_MS);

  return {
    get connected() {
      return snapshot.connected;
    },
    snapshot: () => ({ ...snapshot }),
    map: () => map,
    send(msg) {
      if (!socket || socket.readyState !== socket.OPEN) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    onMessage: (fn) => handlers.push(fn),
    close() {
      clearInterval(heartbeat);
      socket?.terminate();
      wss.close();
    },
  };
}
