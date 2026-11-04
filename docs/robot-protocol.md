# 서버 ↔ 로봇 프로토콜

로봇(실제 TEMI 앱 `temi-android/` 또는 브라우저 시뮬레이터 `web/robot-sim/`)은 서버의 `ws://<서버>:3000/ws/robot`에 WebSocket으로 접속하고 JSON 메시지를 주고받는다.
로봇은 1대만 가정한다. 새 연결이 오면 이전 연결은 끊긴다.

## 흐름

물품은 대여 데스크(홈베이스)에서 바구니에 담는다. 그래서 temi가 홈베이스에 있을 때만 다음 요청을 배정한다.

```
앱 신청 ─▶ 서버: 좌석 번호로 구역(zone) 결정, 재고 예약             요청 queued
            서버 ─ goTo ─▶ 로봇  (temi가 홈베이스에 있을 때만)        요청 preparing
            로봇: '출발 준비' 화면 · 데스크에서 바구니에 담고 출발 버튼
            서버 ◀ status(ready) ─ 로봇
            서버 ◀ status(moving) ─ 로봇  (출발 버튼)                 요청 moving
            서버 ◀ status(arrived) ─ 로봇                              요청 arrived
              대여만: 앱에 QR·예비 PIN 표시
              서버 ◀ verify(code) ─ 로봇  (카메라 QR 또는 PIN 입력)
              서버 ─ verifyResult ─▶ 로봇                              요청 verified
            서버 ◀ complete ─ 로봇 (또는 앱의 완료 버튼)               대여 완료 / 반납 완료
            서버 ─ end(completed) ─▶ 로봇                              요청 completed
            서버 ─ goHome ─▶ 로봇 → status(returning) → status(idle)
            바구니 처리가 남았으면:
              서버 ─ desk ─▶ 로봇 → status(desk)
              서버 ◀ collected ─ 로봇  (회수 완료, 또는 물건 있음·없음)  재고·대여 기록 확정
              서버 ─ deskDone ─▶ 로봇 → status(idle)
            다음 요청 배정
```

QR 인증은 물품을 받는 대여 학생만 한다. 반납은 도착하면 바로 반납 완료를 누른다.

## 데스크에서 바구니 처리

temi에는 바구니 안을 볼 센서가 없어서 요청이 어떻게 끝났는지로 판단한다 (`requests.desk_state`).

| 요청 | 어떻게 끝났나 | 바구니 | 데스크에서 |
|---|---|---|---|
| 대여 | 대여 완료 | 없음 | 없음 |
| 대여 | 출발 전 취소·만료 | temi가 나가지 않음 | 없음 (재고 바로 복구) |
| 대여 | 이동 중 취소·실패, 도착 후 취소, QR 인증 시간 초과 | 있음 | `collect`: 회수 완료 → 재고 복구 |
| 대여 | QR 인증 후 대여 완료 없이 시간 초과 | 모름 | `check`: 물건 있음 → 재고 복구 / 물건 없음 → 학생이 가져간 것으로 대여 처리 |
| 반납 | 반납 완료 | 있음 | `collect`: 회수 완료 → 반납 처리, 재고 복구 |
| 반납 | 이동 중 취소·실패, 도착 후 취소 | 없음 | 없음 (계속 대여 중) |
| 반납 | 도착 후 반납 완료 없이 시간 초과 | 모름 | `check`: 물건 있음 → 반납 처리, 재고 복구 / 물건 없음 → 계속 대여 중 |

처리가 남아 있으면 temi가 홈베이스에 있어도 다음 요청을 배정하지 않는다.
`collect` 화면에 다음 요청이 같이 오면 버튼 하나(회수·싣기 완료)로 바로 출발한다. `check`는 고른 뒤 출발 준비 화면으로 간다.

## 로봇 → 서버

| type | 필드 | 설명 |
|---|---|---|
| `hello` | `robotId`, `state`, `locations?` | 접속 직후 1회. `state`는 현재 상태, `locations`는 TEMI 맵에 저장된 위치 목록 (진단용) |
| `status` | `requestId?`, `state`, `detail?` | `ready`(출발 대기), `desk`(데스크 버튼 대기), `moving`(출발), `arrived`, `failed`, `returning`, `idle`(홈베이스 도착) |
| `verify` | `requestId`, `code` | 대여만. 카메라로 읽은 QR 문자열(`TLR1:...`) 또는 화면에서 입력한 PIN 4자리 (예비) |
| `complete` | `requestId` | 사용자가 TEMI 화면에서 대여 완료/반납 완료를 누름 |
| `collected` | `requestId`, `found?`, `nextRequestId?` | 데스크 버튼. `found`는 `check`에서 고른 값(`true`/`false`). `nextRequestId`를 보내면 그 요청은 출발 버튼 없이 바로 출발 |
| `map` | `png`, `width`, `height`, `originX`, `originY`, `resolution`, `locations[{name,x,y}]`, `name?` | TEMI 맵 (temi MAP 권한 필요). 접속할 때마다 보낸다. `png`는 base64 (data URL 접두어 없음) |
| `position` | `x`, `y`, `yaw` | 실시간 위치 (TEMI 맵 좌표, m·라디안). 0.5초에 한 번 정도 |

