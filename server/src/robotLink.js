import { WebSocketServer } from 'ws';
import { RobotState } from './protocol.js';

const HEARTBEAT_MS = 15_000;

// TEMI(또는 시뮬레이터)와의 WebSocket 연결. 로봇은 1대만 가정한다.
export function createRobotLink({ server, bus, path = '/ws/robot', log = console }) {
  const wss = new WebSocketServer({ server, path });
  const handlers = [];
  let socket = null;
  const snapshot = { connected: false, state: RobotState.OFFLINE, robotId: null, requestId: null, lastSeen: null };

  function update(patch) {
    Object.assign(snapshot, patch);
    bus.emit('robot', { ...snapshot });
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
      const patch = { lastSeen: Date.now() };
      if (msg.type === 'hello') Object.assign(patch, { robotId: msg.robotId ?? null, state: msg.state ?? RobotState.IDLE });
      if (msg.type === 'status') {
        patch.state = msg.state === 'failed' ? RobotState.IDLE : msg.state;
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
