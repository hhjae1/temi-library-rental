// 시뮬레이터용 예시 도서관 맵. 실제 TEMI 앱이 보내는 'map' 메시지와 같은 형식으로 만든다.
// 위치 이름은 서버 시드(zones.temi_location)와 같다. 좌표 단위는 m, 원점은 왼쪽 아래.

const RESOLUTION = 0.05; // 1픽셀 = 5cm
const WIDTH_M = 24;
const HEIGHT_M = 14;

export const LOCATIONS = [
  { name: 'home base', x: 2.5, y: 2.5 },
  { name: 'humanities-a', x: 7, y: 10.5 },
  { name: 'humanities-b', x: 12.5, y: 10.5 },
  { name: 'humanities-c', x: 18, y: 10.5 },
];

export function buildFakeMap() {
  const width = Math.round(WIDTH_M / RESOLUTION);
  const height = Math.round(HEIGHT_M / RESOLUTION);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // m 단위 사각형을 픽셀로. PNG 위쪽이 y가 큰 쪽
  const rect = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x / RESOLUTION, height - (y + h) / RESOLUTION, w / RESOLUTION, h / RESOLUTION);
  };

  rect(0, 0, WIDTH_M, HEIGHT_M, '#e3e0d8'); // 바깥 (알 수 없는 영역)
  rect(0.4, 0.4, WIDTH_M - 0.8, HEIGHT_M - 0.8, '#b9c3be'); // 벽
  rect(0.6, 0.6, WIDTH_M - 1.2, HEIGHT_M - 1.2, '#ffffff'); // 통로
  rect(0.6, 0.6, 4.5, 4, '#f3eee3'); // 대여 데스크 구역
  for (let i = 0; i < 6; i++) rect(5 + i * 3.2, 2, 0.6, 5.5, '#c9d3ce'); // 서가
  for (let i = 0; i < 3; i++) rect(5 + i * 5.5, 11.8, 4, 1.2, '#dbe6e1'); // 열람석

  return {
    png: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
    width,
    height,
    originX: 0,
    originY: 0,
    resolution: RESOLUTION,
    locations: LOCATIONS,
    name: '예시 인문자료실 (시뮬레이터)',
  };
}

/** 시뮬레이터 화면에서 shared/map.js drawMap()에 넘길 { map, img } */
export async function toMapData(map) {
  const img = new Image();
  img.src = `data:image/png;base64,${map.png}`;
  await img.decode();
  return { map, img };
}