### 맵 좌표 변환

PNG는 위쪽이 y가 큰 쪽이 되도록 만든다. 맵 좌표 (x, y) → PNG 픽셀:

```
px = (x - originX) / resolution
py = height - (y - originY) / resolution
```

서버는 최신 맵을 `GET /api/robot/map`으로, 위치는 `GET /api/robot`의 `position`과 SSE `position` 이벤트로 화면에 넘긴다.
맵을 새로 받으면 `robot.mapVersion`이 바뀐다.

> 실제 TEMI에서 맵 방향(위아래 뒤집힘)이 맞는지 확인할 것: temi를 홈베이스에 두었을 때 지도 위 temi 점이 '데스크' 표시와 겹쳐야 한다.

## 서버 → 로봇

| type | 필드 | 설명 |
|---|---|---|
| `goTo` | `requestId`, `requestType`, `itemName`, `itemKind`, `quantity`, `area`, `zoneName`, `seat`, `location`, `attempt`, `immediate`, `simTravelSec` | `attempt`가 1이면 출발 버튼을 기다리고, 2 이상(이동 실패 후 재시도)이거나 `immediate`(회수·싣기 완료로 이미 눌렀음)면 바로 이동한다. `location`은 구역 단위로 TEMI 맵에 저장된 위치 이름 |
| `desk` | `goTo` 필드(끝난 요청) + `mode`, `reason`, `next` | 데스크 처리. `mode`는 `collect`/`check`. `next`는 다음 요청(`goTo` 필드) 또는 `null`. 다음 요청이 새로 들어오면 다시 보낸다 |
| `deskDone` | `requestId` | 데스크 처리 끝. 이미 다른 화면이면 무시한다 (버튼을 두 번 누른 경우) |
| `verifyResult` | `requestId`, `ok`, `reason?` | 인증 결과 |
| `end` | `requestId`, `status`, `reason?` | 요청 종료 (`completed`/`cancelled`/`expired`/`failed`). 화면 정리용 |
| `goHome` | `location` | 홈베이스(`home base`)로 복귀 |
| `sync` | `goTo` 필드 + `status` | 재연결 시 진행 중이던 요청 상태 (`preparing`/`moving`/`arrived`/`verified`) |

## 시간 초과·재시도 (`server/src/config.js`)

- 배정 후 10분 안에 출발 버튼을 누르지 않으면 만료.
- 이동 실패(`status: failed`)는 `maxMoveAttempts`(기본 2회)까지 다시 `goTo`를 보낸다.
- 출발 후 3분 안에 도착 보고가 없으면 실패, 도착 후 3분 안에 인증이 없으면 만료.
- 반납은 인증이 없어서, 도착 후 3분 안에 반납 완료가 없으면 만료하고 '바구니 확인 필요'로 남긴다.
- 대여는 인증 후 2분 안에 대여 완료가 없으면 만료하고 '바구니 확인 필요'로 남긴다.
- 출발 전 실패·취소·만료는 예약한 재고를 바로 되돌린다. 출발한 뒤에는 데스크 처리에서 정한다 (위 표).
- 데스크 버튼은 시간 제한이 없다. 누를 때까지 다음 요청을 배정하지 않는다.

## temi SDK 대응 (`temi-android/.../RobotBridge.kt`)

| 프로토콜 | temi SDK |
|---|---|
| `goTo` 후 출발 버튼 | `robot.goTo(location)` (맵에 없는 위치면 바로 `failed`를 보고한다) |
| `status: arrived/failed` | `OnGoToLocationStatusChangedListener`의 `complete`/`abort` |
| `goHome` | `robot.goTo("home base")`, 실패하면 3초 뒤 최대 2번 다시 시도 |
| `end` (이동 중 취소) | `robot.stopMovement()` |
| 음성 안내 | `robot.speak(TtsRequest.create(text, false))` |
| `verify` (QR) | 카메라 미리보기에서 zxing으로 QR 인식. 안 되면 PIN 입력 |
| `map` | `robot.getMapData()` (MAP 권한: 매니페스트 `metadata_permissions` + `robot.requestPermissions`) |
| `position` | `OnCurrentPositionChangedListener`, 접속 직후 한 번은 `robot.getPosition()` |

> 서버는 로봇 1대만 받는다. 실제 TEMI 앱과 브라우저 시뮬레이터를 동시에 켜 두면 서로 연결을 끊는다.
