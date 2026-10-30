# 서버 ↔ 로봇 프로토콜

로봇(실제 TEMI 앱 또는 `web/robot-sim` 시뮬레이터)은 서버의 `ws://<서버>:3000/ws/robot`에 WebSocket으로 접속하고 JSON 메시지를 주고받는다.
로봇은 1대만 가정한다. 새 연결이 오면 이전 연결은 끊긴다.

## 흐름

```
앱 신청 ─▶ 서버: 재고 예약, 요청 queued
            서버 ─ goTo ─▶ 로봇            요청 moving
            서버 ◀ status(moving) ─ 로봇
            서버 ◀ status(arrived) ─ 로봇   요청 arrived  (앱에 QR·PIN 표시)
            서버 ◀ verify(code) ─ 로봇
            서버 ─ verifyResult ─▶ 로봇     요청 verified
            서버 ◀ complete ─ 로봇 (또는 앱의 완료 버튼)
            서버 ─ end(completed) ─▶ 로봇   요청 completed
            서버 ─ goTo(다음 요청) 또는 goHome ─▶ 로봇
```

## 로봇 → 서버

| type | 필드 | 설명 |
|---|---|---|
| `hello` | `robotId`, `state` | 접속 직후 1회. `state`는 현재 로봇 상태 (`idle`/`moving`/`arrived`/`returning`) |
| `status` | `requestId?`, `state`, `detail?` | 상태 보고. `state`: `moving`, `arrived`, `failed`, `returning`, `idle` |
| `verify` | `requestId`, `code` | 카메라로 읽은 QR 문자열(`TLR1:...`) 또는 화면에서 입력한 PIN 4자리 |
| `complete` | `requestId` | 사용자가 TEMI 화면에서 수령/반납 완료를 누름 |

## 서버 → 로봇

| type | 필드 | 설명 |
|---|---|---|
| `goTo` | `requestId`, `requestType`, `itemName`, `quantity`, `stationName`, `seat`, `location`, `attempt`, `simTravelSec` | `location`은 열람실 단위로 TEMI 맵에 저장된 위치 이름. 좌석(`seat`)은 화면에 띄워 사용자가 찾게 한다. 재시도 시 같은 요청으로 다시 옴 |
| `verifyResult` | `requestId`, `ok`, `reason?` | 인증 결과 |
| `end` | `requestId`, `status`, `reason?` | 요청 종료 (`completed`/`cancelled`/`expired`/`failed`). 화면 정리용 |
| `goHome` | `location` | 처리할 요청이 없을 때 홈베이스 복귀 |
| `sync` | `goTo` 필드 + `status` | 재연결 시 진행 중이던 요청 상태 (`moving`이면 다시 이동) |

## 시간 초과·재시도 (`server/src/config.js`)

- 이동 실패(`status: failed`)는 `maxMoveAttempts`(기본 2회)까지 다시 `goTo`를 보낸다.
- 출발 후 3분 안에 도착 보고가 없으면 실패, 도착 후 3분 안에 인증이 없으면 만료.
- 실패·취소·만료되면 예약한 재고를 되돌린다.
- 인증 후 2분 안에 완료가 없으면 자동 완료로 처리하고 사유를 남긴다 (관리자 확인 대상).

## TEMI SDK 대응 (검증 필요)

| 프로토콜 | temi SDK |
|---|---|
| `goTo` | `robot.goTo(location)` |
| `status: moving/arrived/failed` | `OnGoToLocationStatusChangedListener`의 `going`/`complete`/`abort` |
| `goHome` | `robot.goTo("home base")` |
| 음성 안내 | `robot.speak(TtsRequest.create(text, false))` |
| `verify` (QR) | 카메라 QR 인식: SDK/카메라 접근 가능 여부를 먼저 검증. 안 되면 PIN만 사용 |
