# TEMI 기반 도서관 이동형 물품 대여 서비스

모바일 로봇의 이해 2조. 앱에서 물품과 방문 지점을 고르면 TEMI가 자리로 와서 QR/PIN 인증 후 물품을 건네고, 반납도 같은 방식으로 받는다.

**TEMI가 없어도 전체 흐름을 돌려 볼 수 있도록** 브라우저용 TEMI 시뮬레이터를 같이 둔다.
실제 TEMI 앱은 같은 프로토콜(`docs/robot-protocol.md`)을 쓰므로 나중에 시뮬레이터 자리만 바꾸면 된다.

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
2. 학생 앱에서 학번 입력 → 물품 `신청` → 지점 선택.
3. 시뮬레이터가 이동 후 도착하면, 앱의 PIN을 시뮬레이터 화면에 입력 (또는 "개발용 코드"를 `QR 스캔 흉내` 칸에 붙여 넣기).
4. 시뮬레이터나 앱에서 `수령 완료` → 로봇 복귀.
5. 앱 `반납하기` 탭에서 `TEMI 호출` → 같은 과정 → 관리자 화면에서 `검수 완료`하면 재고 반영.

### 테스트

```bash
cd server
npm test
```

대여→반납→검수 전체 흐름, 마지막 재고 동시 신청, 이동 실패 재시도를 확인한다.

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
temi-android/     실제 TEMI 앱 뼈대 (미빌드)
docs/robot-protocol.md
```

## 역할별 시작점 (발표자료 4인 역할)

| 역할 | 주로 볼 곳 |
|---|---|
| ① TEMI 제어 | `temi-android/`, `docs/robot-protocol.md`, `web/robot-sim/robot.js` |
| ② 앱 / UI | `web/student/`, `web/admin/` |
| ③ 서버 · DB | `server/src/` |
| ④ 하드웨어 · 통합 · 평가 | `server/src/db.js` 시드(지점·품목), 바구니 검증, 평가 지표 로그 |

## 아직 임시인 것 (TODO)

- **로그인**: 지금은 학번 문자열만으로 사용자를 구분한다. 관리자 화면도 인증이 없다.
- **품목·수량·열람실**: `server/src/db.js`의 시드는 Figma 시안 기준 예시 값이다. 현장 조사 후 교체하고, 열람실의 `temi_location`은 TEMI 맵 위치 이름과 맞춘다.
- **좌석 단위 이동**: temi는 열람실 지점까지만 이동하고 좌석 번호는 화면에 띄운다. 좌석 근처까지 가려면 구역별 위치를 더 저장해야 한다.
- **앱 인증 단계**: 배달 현황 화면의 인증번호(PIN)·QR 카드는 유지하기로 했다. Figma 시안에도 이 카드를 추가해 맞출 것.
- **QR 카메라 인식**: SDK로 가능한지 미검증. PIN 입력을 대안으로 둔다.
- **물리적 수령 확인**: QR 인증만으로는 바구니에서 무엇을 꺼냈는지 알 수 없다. 사용자 완료 버튼 + 관리자 검수로 보완한다.
- **다중 요청**: 사용자당 진행 중인 요청 1건, 로봇 1대만 가정한다.
- **사용자 평가 지표**: 신청→수령 시간은 `requests` 테이블의 시각으로 계산할 수 있다. 측정 화면·내보내기는 아직 없다.
