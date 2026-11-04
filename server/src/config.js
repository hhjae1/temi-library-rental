import { fileURLToPath } from 'node:url';

export const defaults = {
  port: Number(process.env.PORT ?? 3000),
  dbFile: process.env.DB_FILE ?? fileURLToPath(new URL('../data/app.db', import.meta.url)),
  seed: true,
  serviceArea: '인문자료실', // 서비스 구역. 학생은 좌석 번호만 입력한다
  timeouts: {
    queueMs: 10 * 60_000, // 대기열에서 로봇 배정을 받지 못한 채 이만큼 지나면 만료
    prepareMs: 10 * 60_000, // 배정 후 데스크에서 출발 버튼을 누르지 않으면 만료
    moveMs: 3 * 60_000, // 출발(버튼) 후 도착 보고가 없으면 실패
    arrivalMs: 3 * 60_000, // 도착 후 QR 인증이 없으면 만료
    receiveMs: 2 * 60_000, // 인증 후 수령·반납 확인이 없으면 만료 (바구니 확인 필요)
  },
  maxMoveAttempts: 2, // 이동 실패 시 재시도를 포함한 총 시도 횟수
  sweepIntervalMs: 2_000,
  homeLocation: 'home base', // TEMI 충전 스테이션의 기본 위치 이름
};
