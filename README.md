# TEMI 기반 도서관 이동형 물품 대여 서비스

모바일 로봇의 이해 2조. 앱에서 물품을 고르고 좌석 번호를 입력하면, 대여 데스크에서 바구니에 물품을 담은 TEMI가 좌석 구역으로 와서
QR(예비: PIN) 인증 후 물품을 건넨다. 반납은 인증 없이 바구니에 받아 데스크로 돌아오고, 관리자가 회수 완료를 누르면 재고에 반영한다.

TEMI 쪽은 두 가지가 같은 프로토콜(`docs/robot-protocol.md`)로 서버에 붙는다.
- **실제 TEMI 앱** (`temi-android/`): TEMI 태블릿 화면과 이동 제어. 빌드·설치 방법은 `temi-android/README.md`
- **브라우저 시뮬레이터** (`/robot/`): TEMI 없이 전체 흐름을 시험할 때

## 실행

Node.js 22.13 이상이 필요하다 (내장 SQLite 사용).

```bash
cd server
npm install
npm start
```

| 화면 | 주소 | 용도 |
|---|---|---|
| 학생 앱 | http://localhost:3000/ | 대여·반납 신청, 진행 상황, QR/PIN |
| TEMI 시뮬레이터 | http://localhost:3000/robot/ | TEMI 화면 흉내. 이동·도착·인증·실패·연결 끊김 시험 |
| 관리자 | http://localhost:3000/admin/ | 재고 수정, 반납 검수, 요청 현황 |

같은 Wi-Fi의 폰에서 `http://<PC IP>:3000/`으로 접속하면 학생 앱을 폰으로 볼 수 있다.

### 시연 순서

1. 시뮬레이터 탭과 학생 앱 탭을 나란히 연다.
2. 학생 앱에서 학번 입력 → 물품 선택 → 좌석 번호 입력(예: 28) → 대여 요청.
3. 시뮬레이터에 '출발 준비'가 뜨면 `물건 싣기 완료`를 누른다 (실제로는 데스크에서 바구니에 담은 뒤).
4. 도착하면 앱의 "개발용 코드"를 `QR 스캔 흉내` 칸에 붙여 넣거나, `PIN으로 인증`을 눌러 앱의 PIN을 입력한다.
5. 시뮬레이터나 앱에서 `대여 완료` → 로봇이 데스크로 복귀.
6. 앱 `대여 현황`에서 반납 요청 → `출발` → 도착하면 시뮬레이터나 앱에서 `반납 완료` (QR 없음) → 복귀.
7. 시뮬레이터에 '회수' 화면이 뜨면 `회수 완료`를 누른다. 이때 재고에 반영된다. 다음 요청이 있으면 이 버튼으로 바로 출발한다.

### 테스트

```bash
cd server
npm test
```

대여→출발→반납→회수 전체 흐름, 좌석 번호 검사, 마지막 재고 동시 신청, 이동 실패 재시도, 시간 초과 뒤 바구니 확인, 회수 버튼으로 다음 요청 출발을 확인한다.

## 구조

```
server/          Express + WebSocket + SQLite(node:sqlite)
  src/
    app.js            서버 조립 (정적 파일, API, 로봇 연결)
    api.js            REST API
    rentalService.js  재고 예약·요청 상태 전이·대여 기록 (기술 과제 03: 재고 정합성)
    dispatcher.js     대기열 → 로봇 배정, 재시도·시간 초과 (기술 과제 02: 상태 동기화)
    robotLink.js      로봇 WebSocket 연결, 하트비트
    events.js         앱·관리자 실시간 갱신 (SSE)
    protocol.js       상태 값·메시지 타입
    config.js         포트, 시간 초과, 재시도 횟수
    db.js             스키마와 임시 시드 데이터
  test/flow.test.js
web/
  student/        학생 앱 (모바일 웹)
  robot-sim/      TEMI 시뮬레이터
  admin/          관리자
  shared/         공통 API 헬퍼·스타일
temi-android/     실제 TEMI 앱 (Kotlin, temi SDK)
docs/robot-protocol.md
```

## 역할별 시작점 (발표자료 4인 역할)

| 역할 | 주로 볼 곳 |
|---|---|
| ① TEMI 제어 | `temi-android/`, `docs/robot-protocol.md`, `web/robot-sim/robot.js` |
| ② 앱 / UI | `web/student/`, `web/admin/` |
| ③ 서버 · DB | `server/src/` |
| ④ 하드웨어 · 통합 · 평가 | `server/src/db.js` 시드(좌석 구역·품목), 바구니 검증, 평가 지표 로그 |

## 아직 임시인 것 (TODO)

- **로그인**: 지금은 학번 문자열만으로 사용자를 구분한다. 관리자 화면도 인증이 없다.
- **품목·수량·좌석 구역**: `server/src/db.js`의 시드(좌석 1~120번, 구역 A·B·C)는 예시 값이다. 현장 조사 후 교체하고, 구역의 `temi_location`과 같은 이름으로 TEMI 맵에 위치를 저장한다.
- **좌석 단위 이동**: temi는 구역 지점까지만 이동하고 좌석 번호는 화면에 띄운다.
- **인증**: QR이 기본이고, PIN은 예비로 남겨 둔다 (앱 배달 현황 화면과 TEMI 도착 화면의 'PIN으로 인증'). Figma 시안에도 PIN 안내를 추가해 맞출 것.
- **QR 카메라 인식**: TEMI 앱에 zxing으로 구현했지만 실제 TEMI 카메라로는 아직 검증 전이다.
- **물리적 수령 확인**: 바구니에 무엇이 있는지 알 센서가 없다. 완료 버튼과 데스크의 회수 완료·바구니 확인으로 보완한다 (`docs/robot-protocol.md`).
- **다중 요청**: 사용자당 진행 중인 요청 1건, 로봇 1대만 가정한다.
- **사용자 평가 지표**: 신청→수령 시간은 `requests` 테이블의 시각으로 계산할 수 있다. 측정 화면·내보내기는 아직 없다.
