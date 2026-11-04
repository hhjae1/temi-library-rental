// 서버·앱·로봇이 공유하는 상태 값과 메시지 타입.
// 로봇 메시지 형식은 docs/robot-protocol.md 참고.

export const RequestStatus = Object.freeze({
  QUEUED: 'queued', // 신청 완료, 재고 예약됨, 로봇 배정 대기
  PREPARING: 'preparing', // 로봇에 배정됨. 데스크에서 바구니에 물품을 담고 TEMI 화면의 출발 버튼을 기다림
  MOVING: 'moving', // TEMI가 좌석 구역으로 이동 중
  ARRIVED: 'arrived', // 도착. 대여는 QR 인증 대기, 반납은 인증 없이 반납 완료 대기
  VERIFIED: 'verified', // 대여 QR 인증 완료, 대여 완료 대기
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const OPEN_STATUSES = ['queued', 'preparing', 'moving', 'arrived', 'verified'];
export const DISPATCHED_STATUSES = ['preparing', 'moving', 'arrived', 'verified'];
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired'];

export const RentalStatus = Object.freeze({
  ACTIVE: 'active', // 대여 중
  RETURNING: 'returning', // 반납 요청 진행 중
  RETURNED: 'returned', // 바구니에 반납됨, 데스크 회수 대기
  INSPECTED: 'inspected', // 데스크에서 회수 완료, 재고 반영됨
  CONSUMED: 'consumed', // 소모품 (반납 없음)
});

export const RobotState = Object.freeze({
  OFFLINE: 'offline',
  IDLE: 'idle', // 홈베이스(대여 데스크)에서 대기
  READY: 'ready', // 홈베이스에서 출발 버튼 대기 (물품 적재 중)
  DESK: 'desk', // 홈베이스에서 회수·바구니 확인 버튼 대기
  MOVING: 'moving',
  ARRIVED: 'arrived',
  RETURNING: 'returning', // 홈베이스로 복귀 중
  STOPPED: 'stopped', // 이동 실패로 멈춤 (홈베이스 아님)
});

// 다음 요청을 배정할 수 있는 로봇 상태. 물품은 데스크에서 담아야 하므로 홈베이스에 있을 때만 배정한다.
export const AT_HOME_STATES = ['idle', 'ready', 'desk'];

// 요청이 끝난 뒤 temi가 데스크로 돌아왔을 때 바구니를 어떻게 처리할지
export const DeskState = Object.freeze({
  COLLECT: 'collect', // 바구니에 물건이 있다. 회수 완료를 받는다
  CHECK: 'check', // 있는지 모른다 (시간 초과). 관리자가 보고 물건 있음·없음을 고른다
  DONE: 'done', // 처리 끝
});

// 서버 → 로봇
export const ToRobot = Object.freeze({
  GO_TO: 'goTo',
  GO_HOME: 'goHome',
  VERIFY_RESULT: 'verifyResult',
  END: 'end', // 현재 요청 종료 (완료·취소·만료·실패)
  SYNC: 'sync', // 재연결 시 진행 중이던 요청 상태 전달
  DESK: 'desk', // 데스크에서 회수·바구니 확인을 받으라는 지시
  DESK_DONE: 'deskDone', // 회수·바구니 확인 처리 끝
});

// 로봇 → 서버
export const FromRobot = Object.freeze({
  HELLO: 'hello',
  STATUS: 'status',
  VERIFY: 'verify',
  COMPLETE: 'complete',
  COLLECTED: 'collected', // 데스크에서 회수 완료, 또는 물건 있음·없음을 누름
});

export const qrPayload = (token) => `TLR1:${token}`;
