package kr.ac.kw.temirental

// ⚠️ 빌드·실기 검증 전 뼈대 코드. TEMI를 받으면 Android Studio 프로젝트에 넣고
//    사용하는 temi SDK 버전에 맞춰 API 이름을 확인할 것.
// 서버와 주고받는 메시지는 docs/robot-protocol.md, 같은 흐름의 브라우저 버전은 web/robot-sim/robot.js 참고.

import com.robotemi.sdk.Robot
import com.robotemi.sdk.TtsRequest
import com.robotemi.sdk.listeners.OnGoToLocationStatusChangedListener
import com.robotemi.sdk.listeners.OnRobotReadyListener
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class RobotBridge(
    private val serverUrl: String, // 예: ws://192.168.0.10:3000/ws/robot
    private val ui: Ui,
) : OnRobotReadyListener, OnGoToLocationStatusChangedListener {

    /** TEMI 화면 담당 (Activity/Fragment). 화면 종류는 시뮬레이터와 같게 맞춘다. */
    interface Ui {
        fun show(screen: String, task: JSONObject?) // idle | moving | arrived | verified | returning
        fun banner(text: String, isError: Boolean)
    }

    private val robot = Robot.getInstance()
    private val http = OkHttpClient()
    private var ws: WebSocket? = null
    private var task: JSONObject? = null
    private var state = "idle"

    fun start() {
        robot.addOnRobotReadyListener(this)
        robot.addOnGoToLocationStatusChangedListener(this)
        connect()
    }

    fun stop() {
        robot.removeOnRobotReadyListener(this)
        robot.removeOnGoToLocationStatusChangedListener(this)
        ws?.close(1000, null)
    }

    // ── 서버 연결 ──
    private fun connect() {
        ws = http.newWebSocket(Request.Builder().url(serverUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                send(JSONObject().put("type", "hello").put("robotId", "temi-1").put("state", state))
            }

            override fun onMessage(webSocket: WebSocket, text: String) = handle(JSONObject(text))

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // TODO: 지수 백오프로 재연결 (Wi-Fi 끊김 대응)
            }
        })
    }

    private fun send(msg: JSONObject) {
        ws?.send(msg.toString())
    }

    private fun report(state: String, detail: String? = null) {
        this.state = if (state == "failed") "idle" else state
        val msg = JSONObject().put("type", "status").put("state", state)
        task?.let { msg.put("requestId", it.getInt("requestId")) }
        detail?.let { msg.put("detail", it) }
        send(msg)
    }

    // ── 서버 메시지 ── (UI 갱신은 메인 스레드에서 해야 함)
    private fun handle(msg: JSONObject) {
        when (msg.getString("type")) {
            "goTo" -> {
                task = msg
                ui.show("moving", msg)
                report("moving")
                robot.goTo(msg.getString("location"))
            }
            "goHome" -> {
                task = null
                ui.show("returning", null)
                report("returning")
                robot.goTo(msg.optString("location", HOME))
            }
            "verifyResult" -> if (msg.getBoolean("ok")) {
                ui.show("verified", task)
                speak("인증되었습니다.")
            } else {
                ui.banner(msg.optString("reason", "인증 실패"), true)
            }
            "end" -> {
                task = null
                ui.banner(msg.getString("status"), msg.getString("status") != "completed")
            }
            "sync" -> {
                task = msg
                if (msg.getString("status") == "moving") robot.goTo(msg.getString("location"))
                else ui.show(if (msg.getString("status") == "verified") "verified" else "arrived", msg)
            }
        }
    }

    // ── 화면에서 호출 ──
    fun submitCode(code: String) { // QR 스캔 결과 또는 PIN
        val t = task ?: return
        send(JSONObject().put("type", "verify").put("requestId", t.getInt("requestId")).put("code", code))
    }

    fun complete() {
        val t = task ?: return
        send(JSONObject().put("type", "complete").put("requestId", t.getInt("requestId")))
    }

    // ── temi SDK 콜백 ──
    override fun onRobotReady(isReady: Boolean) {
        // TODO: robot.locations로 서버 stations.temi_location 이름이 맵에 저장돼 있는지 확인
    }

    override fun onGoToLocationStatusChanged(location: String, status: String, descriptionId: Int, description: String) {
        when (status) {
            OnGoToLocationStatusChangedListener.COMPLETE ->
                if (location == HOME) {
                    ui.show("idle", null)
                    report("idle")
                } else {
                    ui.show("arrived", task)
                    report("arrived")
                    speak("도착했습니다. 앱의 QR 코드를 보여 주세요.")
                }
            OnGoToLocationStatusChangedListener.ABORT -> report("failed", description)
        }
    }

    // 도서관이므로 음성은 짧게, 볼륨은 낮게 (TEMI 설정에서 볼륨 조정)
    private fun speak(text: String) = robot.speak(TtsRequest.create(text, false))

    companion object {
        const val HOME = "home base"
    }
}
