package kr.ac.kw.temirental

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View

/** 이동 중 TEMI 화면의 지도. 그리는 방식은 web/shared/map.js drawMap()과 같다. */
class MapCanvasView(context: Context, private val map: TemiMap) : View(context) {

    var robot: FloatArray? = null // x, y, yaw (TEMI 맵 좌표)
        set(value) {
            field = value
            invalidate()
        }
    var target: String? = null
    var targetLabel: String = "목적지"

    private val density = resources.displayMetrics.density
    private val bitmapPaint = Paint().apply { isFilterBitmap = false }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
        textSize = 15 * density
    }
    private val textStroke = Paint(text).apply {
        style = Paint.Style.STROKE
        strokeWidth = 5 * density
        color = Color.WHITE
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        val goal = map.find(target)
        val home = map.find(RobotBridge.HOME)
        val pose = robot

        // 데스크·목적지·temi가 모두 보이게 잘라 낸다 (2m 여백)
        val points = listOfNotNull(goal?.let { map.toPixel(it.x, it.y) }, home?.let { map.toPixel(it.x, it.y) }, pose?.let { map.toPixel(it[0], it[1]) })
        var x0 = 0f
        var y0 = 0f
        var x1 = map.width.toFloat()
        var y1 = map.height.toFloat()
        if (points.isNotEmpty()) {
            val pad = 2f / map.resolution
            x0 = points.minOf { it[0] } - pad
            x1 = points.maxOf { it[0] } + pad
            y0 = points.minOf { it[1] } - pad
            y1 = points.maxOf { it[1] } + pad
        }
        var rw = x1 - x0
        var rh = y1 - y0
        val aspect = w / h
        if (rw / rh > aspect) rh = rw / aspect else rw = rh * aspect
        val left = (x0 + x1) / 2 - rw / 2
        val top = (y0 + y1) / 2 - rh / 2
        val scale = w / rw
        fun sx(px: Float) = (px - left) * scale
        fun sy(py: Float) = (py - top) * scale

        canvas.drawColor(Color.rgb(0xEF, 0xED, 0xE6))
        canvas.drawBitmap(map.bitmap, null, RectF(sx(0f), sy(0f), sx(map.width.toFloat()), sy(map.height.toFloat())), bitmapPaint)

        val r = 8 * density
        for (l in map.locations) {
            if (l == goal || l == home) continue
            val p = map.toPixel(l.x, l.y)
            dot(canvas, sx(p[0]), sy(p[1]), r * 0.7f, ZONE)
        }
        home?.let { val p = map.toPixel(it.x, it.y); marker(canvas, sx(p[0]), sy(p[1]), "데스크", HOME_COLOR, r) }
        goal?.let { val p = map.toPixel(it.x, it.y); marker(canvas, sx(p[0]), sy(p[1]), targetLabel, GREEN, r) }
        pose?.let {
            val p = map.toPixel(it[0], it[1])
            drawRobot(canvas, sx(p[0]), sy(p[1]), it[2], r * 1.5f)
        }
    }

    private fun dot(canvas: Canvas, x: Float, y: Float, r: Float, color: Int) {
        fill.color = color
        canvas.drawCircle(x, y, r, fill)
    }

    private fun marker(canvas: Canvas, x: Float, y: Float, label: String, color: Int, r: Float) {
        dot(canvas, x, y, r + 2 * density, Color.WHITE)
        dot(canvas, x, y, r, color)
        val ty = y - r - 8 * density
        canvas.drawText(label, x, ty, textStroke)
        text.color = color
        canvas.drawText(label, x, ty, text)
    }

    // 흰 테두리 원 + 진행 방향 삼각형 (yaw는 라디안, 맵 x축 기준 반시계 → 화면은 y가 아래라 반대로 돈다)
    private fun drawRobot(canvas: Canvas, x: Float, y: Float, yaw: Float, r: Float) {
        canvas.save()
        canvas.translate(x, y)
        canvas.rotate(Math.toDegrees(-yaw.toDouble()).toFloat())
        val arrow = Path().apply {
            moveTo(r * 1.9f, 0f)
            lineTo(r * 0.6f, -r * 0.75f)
            lineTo(r * 0.6f, r * 0.75f)
            close()
        }
        fill.color = GREEN
        canvas.drawPath(arrow, fill)
        canvas.restore()
        dot(canvas, x, y, r + 3 * density, Color.WHITE)
        dot(canvas, x, y, r, GREEN)
    }

    companion object {
        private val GREEN = Color.rgb(0x2D, 0x6E, 0x62)
        private val ZONE = Color.rgb(0x9C, 0xB8, 0xAD)
        private val HOME_COLOR = Color.rgb(0xA0, 0x64, 0x2B)
    }
}
