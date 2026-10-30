import { fileURLToPath } from 'node:url';

export const defaults = {
  port: Number(process.env.PORT ?? 3000),
  dbFile: process.env.DB_FILE ?? fileURLToPath(new URL('../data/app.db', import.meta.url)),
  seed: true,
  timeouts: {
    queueMs: 10 * 60_000, // 대기열에서 출발하지 못한 채 이만큼 지나면 만료
    moveMs: 3 * 60_000, // 출발 후 도착 보고가 없으면 실패
    arrivalMs: 3 * 60_000, // 도착 후 사용자 인증이 없으면 만료
    receiveMs: 2 * 60_000, // 인증 후 완료 버튼이 없으면 자동 완료 (관리자 확인 대상)
  },
  maxMoveAttempts: 2, // 이동 실패 시 재시도를 포함한 총 시도 횟수
  sweepIntervalMs: 2_000,
  homeLocation: 'home base', // TEMI 충전 스테이션의 기본 위치 이름
};
