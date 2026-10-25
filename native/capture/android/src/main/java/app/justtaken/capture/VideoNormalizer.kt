package app.justtaken.capture

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import java.io.File
import java.io.RandomAccessFile
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal data class NormalizedVideo(val file: File, val width: Int, val height: Int, val durationMs: Int, val hasAudio: Boolean, val codec: String, val bitDepth: Int, val colorTransfer: String, val rotation: Int, val fpsNumerator: Int)
internal object VideoNormalizer {
  private fun hevcDepth(config: ByteBuffer): Int {
    val copy = config.duplicate(); val bytes = ByteArray(copy.remaining()); copy.get(bytes)
    var start = -1
    for (i in 0 until bytes.size - 5) if (bytes[i] == 0.toByte() && bytes[i+1] == 0.toByte() && bytes[i+2] == 1.toByte() && ((bytes[i+3].toInt() and 126) shr 1) == 33) { start = i + 5; break }
    check(start >= 0)
    val raw = ArrayList<Int>()
    for (i in start until bytes.size) if (!(i >= start+2 && bytes[i] == 3.toByte() && bytes[i-1] == 0.toByte() && bytes[i-2] == 0.toByte())) raw.add(bytes[i].toInt() and 255)
    var bit = 0
    fun n(count: Int): Int { var value = 0; repeat(count) { check(bit < raw.size*8); value = (value shl 1) or ((raw[bit/8] shr (7-bit%8)) and 1); bit++ }; return value }
    fun ue(): Int { var zeros = 0; while(n(1)==0) { zeros++; check(zeros < 24) }; return (1 shl zeros)-1+n(zeros) }
    n(4); val layers = n(3); n(1); repeat(96) { n(1) }
    val profile = IntArray(layers); val level = IntArray(layers)
    for(i in 0 until layers) { profile[i]=n(1); level[i]=n(1) }
    if(layers>0) for(i in layers until 8) n(2)
    for(i in 0 until layers) { if(profile[i]==1) repeat(88) { n(1) }; if(level[i]==1) n(8) }
    ue(); check(ue()==1); ue(); ue(); if(n(1)==1) repeat(4) { ue() }
    val depth=ue()+8; check(ue()+8==depth); return depth
  }
  // Only camera-owned recordings reach this function; no path is exposed through the bridge.
  fun normalize(context: Context, source: File): NormalizedVideo {
    val intermediate = File.createTempFile("justtaken-remux-", ".mp4", context.cacheDir)
    val destination = File.createTempFile("justtaken-final-", ".mp4", context.cacheDir)
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(source.path)
      val muxer = MediaMuxer(intermediate.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      var started = false
      var width = 0; var height = 0; var hasAudio = false
      var codec = "h264"; var depth = 8; var transfer = "sdr"; var rotation = 0; var fps = 30000
      val mapping = mutableMapOf<Int, Int>()
      try {
        for (i in 0 until extractor.trackCount) {
          val format = extractor.getTrackFormat(i); val mime = format.getString(MediaFormat.KEY_MIME)
          if (mime == "video/avc" || mime == "video/hevc") {
            check(width == 0); width = format.getInteger(MediaFormat.KEY_WIDTH); height = format.getInteger(MediaFormat.KEY_HEIGHT)
            check(maxOf(width, height) <= 4096 && minOf(width, height) <= 2160)
            codec = if (mime == "video/hevc") "hevc" else "h264"
            depth = if (codec == "hevc") hevcDepth(requireNotNull(format.getByteBuffer("csd-0"))) else 8
            transfer = when (if (format.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) format.getInteger(MediaFormat.KEY_COLOR_TRANSFER) else 3) { 6 -> "pq"; 7 -> "hlg"; else -> "sdr" }
            check(depth in listOf(8,10) && (transfer == "sdr" || depth == 10))
            if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) fps = (format.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat() * 1000).toInt()
            check(fps in 1..60000)
            rotation = if (format.containsKey(MediaFormat.KEY_ROTATION)) format.getInteger(MediaFormat.KEY_ROTATION) else 0
            muxer.setOrientationHint(rotation)
          } else if (mime == "audio/mp4a-latm") {
            check(!hasAudio); hasAudio = true
            if (format.containsKey(MediaFormat.KEY_AAC_PROFILE)) check(format.getInteger(MediaFormat.KEY_AAC_PROFILE) == MediaCodecInfo.CodecProfileLevel.AACObjectLC)
          } else error("Unsupported camera codec")
          // Fresh format: do not copy location, model, author, or arbitrary container metadata.
          val clean = if (mime == "video/avc" || mime == "video/hevc") MediaFormat.createVideoFormat(mime, width, height)
            else MediaFormat.createAudioFormat(mime, format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
          for (key in listOf("csd-0", "csd-1", "csd-2", "hdr-static-info")) if (format.containsKey(key)) clean.setByteBuffer(key, requireNotNull(format.getByteBuffer(key)))
          for (key in listOf(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.KEY_COLOR_RANGE, MediaFormat.KEY_COLOR_TRANSFER)) if (format.containsKey(key)) clean.setInteger(key, format.getInteger(key))
          mapping[i] = muxer.addTrack(clean); extractor.selectTrack(i)
        }
        check(width > 0); muxer.start(); started = true
        val buffer = ByteBuffer.allocate(16_777_216); val info = MediaCodec.BufferInfo()
        val start = extractor.sampleTime; check(start >= 0)
        while (extractor.sampleTrackIndex >= 0) {
          buffer.clear(); val size = extractor.readSampleData(buffer, 0); if (size < 0) break
          check(size <= buffer.capacity()); val time = extractor.sampleTime - start
          check(time in 0 until 60_000_000)
          run {
            info.set(0, size, time, if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            muxer.writeSampleData(requireNotNull(mapping[extractor.sampleTrackIndex]), buffer, info)
          }
          extractor.advance()
        }
        muxer.stop(); started = false
      } finally { if (started) runCatching { muxer.stop() }; muxer.release() }
      val duration = MP4FastStart.rewrite(intermediate, destination)
      check(duration in 1..60_000 && destination.length() in 1..536_870_912)
      return NormalizedVideo(destination, width, height, duration, hasAudio, codec, depth, transfer, rotation, fps)
    } catch (error: Exception) { destination.delete(); throw error }
    finally { extractor.release(); intermediate.delete() }
  }
}
