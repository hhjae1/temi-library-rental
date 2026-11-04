package kr.ac.kw.temirental

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.robotemi.sdk.Robot
import com.robotemi.sdk.TtsRequest
import com.robotemi.sdk.listeners.OnGoToLocationStatusChangedListener
import com.robotemi.sdk.navigation.listener.OnCurrentPositionChangedListener
import com.robotemi.sdk.navigation.model.Position
import com.robotemi.sdk.permission.OnRequestPermissionResultListener
import com.robotemi.sdk.permission.Permission
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 서버 프로토콜(docs/robot-protocol.md)과 temi SDK를 잇는다.
 * 흐름은 브라우저 시뮬레이터(web/robot-sim/robot.js)와 같다:
 * 대기 → goTo(출발 준비, 출발 버튼) → 이동 → 도착(대여만 QR/PIN 인증) → 완료 버튼(대여 완료·반납 완료) → 홈베이스 복귀
 * → 데스크 처리(회수 완료 또는 물건 있음·없음)가 있으면 받고 다음 요청으로
 */
class RobotBridge(private val ui: Ui) :
    OnGoToLocationStatusChangedListener,
    OnCurrentPositionChangedListener,
    OnRequestPermissionResultListener {

    enum class Screen { IDLE, READY, MOVING, RETURNING, ARRIVED, PIN, CONFIRM, DESK }

    data class Task(
        val requestId: Int,
        val rental: Boolean,
        val consumable: Boolean, // 돌려주지 않는 물품 (물티슈 등)
        val itemName: String,
        val quantity: Int,
        val seat: String,
        val zone: String, // 예: "인문자료실 C구역"
        val location: String,
        val attempt: Int,
    ) {
        companion object {
            fun from(m: JSONObject) = Task(
                requestId = m.getInt("requestId"),
                rental = m.optString("requestType") == "rental",
                consumable = m.optString("itemKind") == "consumable",
                itemName = m.optString("itemName"),
                quantity = m.optInt("quantity", 1),
                seat = m.optString("seat"),
                zone = listOf(m.optString("area"), m.optString("zoneName")).filter { it.isNotBlank() }.joinToString(" "),
                location = m.optString("location"),
                attempt = m.optInt("attempt", 1),
            )
        }
    }

    /** 데스크에서 받을 처리. check면 바구니를 보고 물건 있음·없음을 고르고, 아니면 회수 완료. next가 있으면 버튼 하나로 바로 출발한다 */
    data class DeskTask(val task: Task, val check: Boolean, val next: Task?) {
        companion object {
            fun from(m: JSONObject) = DeskTask(
                task = Task.from(m),
                check = m.optString("mode") == "check",
                next = m.optJSONObject("next")?.let { Task.from(it) },
            )
        }
    }

    interface Ui {
        fun show(screen: Screen, task: Task?)
        fun banner(text: String, error: Boolean = false)
        fun connection(connected: Boolean)
        fun mapLoaded(map: TemiMap)
        fun position(x: Float, y: Float, yaw: Float)
    }

    private val main = Handler(Looper.getMainLooper())
    private val robot = Robot.getInstance()
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private var ws: WebSocket? = null
    private var serverUrl = ""
    private var running = false
    private var retryMs = RETRY_MIN_MS

    var screen = Screen.IDLE
        private set
    var task: Task? = null
        private set
    var desk: DeskTask? = null
        private set
    private var deskSent = false // 데스크 버튼은 한 번만 보낸다
    private var target: String? = null // goTo로 가는 중인 TEMI 위치 이름
    private var homeRetries = 0
    private var mapMessage: String? = null // 접속할 때마다 다시 보낸다
    private var lastPositionAt = 0L

    fun start(url: String) {
        running = true
        serverUrl = url
        robot.addOnGoToLocationStatusChangedListener(this)
        robot.addOnCurrentPositionChangedListener(this)
        robot.addOnRequestPermissionResultListener(this)
        connect()
    }

    fun stop() {
        running = false
        robot.removeOnGoToLocationStatusChangedListener(this)
        robot.removeOnCurrentPositionChangedListener(this)
        robot.removeOnRequestPermissionResultListener(this)
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, null)
        ws = null
    }

    fun changeServer(url: String) {
        serverUrl = url
        ws?.cancel()
        ws = null
        retryMs = RETRY_MIN_MS
        connect()
    }

    /** TEMI 맵에 저장된 위치 이름. temi는 위치 이름을 소문자로 저장한다. */
    fun locations(): List<String> = runCatching { robot.locations }.getOrDefault(emptyList())

    // ── 맵·실시간 위치 ──

    /** 로봇이 준비되면 부른다. temi MAP 권한이 없으면 temi가 허용 창을 띄운다. */
    fun loadMap() {
        if (robot.checkSelfPermission(Permission.MAP) != Permission.GRANTED) {
            robot.requestPermissions(listOf(Permission.MAP), REQ_MAP)
            return
        }
        // getMapData()는 맵이 크면 오래 걸려서 별도 스레드에서 읽는다
        Thread {
            val map = runCatching { TemiMap.from(robot.getMapData()) }
                .onFailure { Log.w(TAG, "맵 읽기 실패", it) }
                .getOrNull()
            val message = map?.toMessage()?.toString()
            main.post {
                if (map == null || message == null) {
                    ui.banner("TEMI 맵을 읽지 못했어요", true)
                    return@post
                }
                mapMessage = message
                ws?.send(message)
                ui.mapLoaded(map)
            }
        }.start()
    }

    override fun onRequestPermissionResult(permission: Permission, grantResult: Int, requestCode: Int) {
        main.post {
            if (requestCode != REQ_MAP) return@post
            if (grantResult == Permission.GRANTED) loadMap() else ui.banner("맵 권한이 없어 지도를 표시할 수 없어요", true)
        }
    }

    // 이동 중에는 자주 들어온다. 서버에는 0.5초에 한 번만 보낸다
    override fun onCurrentPositionChanged(position: Position) {
        main.post {
            ui.position(position.x, position.y, position.yaw)
            val now = System.currentTimeMillis()
            if (now - lastPositionAt < POSITION_INTERVAL_MS) return@post
            lastPositionAt = now
            sendPosition(position)
        }
    }

    private fun sendPosition(p: Position) {
        send(JSONObject().put("type", "position").put("x", p.x.toDouble()).put("y", p.y.toDouble()).put("yaw", p.yaw.toDouble()))
    }

    // ── 서버 연결 ──

    private fun connect() {
        if (!running) return
        ws = http.newWebSocket(Request.Builder().url(serverUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (webSocket !== ws) return@post
                    retryMs = RETRY_MIN_MS
                    ui.connection(true)
                    send(
                        JSONObject().put("type", "hello").put("robotId", "temi")
                            .put("state", robotState()).put("locations", JSONArray(locations())),
                    )
                    mapMessage?.let { webSocket.send(it) }
                    runCatching { robot.getPosition() }.getOrNull()?.let { sendPosition(it) }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post {
                    if (webSocket !== ws) return@post
                    try {
                        handle(JSONObject(text))
                    } catch (e: Exception) {
                        Log.w(TAG, "메시지 처리 실패: $text", e)
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket)
        })
    }

    // Wi-Fi가 끊기면 간격을 늘려 가며 다시 붙는다. 다시 붙으면 서버가 sync로 진행 중이던 요청을 알려 준다.
    private fun lost(webSocket: WebSocket) {
        main.post {
            if (webSocket !== ws) return@post
            ws = null
            ui.connection(false)
            main.postDelayed({ connect() }, retryMs)
            retryMs = (retryMs * 2).coerceAtMost(RETRY_MAX_MS)
        }
    }

    private fun send(msg: JSONObject) {
        if (ws?.send(msg.toString()) != true) Log.w(TAG, "전송 실패(연결 없음): $msg")
    }

    private fun report(state: String, detail: String? = null) {
        val msg = JSONObject().put("type", "status").put("state", state)
        task?.let { msg.put("requestId", it.requestId) }
        detail?.let { msg.put("detail", it) }
        send(msg)
    }

    private fun robotState() = when (screen) {
        Screen.READY -> "ready"
        Screen.DESK -> "desk"
        Screen.MOVING -> "moving"
        Screen.RETURNING -> "returning"
        Screen.ARRIVED, Screen.PIN, Screen.CONFIRM -> "arrived"
        Screen.IDLE -> "idle"
    }

    private fun setScreen(next: Screen) {
        screen = next
        ui.show(next, task)
    }

    // ── 서버 → 로봇 ──

    private fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            // 첫 시도는 데스크에서 물품을 담고 출발 버튼을 눌러야 출발한다.
            // 이동 실패 후 재시도와, 회수·싣기 완료 버튼으로 온 요청(immediate)은 바로 이동한다.
            "goTo" -> {
                task = Task.from(msg)
                if (task!!.attempt > 1 || msg.optBoolean("immediate")) {
                    startMove()
                } else {
                    setScreen(Screen.READY)
                    report("ready")
                }
            }
            "goHome" -> goHome(msg.optString("location", HOME))
            // 데스크로 돌아오면 회수나 바구니 확인을 받는다. 다음 요청이 새로 들어오면 다시 온다.
            "desk" -> {
                task = null
                desk = DeskTask.from(msg)
                deskSent = false
                setScreen(Screen.DESK)
                report("desk")
            }
            // 버튼을 두 번 눌렀을 때 온 답은 무시한다 (이미 출발했을 수 있다)
            "deskDone" -> if (screen == Screen.DESK) {
                desk = null
                setScreen(Screen.IDLE)
                report("idle")
            }
            "verifyResult" -> if (msg.optBoolean("ok")) {
                setScreen(Screen.CONFIRM)
                speak("인증되었습니다. 바구니에서 물품을 꺼내 주세요.")
            } else {
                ui.banner(msg.optString("reason", "인증 실패"), true)
                setScreen(screen) // PIN 패드를 비우고 QR 인식을 다시 시작한다
            }
            "end" -> {
                if (target != null && target != HOME) robot.stopMovement()
                target = null
                val status = msg.optString("status")
                val reason = msg.optString("reason").takeIf { it.isNotBlank() && it != "null" }
                val text = when (status) {
                    "completed" -> "이용해 주셔서 감사합니다"
                    "cancelled" -> "요청이 취소되었습니다"
                    "expired" -> "요청이 만료되었습니다${reason?.let { " · $it" } ?: ""}"
                    else -> "요청을 처리하지 못했습니다${reason?.let { " · $it" } ?: ""}"
                }
                ui.banner(text, status != "completed")
                if (status == "completed") speak("감사합니다.")
                task = null
                setScreen(Screen.IDLE) // 밖에 있으면 곧 goHome이 온다
            }
            "sync" -> {
                task = Task.from(msg)
                when (msg.optString("status")) {
                    "preparing" -> setScreen(Screen.READY)
                    "moving" -> startMove()
                    "verified" -> setScreen(Screen.CONFIRM)
                    else -> setScreen(if (task!!.rental) Screen.ARRIVED else Screen.CONFIRM)
                }
            }
        }
    }

    // ── 화면 → 로봇 ──

    /** 출발 버튼 */
    fun depart() {
        if (screen == Screen.READY) startMove()
    }

    /** 카메라로 읽은 QR 문자열 또는 PIN 4자리 */
    fun verify(code: String) {
        val t = task ?: return
        send(JSONObject().put("type", "verify").put("requestId", t.requestId).put("code", code))
    }

    /** 대여 완료·반납 완료 버튼 */
    fun complete() {
        val t = task ?: return
        send(JSONObject().put("type", "complete").put("requestId", t.requestId))
    }

    /** 데스크 버튼. found는 바구니 확인 화면에서 고른 값 (회수 완료면 null) */
    fun collected(found: Boolean? = null) {
        val d = desk ?: return
        if (deskSent) return
        deskSent = true
        val msg = JSONObject().put("type", "collected").put("requestId", d.task.requestId)
        found?.let { msg.put("found", it) }
        d.next?.let { msg.put("nextRequestId", it.requestId) }
        send(msg)
    }

    fun showPin() {
        if (screen == Screen.ARRIVED) setScreen(Screen.PIN)
    }

    fun showQr() {
        if (screen == Screen.PIN) setScreen(Screen.ARRIVED)
    }

    // ── 이동 ──

    private fun findLocation(name: String) = locations().firstOrNull { it.equals(name.trim(), ignoreCase = true) }

    private fun startMove() {
        val t = task ?: return
        setScreen(Screen.MOVING)
        report("moving")
        // 맵에 없는 위치로 goTo를 보내면 temi가 반응하지 않으므로 먼저 확인한다
        val location = findLocation(t.location)
        if (location == null) {
            target = null
            val detail = "TEMI 맵에 '${t.location}' 위치가 없어요"
            report("failed", detail)
            ui.banner(detail, true)
            return
        }
        target = location
        robot.goTo(location)
    }

    private fun goHome(name: String) {
        task = null
        homeRetries = 0
        setScreen(Screen.RETURNING)
        report("returning")
        val home = findLocation(name)
        if (home == null) {
            // 홈베이스가 맵에 없으면 (개발 중) 제자리를 홈으로 본다
            target = null
            ui.banner("TEMI 맵에 '$name' 위치가 없어 제자리에서 대기해요", true)
            setScreen(Screen.IDLE)
            report("idle")
            return
        }
        target = home
        robot.goTo(home)
    }

    override fun onGoToLocationStatusChanged(location: String, status: String, descriptionId: Int, description: String) {
        main.post { onGoToStatus(location, status, description) }
    }

    private fun onGoToStatus(location: String, status: String, description: String) {
        val dest = target ?: return
        if (!location.equals(dest, ignoreCase = true)) return // 이전 goTo의 보고는 무시
        val home = dest.equals(HOME, ignoreCase = true)
        when (status) {
            OnGoToLocationStatusChangedListener.COMPLETE -> {
                target = null
                if (home) {
                    setScreen(Screen.IDLE)
                    report("idle")
                } else {
                    // QR 인증은 물품을 받는 대여 학생만 한다
                    val rental = task?.rental == true
                    setScreen(if (rental) Screen.ARRIVED else Screen.CONFIRM)
                    report("arrived")
                    speak("${task?.seat}번 좌석에 도착했습니다. ${if (rental) "앱의 QR 코드를 보여 주세요." else "바구니에 물품을 넣어 주세요."}")
                }
            }
            OnGoToLocationStatusChangedListener.ABORT -> when {
                home && homeRetries < HOME_RETRIES -> {
                    homeRetries++
                    main.postDelayed({ if (target == dest) robot.goTo(dest) }, 3_000)
                }
                home -> {
                    target = null
                    ui.banner("홈베이스로 돌아가지 못했어요. 데스크로 옮겨 주세요", true)
                    report("failed", description.ifBlank { "홈베이스 복귀 실패" })
                }
                else -> {
                    target = null
                    report("failed", description.ifBlank { "이동 실패" })
                    ui.banner("이동하지 못했어요 · 서버 지시를 기다리는 중", true)
                }
            }
        }
    }

    // 도서관이므로 짧게 말한다. 음량은 TEMI 설정에서 낮춰 둔다.
    private fun speak(text: String) {
        runCatching { robot.speak(TtsRequest.create(text, false)) }
    }

    companion object {
        const val HOME = "home base"
        private const val TAG = "RobotBridge"
        private const val RETRY_MIN_MS = 1_000L
        private const val RETRY_MAX_MS = 15_000L
        private const val HOME_RETRIES = 2
        private const val REQ_MAP = 10
        private const val POSITION_INTERVAL_MS = 500L
    }
}
