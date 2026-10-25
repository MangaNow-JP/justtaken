package app.justtaken.capture

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.Paint
import android.graphics.Rect
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

// No method that takes a caller-supplied file path is exposed to JavaScript.
internal object CaptureStore {
  private fun root(context: Context) = File(context.noBackupFilesDir, "JustTakenCaptures").apply { check(exists() || mkdirs()) }
  private fun directory(context: Context, handle: String): File {
    require(UUID.fromString(handle).toString().equals(handle, ignoreCase = true))
    return File(root(context), handle)
  }
  @Synchronized fun create(context: Context, cameraFile: File, mime: String, companion: File?, capturedAt: String, binding: JSONObject, requireHDR: Boolean = false, location: JSONObject): String {
    val raw = mime == "image/x-adobe-dng"
    check(cameraFile.length() in 1..(if(raw) 536_870_912L else 134_217_728L)) { "写真が原本の容量上限を超えています。圧縮は行いません。" }
    val exif = android.media.ExifInterface(cameraFile.path)
    check(exif.getAttribute(android.media.ExifInterface.TAG_GPS_LATITUDE) == null && exif.getAttribute(android.media.ExifInterface.TAG_GPS_LONGITUDE) == null) { "位置情報を含む原本は投稿できません。" }
    val orientation = exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1).let { if (it in 1..8) it else 1 }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(cameraFile.path, bounds)
    val originalWidth = if(raw) exif.getAttributeInt(android.media.ExifInterface.TAG_IMAGE_WIDTH, bounds.outWidth) else bounds.outWidth
    val originalHeight = if(raw) exif.getAttributeInt(android.media.ExifInterface.TAG_IMAGE_LENGTH, bounds.outHeight) else bounds.outHeight
    check(originalWidth > 0 && originalHeight > 0 && max(originalWidth, originalHeight) <= 16384 && originalWidth.toLong()*originalHeight <= 200_000_000)
    val previewFile = companion ?: cameraFile
    BitmapFactory.decodeFile(previewFile.path, bounds)
    check(bounds.outWidth > 0 && bounds.outHeight > 0)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 480) sample *= 2
    val decoded = requireNotNull(BitmapFactory.decodeFile(previewFile.path, BitmapFactory.Options().apply { inSampleSize = sample }))
    // Gain-map API was introduced in Android 14; older supported OS versions keep SDR previews.
    val gainMap = !raw && android.os.Build.VERSION.SDK_INT >= 34 && Bitmap::class.java.getMethod("hasGainmap").invoke(decoded) == true
    if(requireHDR && !gainMap) { decoded.recycle(); error("カメラがHDRゲインマップを出力しませんでした。もう一度撮影してください。") }
    val previewExif = if(companion != null) android.media.ExifInterface(companion.path) else exif
    val previewOrientation = previewExif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)
    val matrix = Matrix().apply { when(previewOrientation) { 2 -> postScale(-1f,1f); 3 -> postRotate(180f); 4 -> postScale(1f,-1f); 5 -> { postRotate(90f); postScale(-1f,1f) }; 6 -> postRotate(90f); 7 -> { postRotate(270f); postScale(-1f,1f) }; 8 -> postRotate(270f) } }
    val rotated = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    val ratio = min(1.0, 480.0 / max(rotated.width, rotated.height))
    val width = max(1, (rotated.width * ratio).toInt()); val height = max(1, (rotated.height * ratio).toInt())
    val preview = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888, false, ColorSpace.get(ColorSpace.Named.SRGB))
    val thumbnail = try { Canvas(preview).drawBitmap(rotated, null, Rect(0,0,width,height), Paint(Paint.FILTER_BITMAP_FLAG)); encode(preview, 65_536) }
      finally { preview.recycle(); if (rotated !== decoded) rotated.recycle(); decoded.recycle() }
    val handle = UUID.randomUUID().toString(); val dir = directory(context, handle)
    val used = root(context).walkTopDown().filter { it.isFile }.sumOf { it.length() }
    check(used + cameraFile.length() + thumbnail.size <= 2_147_483_648L) { "保存枠がいっぱいです。下書きを削除してください。" }
    check(dir.mkdirs())
    try {
      // File copy is deliberate: do not pass camera originals through a bitmap encoder,
      // EXIF writer or container rewrite. Hash all bytes, including RAW/HDR auxiliaries.
      val original = File(dir, "original" + extension(mime)); cameraFile.copyTo(original)
      File(dir, "thumbnail.jpg").writeBytes(thumbnail)
      val assets = JSONArray().put(JSONObject(mapOf("id" to "original", "role" to "original", "mime" to mime, "bytes" to original.length(), "width" to originalWidth, "height" to originalHeight, "orientation" to orientation, "preservation" to "camera-original", "hasGainMap" to gainMap, "sha256" to fileHash(original))))
        .put(JSONObject(mapOf("id" to "thumbnail", "role" to "thumbnail", "mime" to "image/jpeg", "bytes" to thumbnail.size, "width" to width, "height" to height, "sha256" to fileHash(File(dir,"thumbnail.jpg")))))
      val metadata = JSONObject().put("location", location).put("session", binding).put("handle", handle).put("capturedAt", capturedAt).put("kind", "photo").put("policyVersion", "capture-v3").put("verification", "unverified").put("assets", assets)
      val temp = File(dir,"draft.tmp"); temp.writeText(metadata.toString()); check(temp.renameTo(File(dir,"draft.json")))
      return handle
    } catch (error: Exception) { dir.deleteRecursively(); throw error }
  }
  private fun extension(mime: String) = when(mime) { "image/jpeg" -> ".jpg"; "image/heic" -> ".heic"; "image/x-adobe-dng" -> ".dng"; "video/mp4" -> ".mp4"; else -> error("Invalid original format") }
  @Synchronized fun createVideo(context: Context, video: NormalizedVideo, capturedAt: String, binding: JSONObject, location: JSONObject): String {
    val handle = UUID.randomUUID().toString(); val dir = directory(context, handle)
    check(root(context).walkTopDown().filter { it.isFile }.sumOf { it.length() } + video.file.length() + 65_536 <= 2_147_483_648L)
    check(dir.mkdirs())
    try {
      val file = File(dir, "original.mp4"); video.file.copyTo(file)
      val retriever = android.media.MediaMetadataRetriever()
      val bitmap = try { retriever.setDataSource(file.path); requireNotNull(retriever.getScaledFrameAtTime(0, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 480)) } finally { retriever.release() }
      val ratio = min(1.0, 480.0 / max(bitmap.width, bitmap.height))
      val width = max(1, (bitmap.width * ratio).toInt()); val height = max(1, (bitmap.height * ratio).toInt())
      val normalized = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888, false, ColorSpace.get(ColorSpace.Named.SRGB))
      val poster = try { Canvas(normalized).drawBitmap(bitmap, null, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG)); encode(normalized, 65_536) } finally { bitmap.recycle(); normalized.recycle() }
      File(dir, "poster.jpg").writeBytes(poster)
      val original = JSONObject(mapOf("id" to "original", "role" to "original", "mime" to "video/mp4", "bytes" to file.length(), "width" to video.width, "height" to video.height, "durationMs" to video.durationMs, "videoCodec" to video.codec, "videoBitDepth" to video.bitDepth, "colorTransfer" to video.colorTransfer, "rotationDegrees" to video.rotation, "fpsNumerator" to video.fpsNumerator, "fpsDenominator" to 1000, "sha256" to fileHash(file)))
      if (video.hasAudio) original.put("audioCodec", "aac-lc")
      val assets = JSONArray().put(original).put(JSONObject(mapOf("id" to "poster", "role" to "poster", "mime" to "image/jpeg", "bytes" to poster.size, "width" to width, "height" to height, "sha256" to fileHash(File(dir, "poster.jpg")))))
      val metadata = JSONObject().put("location", location).put("session", binding).put("handle", handle).put("capturedAt", capturedAt).put("kind", "video").put("policyVersion", "capture-v2").put("verification", "unverified").put("assets", assets)
      val temp = File(dir, "draft.tmp"); temp.writeText(metadata.toString()); check(temp.renameTo(File(dir, "draft.json")))
      return handle
    } catch (error: Exception) { dir.deleteRecursively(); throw error }
  }
  private fun fileHash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(65_536); var n: Int; while (input.read(buffer).also { n = it } >= 0) digest.update(buffer, 0, n) }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
  }
  private fun encode(bitmap: Bitmap, limit: Int): ByteArray {
    for (quality in 86 downTo 26 step 10) {
      val buffer = ByteArrayOutputStream()
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, buffer))
      val bytes = JPEGMetadata.strip(buffer.toByteArray())
      if (bytes.size <= limit) return bytes
    }
    error("写真を容量上限内に保存できませんでした。もう一度撮影してください。")
  }
  @Synchronized fun read(context: Context, handle: String): Map<String, Any?> {
    val dir = directory(context, handle)
    val metadata = JSONObject(File(dir, "draft.json").readText())
    val isVideo = metadata.getString("kind") == "video"
    metadata.put("previewUri", File(dir, if (isVideo) "poster.jpg" else "thumbnail.jpg").toURI().toString())
    metadata.put("mediaUri", File(dir, "original" + extension(metadata.getJSONArray("assets").getJSONObject(0).getString("mime"))).toURI().toString())
    return jsonMap(metadata)
  }
  @Synchronized fun manifest(context: Context, handle: String): JSONObject {
    val dir = directory(context, handle)
    val draft = JSONObject(File(dir, "draft.json").readText())
    val binding = draft.getJSONObject("session")
    val assets = draft.getJSONArray("assets")
    for (i in 0 until assets.length()) {
      val asset = assets.getJSONObject(i); val role = asset.getString("id")
      require(role in listOf("original", "thumbnail", "poster"))
      val file = File(dir, role + extension(asset.getString("mime")))
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input -> val buffer = ByteArray(16384); var n: Int; while (input.read(buffer).also { n = it } >= 0) digest.update(buffer, 0, n) }
      val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
      check(hash == asset.getString("sha256") && file.length() == asset.getLong("bytes"))
    }
    val result = JSONObject().put("version", 1).put("policyVersion", draft.optString("policyVersion", "capture-v1")).put("sessionId", binding.getString("sessionId")).put("installationId", binding.getString("installationId")).put("accountBindingId", binding.getString("accountBindingId")).put("nonce", binding.getString("nonce")).put("clientCaptureId", handle).put("clientCapturedAt", draft.getString("capturedAt")).put("kind", draft.getString("kind")).put("assets", assets)
    if (draft.has("location")) result.put("location", draft.getJSONObject("location"))
    return result
  }
  fun upload(context: Context, handle: String, assetId: String, accessToken: String) {
    require(assetId in listOf("original", "thumbnail", "poster") && Regex("^[A-Za-z0-9_-]{36}\\.[A-Za-z0-9_-]{43}$").matches(accessToken))
    val info = context.packageManager.getApplicationInfo(context.packageName, android.content.pm.PackageManager.GET_META_DATA)
    val origin = java.net.URI(requireNotNull(info.metaData.getString("app.justtaken.API_ORIGIN")))
    require(origin.scheme == "https" && origin.host != null && origin.rawUserInfo == null)
    val data = manifest(context, handle)
    val assets = data.getJSONArray("assets")
    val asset = (0 until assets.length()).map { assets.getJSONObject(it) }.first { it.getString("id") == assetId }
    val mime = asset.getString("mime")
    val path = "/v1/installations/${data.getString("installationId")}/captures/${data.getString("sessionId")}/assets/$assetId"
    val file = File(directory(context, handle), assetId + extension(mime))
    fun request(suffix: String, method: String, chunk: ByteArray? = null, whole: Boolean = false): String {
      val connection = origin.resolve(path + suffix).toURL().openConnection() as javax.net.ssl.HttpsURLConnection
      try {
        connection.instanceFollowRedirects = false; connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 180000
        connection.setRequestProperty("Authorization", "Bearer $accessToken")
        if (method == "PUT") {
          connection.doOutput = true; connection.setRequestProperty("Content-Type", mime)
          connection.setFixedLengthStreamingMode(if (whole) file.length() else requireNotNull(chunk).size.toLong())
          if (chunk != null) connection.setRequestProperty("X-Chunk-SHA256", MessageDigest.getInstance("SHA-256").digest(chunk).joinToString("") { "%02x".format(it.toInt() and 255) })
          connection.outputStream.use { out -> if (whole) file.inputStream().use { it.copyTo(out, 16384) } else out.write(requireNotNull(chunk)) }
        }
        check(connection.responseCode in 200..299) { "原画を送信できませんでした。再試行すると未送信の部分から続けます。" }
        return connection.inputStream.use { input ->
          val output = ByteArrayOutputStream(); val buffer = ByteArray(4096); var size: Int
          while (input.read(buffer).also { size=it } >= 0) { check(output.size()+size<=65536); output.write(buffer,0,size) }
          output.toString("UTF-8")
        }
      } finally { connection.disconnect() }
    }
    if (file.length() <= 8_388_608) { request("", "PUT", whole=true); return }
    val state = JSONObject(request("/multipart", "POST")); val partBytes=state.getInt("partBytes"); val total=state.getInt("totalParts")
    check(partBytes == 8_388_608 && total.toLong() == (file.length()+partBytes-1)/partBytes)
    if(state.getBoolean("complete")) return
    val sent = state.getJSONArray("uploadedParts"); val uploaded = (0 until sent.length()).map { sent.getInt(it) }.toSet()
    java.io.RandomAccessFile(file,"r").use { input ->
      for(part in 1..total) if(part !in uploaded) {
        val offset=(part-1).toLong()*partBytes; val chunk=ByteArray(minOf(partBytes.toLong(),file.length()-offset).toInt())
        input.seek(offset); input.readFully(chunk); request("/parts/$part","PUT",chunk)
      }
    }
    request("/uploaded","POST")
  }

  @Synchronized fun list(context: Context): List<Map<String, Any?>> = root(context).listFiles().orEmpty().mapNotNull { runCatching { read(context, it.name) }.getOrNull() }.sortedByDescending { it["capturedAt"] as? String }
  @Synchronized fun discard(context: Context, handle: String) {
    val dir = directory(context, handle)
    check(!dir.exists() || dir.deleteRecursively())
  }
  fun jsonMap(json: JSONObject): Map<String, Any?> = json.keys().asSequence().associateWith { key -> unwrap(json.get(key)) }
  private fun unwrap(value: Any?): Any? = when (value) {
    is JSONObject -> jsonMap(value)
    is JSONArray -> (0 until value.length()).map { unwrap(value.get(it)) }
    JSONObject.NULL -> null
    else -> value
  }
}
