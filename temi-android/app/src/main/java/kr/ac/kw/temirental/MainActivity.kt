package kr.ac.kw.temirental

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.robotemi.sdk.Robot
import com.robotemi.sdk.listeners.OnRobotReadyListener
import kr.ac.kw.temirental.RobotBridge.Screen

/**
 * TEMI 태블릿 화면. 학생 앱 "도서관 온기"와 같은 색·모양을 쓰고, 구성은 브라우저 시뮬레이터(web/robot-sim)와 같다.
 * TEMI 화면은 가로 1920×1200px, 240dpi → 1280×800dp 기준으로 잡는다. 위쪽은 temi 시스템 상단 바 자리 (TOP_INSET).
 */
class MainActivity : Activity(), RobotBridge.Ui, OnRobotReadyListener {

    private lateinit var bridge: RobotBridge
    private lateinit var root: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var statusChip: TextView
    private lateinit var bannerView: TextView
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("temi-rental", MODE_PRIVATE) }
    private val serverUrl get() = prefs.getString(KEY_URL, null) ?: BuildConfig.DEFAULT_SERVER_URL

    private var scanner: BarcodeView? = null
    private var mapView: MapCanvasView? = null
    private var map: TemiMap? = null
    private var pose: FloatArray? = null
    private var lastScanAt = 0L
    private var pin = ""
    private var connected = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this).apply { setBackgroundColor(BG) }

        // 상단: 브랜드 + 서버 연결 칩. 브랜드를 길게 누르면 서버 주소 설정
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(48), dp(TOP_INSET), dp(48), 0)
        }
        val brand = text("도서관 온기", 24f, GREEN, bold = true).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setOnLongClickListener { openSettings(); true }
        }
        statusChip = chip("")
        top.addView(brand, LinearLayout.LayoutParams(0, WRAP, 1f))
        top.addView(statusChip)
        root.addView(top, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP))

        content = FrameLayout(this)
        root.addView(content, FrameLayout.LayoutParams(MATCH, MATCH).apply { topMargin = dp(TOP_INSET + 40) })

        bannerView = text("", 20f, Color.WHITE, bold = true).apply {
            visibility = View.GONE
            setPadding(dp(28), dp(12), dp(28), dp(12))
        }
        root.addView(bannerView, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(TOP_INSET + 48)
        })
        setContentView(root)

        bridge = RobotBridge(this)
        show(Screen.IDLE, null)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onStart() {
        super.onStart()
        Robot.getInstance().addOnRobotReadyListener(this)
        bridge.start(serverUrl)
        updateStatus()
    }

    override fun onStop() {
        Robot.getInstance().removeOnRobotReadyListener(this)
        bridge.stop()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        scanner?.resume()
    }

    override fun onPause() {
        scanner?.pause()
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQ_CAMERA) show(bridge.screen, bridge.task)
    }

    override fun onRobotReady(isReady: Boolean) {
        if (!isReady) return
        // temi 상단 바 등 temi 시스템 UI가 이 앱을 인식하게 한다
        runCatching { Robot.getInstance().onStart(packageManager.getActivityInfo(componentName, PackageManager.GET_META_DATA)) }
        bridge.loadMap()
    }

    // ── RobotBridge.Ui ──

    override fun connection(connected: Boolean) {
        this.connected = connected
        updateStatus()
    }

    override fun banner(text: String, error: Boolean) {
        bannerView.text = text
        bannerView.background = rounded(if (error) DANGER else TEXT, dp(999))
        bannerView.visibility = View.VISIBLE
        main.removeCallbacks(hideBanner)
        main.postDelayed(hideBanner, 3_500)
    }

    private val hideBanner = Runnable { bannerView.visibility = View.GONE }

    override fun mapLoaded(map: TemiMap) {
        this.map = map
        if (bridge.screen == Screen.MOVING || bridge.screen == Screen.RETURNING) show(bridge.screen, bridge.task)
    }

    override fun position(x: Float, y: Float, yaw: Float) {
        pose = floatArrayOf(x, y, yaw)
        mapView?.robot = pose
    }

    override fun show(screen: Screen, task: RobotBridge.Task?) {
        scanner?.pause()
        scanner = null
        mapView = null
        content.removeAllViews()
        root.setBackgroundColor(if (screen == Screen.MOVING || screen == Screen.RETURNING) MINT else BG)
        val view = when (screen) {
            Screen.IDLE -> idleView()
            Screen.READY -> readyView(task!!)
            Screen.MOVING, Screen.RETURNING -> movingView(if (screen == Screen.RETURNING) null else task)
            Screen.ARRIVED -> arrivedView(task!!)
            Screen.PIN -> pinView(task!!)
            Screen.CONFIRM -> confirmView(task!!)
            Screen.DESK -> deskView(bridge.desk!!)
        }
        content.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    // ── 화면 ──

    private fun idleView() = split(
        column(
            title("책에 집중하는 시간,\n필요한 건 temi에게."),
            lead("앱에서 물품을 고르고 좌석 번호를 입력하면\n자리로 찾아가요."),
        ),
        FrameLayout(this).apply {
            background = rounded(MINT, dp(28))
            setPadding(dp(40), dp(40), dp(40), dp(40))
            addView(TemiArtView(context), FrameLayout.LayoutParams(MATCH, dp(300)))
        },
    )

    private fun readyView(t: RobotBridge.Task) = centered(
        chip("${kind(t)} · 출발 준비"),
        title("${t.seat}번 좌석", size = 64f, color = GREEN).center(),
        card(kv(if (t.rental) "담을 물품" else "받을 물품", item(t)), kv("구역", t.zone)),
        hugeButton(if (t.rental) "물건 싣기 완료" else "출발") { bridge.depart() },
    )

    // 이동 중에는 터치를 받지 않는다. 맵이 있으면 지도에 현재 위치를 보여 준다
    private fun movingView(t: RobotBridge.Task?): View {
        val left: View = map?.let { m ->
            MapCanvasView(this, m).apply {
                target = t?.location ?: RobotBridge.HOME
                targetLabel = t?.let { "${it.seat}번 좌석" } ?: "데스크"
                robot = pose
                background = rounded(SURFACE, dp(24))
                clipToOutline = true
                mapView = this
            }
        } ?: FrameLayout(this).apply { addView(TemiArtView(context), FrameLayout.LayoutParams(MATCH, dp(300))) }
        return split(
            left,
            column(
                chip(if (t == null) "복귀 중" else if (t.rental) "배달 중" else "방문 중", onSurface = true),
                title(if (t == null) "데스크로\n돌아가는 중이에요" else "${t.seat}번 좌석으로\n가는 중이에요"),
                lead("길을 비켜 주시면 감사하겠습니다."),
            ),
            leftWeight = 1.25f,
            leftHeight = dp(520),
        ).apply { isClickable = true }
    }

    private fun arrivedView(t: RobotBridge.Task) = split(
        scannerView(),
        column(
            chip("도착 · QR 인증 대기"),
            title("${t.seat}번 좌석 ${kind(t)}"),
            card(kv(if (t.rental) "받을 물품" else "돌려줄 물품", item(t))),
            lead("앱의 QR 코드를 카메라에 보여 주세요", strong = true),
            ghostButton("PIN으로 인증") { bridge.showPin() },
        ),
        leftHeight = dp(480),
    )

    private fun pinView(t: RobotBridge.Task): View {
        pin = ""
        val boxes = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val cells = List(4) {
            text("", 36f, GREEN, bold = true).apply {
                background = rounded(MINT, dp(16))
                boxes.addView(this, LinearLayout.LayoutParams(dp(76), dp(92)).apply { rightMargin = dp(14) })
            }
        }
        fun refresh() = cells.forEachIndexed { i, cell -> cell.text = if (i < pin.length) "●" else "" }

        val grid = GridLayout(this).apply { columnCount = 3 }
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "QR", "0", "⌫").forEach { key ->
            grid.addView(keyButton(key, sub = key == "QR" || key == "⌫") {
                when (key) {
                    "QR" -> return@keyButton bridge.showQr()
                    "⌫" -> pin = pin.dropLast(1)
                    else -> if (pin.length < 4) pin += key
                }
                refresh()
                if (pin.length == 4) {
                    bridge.verify(pin)
                    pin = ""
                }
            })
        }
        return split(
            column(
                chip("PIN 인증 · ${t.seat}번 좌석"),
                title("앱에 표시된\nPIN을 입력해 주세요"),
                boxes,
            ),
            grid,
        )
    }

    // 대여는 QR 인증 뒤, 반납은 도착하면 바로 나온다. 누르면 데스크로 돌아간다
    private fun confirmView(t: RobotBridge.Task) = centered(
        chip(if (t.rental) "인증 완료" else "도착 · 반납"),
        title(if (t.rental) "바구니에서 물품을 꺼내 주세요" else "바구니에 물품을 넣어 주세요").center(),
        card(kv(if (t.rental) "받을 물품" else "돌려줄 물품", item(t))),
        hugeButton(if (!t.rental) "반납 완료" else if (t.consumable) "수령 완료" else "대여 완료") { bridge.complete() },
    )

    // 데스크: 바구니에 물건이 있으면 회수 완료, 있는지 모르면(시간 초과) 관리자가 보고 고른다
    private fun deskView(d: RobotBridge.DeskTask): View {
        val t = d.task
        if (d.check) {
            return centered(
                chip("바구니 확인"),
                title("바구니를 확인해 주세요").center(),
                lead("학생이 ${if (t.rental) "대여" else "반납"} 완료를 누르지 않았어요. 바구니에 물건이 있나요?").center(),
                card(kv("${t.seat}번 좌석", item(t))),
                LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    tag = STRETCH
                    addView(hugeButton("물건 있음") { bridge.collected(found = true) }, LinearLayout.LayoutParams(0, WRAP, 1f).apply { rightMargin = dp(12) })
                    addView(hugeButton("물건 없음", filled = false) { bridge.collected(found = false) }, LinearLayout.LayoutParams(0, WRAP, 1f).apply { leftMargin = dp(12) })
                },
            )
        }
        val next = d.next
        val rows = mutableListOf(kv("회수할 물품", item(t)))
        if (next != null) rows += kv("다음 · ${next.seat}번 좌석", "${if (next.rental) "담을 물품" else "받을 물품"}: ${item(next)}")
        return centered(
            chip(if (t.rental) "바구니 회수 · 전달하지 못함" else "반납 회수"),
            title("바구니의 물품을 회수해 주세요").center(),
            card(*rows.toTypedArray()),
            hugeButton(if (next == null) "회수 완료" else if (next.rental) "회수·싣기 완료" else "회수 완료 · 출발") { bridge.collected() },
        )
    }

    private fun kind(t: RobotBridge.Task) = if (t.rental) "대여" else "반납"
    private fun item(t: RobotBridge.Task) = "${t.itemName} · ${t.quantity}개"

    // ── QR 인식 ──

    private fun scannerView(): View {
        val frame = FrameLayout(this).apply {
            background = rounded(TEXT, dp(28))
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            frame.addView(text("카메라 권한이 없어요\nPIN으로 인증해 주세요", 22f, Color.parseColor("#B9CBC5"), bold = true),
                FrameLayout.LayoutParams(MATCH, MATCH))
            return frame
        }
        val view = BarcodeView(this)
        view.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        view.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                val code = result.text ?: return
                val now = System.currentTimeMillis()
                // 같은 QR을 연달아 보내지 않는다. 서버 응답(verifyResult)을 기다린다.
                if (!code.startsWith("TLR1:") || now - lastScanAt < SCAN_COOLDOWN_MS) return
                lastScanAt = now
                bridge.verify(code)
            }

            override fun possibleResultPoints(resultPoints: List<ResultPoint>) {}
        })
        scanner = view
        view.resume()
        frame.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
        return frame
    }

    // ── 설정 ──

    private fun openSettings() {
        val input = EditText(this).apply {
            setText(serverUrl)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val locations = bridge.locations().joinToString(", ").ifBlank { "(없음)" }
        AlertDialog.Builder(this)
            .setTitle("서버 주소")
            .setMessage("예: ws://172.20.10.2:3000/ws/robot\n\nTEMI 맵 위치: $locations\n맵: ${map?.let { "${it.width}×${it.height}" } ?: "아직 못 읽음"}")
            .setView(input)
            .setPositiveButton("저장") { _, _ ->
                val url = input.text.toString().trim()
                prefs.edit().putString(KEY_URL, url).apply()
                bridge.changeServer(url)
                updateStatus()
            }
            .setNeutralButton("맵 다시 읽기") { _, _ -> bridge.loadMap() }
            .setNegativeButton("취소", null)
            .show()
    }

    private fun updateStatus() {
        if (!::statusChip.isInitialized) return
        statusChip.text = if (connected) "서버 연결됨" else "서버 연결 안 됨"
        statusChip.setTextColor(if (connected) GREEN else DANGER)
        statusChip.background = rounded(if (connected) MINT else DANGER_SOFT, dp(999))
    }

    // ── 뷰 헬퍼 (학생 앱 app.css 토큰과 같은 값) ──

    /** 좌우 2단. 왼쪽은 그림·지도·카메라, 오른쪽은 안내 */
    private fun split(left: View, right: View, leftWeight: Float = 1f, leftHeight: Int = WRAP) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(48), dp(24), dp(48), dp(48))
        addView(left, LinearLayout.LayoutParams(0, leftHeight, leftWeight).apply { rightMargin = dp(48) })
        addView(right, LinearLayout.LayoutParams(0, WRAP, 1f))
    }

    /** 출발·완료·회수 화면: 모두 가운데에 놓고, 버튼을 크게 */
    private fun centered(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(48), 0, dp(48), dp(48))
        views.forEachIndexed { i, v ->
            addView(v, LinearLayout.LayoutParams(if (v.tag == STRETCH) dp(CENTER_WIDTH) else WRAP, WRAP).apply { if (i > 0) topMargin = dp(20) })
        }
    }

    private fun TextView.center() = apply { gravity = Gravity.CENTER }

    private fun column(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        views.forEachIndexed { i, v ->
            val stretch = v is Button && (v.tag == STRETCH) || v.tag == STRETCH
            addView(v, LinearLayout.LayoutParams(if (stretch) MATCH else WRAP, WRAP).apply { if (i > 0) topMargin = dp(22) })
        }
    }

    private fun text(value: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
    }

    private fun title(value: String, size: Float = 44f, color: Int = TEXT) = text(value, size, color, bold = true).apply {
        gravity = Gravity.START
        setLineSpacing(0f, 1.15f)
    }

    private fun lead(value: String, strong: Boolean = false) = text(value, 22f, if (strong) TEXT else TEXT_2, bold = strong).apply {
        gravity = Gravity.START
        setLineSpacing(0f, 1.3f)
    }

    private fun chip(value: String, onSurface: Boolean = false) = text(value, 17f, GREEN, bold = true).apply {
        background = rounded(if (onSurface) SURFACE else MINT, dp(999))
        setPadding(dp(18), dp(7), dp(18), dp(7))
    }

    private fun card(vararg rows: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(SURFACE, dp(20))
        elevation = dp(2).toFloat()
        setPadding(dp(28), dp(22), dp(28), dp(22))
        tag = STRETCH
        rows.forEachIndexed { i, v -> addView(v, LinearLayout.LayoutParams(MATCH, WRAP).apply { if (i > 0) topMargin = dp(14) }) }
    }

    private fun kv(key: String, value: String) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(text(key, 20f, MUTED).apply { gravity = Gravity.START }, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(text(value, 20f, TEXT, bold = true).apply { gravity = Gravity.END })
    }

    // 서서 누르는 버튼이라 아주 크게 (화면 높이의 20%)
    private fun hugeButton(label: String, filled: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        text = label
        setTextColor(if (filled) Color.WHITE else GREEN)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
        typeface = Typeface.DEFAULT_BOLD
        background = GradientDrawable().apply {
            setColor(if (filled) GREEN else SURFACE)
            cornerRadius = dp(24).toFloat()
            if (!filled) setStroke(dp(3), GREEN)
        }
        minHeight = dp(160)
        stateListAnimator = null
        tag = STRETCH
        setOnClickListener { onClick() }
    }

    private fun ghostButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setTextColor(TEXT_2)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        typeface = Typeface.DEFAULT_BOLD
        background = GradientDrawable().apply {
            setColor(SURFACE)
            cornerRadius = dp(14).toFloat()
            setStroke(dp(2), LINE)
        }
        minHeight = dp(64)
        stateListAnimator = null
        setPadding(dp(32), 0, dp(32), 0)
        setOnClickListener { onClick() }
    }

    private fun keyButton(label: String, sub: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        setTextColor(if (sub) TEXT_2 else TEXT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, if (sub) 22f else 30f)
        typeface = Typeface.DEFAULT_BOLD
        background = GradientDrawable().apply {
            setColor(SURFACE)
            cornerRadius = dp(16).toFloat()
            setStroke(dp(1), LINE)
        }
        stateListAnimator = null
        layoutParams = GridLayout.LayoutParams().apply {
            width = dp(150)
            height = dp(104)
            setMargins(dp(7), dp(7), dp(7), dp(7))
        }
        setOnClickListener { onClick() }
    }

    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius.toFloat()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    /** 학생 앱 temi 일러스트(web/student/illustrations.js)를 단순화한 그림 */
    private class TemiArtView(context: Context) : View(context) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)

        override fun onDraw(canvas: Canvas) {
            val s = minOf(width / 120f, height / 92f)
            canvas.save()
            canvas.translate((width - 120 * s) / 2, (height - 92 * s) / 2)
            canvas.scale(s, s)
            p.color = Color.rgb(0xD9, 0xDE, 0xD9); canvas.drawOval(RectF(26f, 79f, 94f, 89f), p)
            p.color = Color.rgb(0xC8, 0xD3, 0xCE); canvas.drawRect(48f, 40f, 72f, 74f, p)
            p.color = Color.rgb(0xC9, 0xAE, 0x8A); canvas.drawRoundRect(RectF(34f, 44f, 86f, 49f), 2.5f, 2.5f, p)
            p.color = Color.WHITE; canvas.drawRoundRect(RectF(28f, 72f, 92f, 84f), 6f, 6f, p)
            p.color = Color.rgb(0x24, 0x59, 0x4F); canvas.drawRoundRect(RectF(52f, 76f, 68f, 79f), 1.5f, 1.5f, p)
            canvas.rotate(-6f, 60f, 24f)
            canvas.drawRoundRect(RectF(32f, 6f, 88f, 44f), 7f, 7f, p)
            p.color = Color.rgb(0x2D, 0x7A, 0x6C); canvas.drawRoundRect(RectF(37f, 11f, 83f, 39f), 4f, 4f, p)
            p.color = Color.WHITE
            canvas.drawRoundRect(RectF(49f, 21f, 54f, 28f), 2.5f, 2.5f, p)
            canvas.drawRoundRect(RectF(66f, 21f, 71f, 28f), 2.5f, 2.5f, p)
            canvas.restore()
        }
    }

    companion object {
        private const val KEY_URL = "serverUrl"
        private const val REQ_CAMERA = 1
        private const val SCAN_COOLDOWN_MS = 2_500L
        private const val TOP_INSET = 80 // temi 시스템 상단 바 (실기 화면에서 약 65dp)
        private const val CENTER_WIDTH = 820 // 가운데 카드·버튼 폭 (화면 폭 1280dp의 약 64%)
        private const val STRETCH = "stretch"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private val BG = Color.parseColor("#F7F6F2")
        private val SURFACE = Color.WHITE
        private val LINE = Color.parseColor("#EBE8E1")
        private val TEXT = Color.parseColor("#1E2724")
        private val TEXT_2 = Color.parseColor("#4A5551")
        private val MUTED = Color.parseColor("#858D89")
        private val GREEN = Color.parseColor("#2D6E62")
        private val MINT = Color.parseColor("#E5F0EB")
        private val DANGER = Color.parseColor("#C0392B")
        private val DANGER_SOFT = Color.parseColor("#FBE9E6")
    }
}
