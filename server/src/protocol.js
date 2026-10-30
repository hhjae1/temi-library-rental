// 서버·앱·로봇이 공유하는 상태 값과 메시지 타입.
// 로봇 메시지 형식은 docs/robot-protocol.md 참고.

export const RequestStatus = Object.freeze({
  QUEUED: 'queued', // 신청 완료, 재고 예약됨, 로봇 배정 대기
  MOVING: 'moving', // TEMI가 지점으로 이동 중
  ARRIVED: 'arrived', // 지점 도착, 사용자 인증 대기
  VERIFIED: 'verified', // QR/PIN 인증 완료, 물품 수령·반납 중
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const OPEN_STATUSES = ['queued', 'moving', 'arrived', 'verified'];
export const DISPATCHED_STATUSES = ['moving', 'arrived', 'verified'];
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired'];

export const RentalStatus = Object.freeze({
  ACTIVE: 'active', // 대여 중
  RETURNING: 'returning', // 반납 요청 진행 중
  RETURNED: 'returned', // 바구니에 반납됨, 관리자 검수 대기
  INSPECTED: 'inspected', // 검수 완료, 재고 반영됨
  CONSUMED: 'consumed', // 소모품 (반납 없음)
});

export const RobotState = Object.freeze({
  OFFLINE: 'offline',
  IDLE: 'idle', // 홈베이스에서 대기
  MOVING: 'moving',
  ARRIVED: 'arrived',
  RETURNING: 'returning', // 홈베이스로 복귀 중
});

// 서버 → 로봇
export const ToRobot = Object.freeze({
  GO_TO: 'goTo',
  GO_HOME: 'goHome',
  VERIFY_RESULT: 'verifyResult',
  END: 'end', // 현재 요청 종료 (완료·취소·만료·실패)
  SYNC: 'sync', // 재연결 시 진행 중이던 요청 상태 전달
});

// 로봇 → 서버
export const FromRobot = Object.freeze({
  HELLO: 'hello',
  STATUS: 'status',
  VERIFY: 'verify',
  COMPLETE: 'complete',
});

export const qrPayload = (token) => `TLR1:${token}`;
