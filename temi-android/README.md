# temi-android — TEMI에 올리는 앱

TEMI 태블릿에 뜨는 화면과 TEMI 이동 제어를 맡는다. 서버와는 `docs/robot-protocol.md`의 WebSocket 프로토콜로 통신하고,
흐름과 화면은 브라우저 시뮬레이터(`web/robot-sim`)와 같다.

| 파일 | 하는 일 |
|---|---|
| `app/src/main/java/.../RobotBridge.kt` | 서버 프로토콜 ↔ temi SDK (`goTo`, 이동 상태 콜백, 음성 안내), 재연결 |
| `app/src/main/java/.../MainActivity.kt` | TEMI 화면: 대기 · 출발 준비 · 이동 중 · 도착(대여만 카메라 QR / PIN) · 완료(대여 완료 / 반납 완료) · 데스크(회수 완료 / 물건 있음·없음) |

- TEMI는 Android 6.0(SDK 23)이라 `minSdk = 23`이다.
- temi SDK `1.138.0`, QR 인식은 `zxing-android-embedded 4.3.0` + `zxing core 3.3.0` (Android 7 미만 호환용).

## 빌드

Android Studio로 `temi-android` 폴더를 열거나, 터미널에서:

```bash
cd temi-android
./gradlew assembleDebug
```

Windows에서 `JAVA_HOME`이 JDK 17~21이 아니면 Android Studio에 들어 있는 JDK를 쓴다:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"; .\gradlew.bat assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`

## TEMI에 설치

TEMI 설정에서 개발자 모드와 ADB를 켜면 TEMI의 IP가 보인다.

```bash
adb connect 172.20.10.10:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n kr.ac.kw.temirental/.MainActivity
```

처음 실행하면 카메라 권한을 허용한다. 서버 주소 기본값은 `ws://172.20.10.2:3000/ws/robot`이고,
**화면 왼쪽 위 상태 줄을 길게 누르면** 바꿀 수 있다. 같은 창에 TEMI 맵에 저장된 위치 목록도 나온다.

## 현장에서 맞출 것

- [ ] TEMI 맵에 위치 저장: 서버 `zones.temi_location`(`humanities-a`, `humanities-b`, `humanities-c`)과 같은 이름으로. 데스크는 지금 홈베이스(`home base`)로 쓴다
      맵에 없는 위치로 보내면 앱이 이동하지 않고 실패로 보고한다.
- [ ] 서버를 돌리는 PC와 TEMI가 같은 Wi-Fi(핫스팟)에 있고, PC 방화벽이 3000번 포트를 막지 않는지
- [ ] 카메라 QR 인식이 실제로 되는지 (안 되면 PIN 입력 사용)
- [ ] 바구니 장착 후 주행 안정성·센서 가림
