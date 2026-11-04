package kr.ac.kw.temirental

import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import com.robotemi.sdk.map.MapDataModel
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * TEMI 맵 한 장. 서버로 보내는 'map' 메시지(docs/robot-protocol.md)와 이동 중 화면의 지도에 같이 쓴다.
 *
 * 좌표 변환 (web/shared/map.js 와 같다):
 *   px = (x - originX) / resolution
 *   py = height - (y - originY) / resolution   ← 비트맵은 위쪽이 y가 큰 쪽이 되도록 행을 뒤집어 만든다
 */
class TemiMap(
    val bitmap: Bitmap,
    val originX: Float,
    val originY: Float,
    val resolution: Float,
    val locations: List<Location>,
    val name: String?,
) {
    data class Location(val name: String, val x: Float, val y: Float)

    val width get() = bitmap.width
    val height get() = bitmap.height

    fun toPixel(x: Float, y: Float) = floatArrayOf((x - originX) / resolution, height - (y - originY) / resolution)

    fun find(name: String?) = locations.firstOrNull { it.name.equals(name?.trim(), ignoreCase = true) }

    fun toMessage(): JSONObject {
        val png = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
        val locs = JSONArray()
        locations.forEach { locs.put(JSONObject().put("name", it.name).put("x", it.x.toDouble()).put("y", it.y.toDouble())) }
        return JSONObject()
            .put("type", "map")
            .put("png", png)
            .put("width", width)
            .put("height", height)
            .put("originX", originX.toDouble())
            .put("originY", originY.toDouble())
            .put("resolution", resolution.toDouble())
            .put("locations", locs)
            .put("name", name ?: JSONObject.NULL)
    }

    companion object {
        // 학생 앱 디자인 색 (web/shared/map.js 배경과 맞춘다)
        private val UNKNOWN = Color.rgb(0xE3, 0xE0, 0xD8)
        private const val FREE = 0xFF
        private const val WALL = 0x9A

        /** temi SDK getMapData() 결과를 비트맵으로. 맵이 없으면 null */
        fun from(data: MapDataModel?): TemiMap? {
            val image = data?.mapImage ?: return null
            val info = data.mapInfo
            val rows = image.rows
            val cols = image.cols
            val cells = image.data
            if (rows <= 0 || cols <= 0 || cells.size < rows * cols) return null

            // 격자 값: -1 알 수 없음, 0~100 장애물일 확률 → 흰색(통로)에서 회색(벽)으로
            val pixels = IntArray(rows * cols)
            for (r in 0 until rows) {
                val outRow = rows - 1 - r // 데이터 0행이 originY 쪽이므로 비트맵에서는 맨 아래로
                for (c in 0 until cols) {
                    val v = cells[r * cols + c]
                    pixels[outRow * cols + c] = if (v < 0) {
                        UNKNOWN
                    } else {
                        val g = FREE - (FREE - WALL) * v.coerceAtMost(100) / 100
                        Color.rgb(g, g + 6.coerceAtMost(0xFF - g), g + 3.coerceAtMost(0xFF - g))
                    }
                }
            }
            val bitmap = Bitmap.createBitmap(pixels, cols, rows, Bitmap.Config.ARGB_8888)

            // 저장 위치: 레이어 이름이 위치 이름, 첫 포즈가 좌표
            val locations = data.locations.mapNotNull { layer ->
                val pose = layer.layerPoses?.firstOrNull() ?: return@mapNotNull null
                Location(layer.layerId, pose.x, pose.y)
            }
            return TemiMap(bitmap, info.originX, info.originY, info.resolution, locations, data.mapName)
        }
    }
}
