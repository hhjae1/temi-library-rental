# temi-android (TEMI 받은 뒤 작업)

TEMI 로봇에 올릴 Android 앱 자리. 지금은 `RobotBridge.kt` 뼈대만 있고 **빌드하지 않았다.**
TEMI가 없는 동안에는 `web/robot-sim`(브라우저 시뮬레이터)이 같은 프로토콜로 로봇 역할을 한다.

## TEMI를 받으면

1. Android Studio로 새 프로젝트를 만들고 temi SDK 의존성을 추가한다 (버전·설정은 github.com/robotemi/sdk 문서 확인).
2. `RobotBridge.kt`를 넣고 OkHttp 의존성을 추가한다.
3. TEMI 맵에서 방문 지점을 저장한다. 위치 이름은 서버 `stations.temi_location`(`zone-a`, `zone-b`, `zone-c`)과 같아야 한다.
4. 화면은 시뮬레이터와 같은 상태(idle/moving/arrived/verified/returning)로 만든다.
5. 검증할 것:
   - [ ] `goTo` / 이동 상태 콜백이 프로토콜대로 오는지
   - [ ] 카메라 QR 인식 가능 여부 (안 되면 PIN 입력만 사용)
   - [ ] 바구니 장착 후 주행 안정성·센서 가림
   - [ ] 도서관 Wi-Fi에서 서버 접속·재연결
