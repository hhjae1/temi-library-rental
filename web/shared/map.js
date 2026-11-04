// TEMI 맵 위에 temi 현재 위치·목적지·데스크(홈베이스)를 그린다. 학생 앱 배달 현황에서 쓴다.
//
// 좌표 변환 (docs/robot-protocol.md 'map' 메시지):
//   px = (x - originX) / resolution
//   py = height - (y - originY) / resolution   ← PNG는 위쪽이 y가 큰 쪽이 되도록 만들어 보낸다
import { api } from './api.js';

const HOME = 'home base';
const COLORS = {
  background: '#efede6',
  zone: '#9cb8ad',
  target: '#2d6e62',
  home: '#a0642b',
  robot: '#2d6e62',
  label: '#1e2724',
};

let cache = { version: null, data: null };

/** robot.mapVersion이 바뀌었을 때만 서버에서 맵을 다시 받는다. 맵이 없으면 null */
export async function loadMap(version) {
  if (!version) return null;
  if (cache.version === version) return cache.data;
  const { map } = await api('/robot/map');
  if (!map) return null;
  const img = new Image();
  img.src = `data:image/png;base64,${map.png}`;
  await img.decode();
  cache = { version, data: { map, img } };
  return cache.data;
}

export const toPixel = (map, x, y) => [(x - map.originX) / map.resolution, map.height - (y - map.originY) / map.resolution];

const findLocation = (map, name) => map.locations.find((l) => l.name.toLowerCase() === String(name ?? '').toLowerCase());

/**
 * @param canvas  그릴 캔버스 (CSS 폭을 기준으로 해상도를 맞춘다)
 * @param data    loadMap() 결과
 * @param opts    { robot: {x,y,yaw}|null, target: TEMI 위치 이름, targetLabel, aspect }
 */
export function drawMap(canvas, data, { robot = null, target = null, targetLabel = '목적지', aspect = 1.6 } = {}) {
  const { map, img } = data;
  const goal = findLocation(map, target);
  const home = findLocation(map, HOME);

  // 데스크·목적지·temi가 모두 보이게 잘라 낸다. 하나도 없으면 맵 전체
  const points = [goal, home, robot].filter(Boolean).map((p) => toPixel(map, p.x, p.y));
  let [x0, y0, x1, y1] = [0, 0, map.width, map.height];
  if (points.length) {
    const pad = 2 / map.resolution; // 2m 여백
    x0 = Math.min(...points.map((p) => p[0])) - pad;
    x1 = Math.max(...points.map((p) => p[0])) + pad;
    y0 = Math.min(...points.map((p) => p[1])) - pad;
    y1 = Math.max(...points.map((p) => p[1])) + pad;
  }
  // 화면 비율에 맞춰 영역을 넓힌다
  let w = x1 - x0;
  let h = y1 - y0;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const region = { x: cx - w / 2, y: cy - h / 2, w, h };

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round((cssWidth / aspect) * dpr);
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / region.w;
  const screen = (p) => [(p[0] - region.x) * scale, (p[1] - region.y) * scale];

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false; // 격자 맵이라 픽셀을 그대로
  ctx.drawImage(img, 0, 0, map.width, map.height, -region.x * scale, -region.y * scale, map.width * scale, map.height * scale);

  const r = 6 * dpr;
  // 다른 구역은 흐리게
  for (const l of map.locations) {
    if (l === goal || l === home) continue;
    const [sx, sy] = screen(toPixel(map, l.x, l.y));
    dot(ctx, sx, sy, r * 0.7, COLORS.zone);
  }
  if (home) marker(ctx, screen(toPixel(map, home.x, home.y)), '데스크', COLORS.home, r, dpr);
  if (goal) marker(ctx, screen(toPixel(map, goal.x, goal.y)), targetLabel, COLORS.target, r, dpr);
  if (robot) drawRobot(ctx, screen(toPixel(map, robot.x, robot.y)), robot.yaw ?? 0, r * 1.5);
}

function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function marker(ctx, [x, y], label, color, r, dpr) {
  dot(ctx, x, y, r + 2 * dpr, '#fff');
  dot(ctx, x, y, r, color);
  ctx.font = `700 ${12 * dpr}px Pretendard, 'Malgun Gothic', sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 4 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(label, x, y - r - 6 * dpr);
  ctx.fillStyle = color;
  ctx.fillText(label, x, y - r - 6 * dpr);
}

// temi: 흰 테두리 원 + 진행 방향 삼각형 (yaw는 라디안, 맵 x축 기준 반시계)
function drawRobot(ctx, [x, y], yaw, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-yaw); // 화면은 y가 아래로 커지므로 반대로 돈다
  ctx.beginPath();
  ctx.moveTo(r * 1.9, 0);
  ctx.lineTo(r * 0.6, -r * 0.75);
  ctx.lineTo(r * 0.6, r * 0.75);
  ctx.closePath();
  ctx.fillStyle = COLORS.robot;
  ctx.fill();
  ctx.restore();
  dot(ctx, x, y, r + 3, '#fff');
  dot(ctx, x, y, r, COLORS.robot);
}
