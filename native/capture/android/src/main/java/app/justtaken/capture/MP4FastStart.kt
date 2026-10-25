package app.justtaken.capture

import java.io.File
import java.io.RandomAccessFile
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Move bounded moov metadata ahead of mdat; copy payloads without loading the whole video.
internal object MP4FastStart {
  private fun int(b: ByteArray, p: Int) = ByteBuffer.wrap(b, p, 4).order(ByteOrder.BIG_ENDIAN).int
  private fun tag(b: ByteArray, p: Int) = String(b, p, 4, Charsets.US_ASCII)
  private fun rewrite(b: ByteArray, delta: Int): ByteArray {
    val output = ByteArrayOutputStream(); var p = 0
    while (p < b.size) {
      check(p + 8 <= b.size); val size = int(b, p); check(size >= 8 && p + size <= b.size)
      val type = tag(b, p + 4); var body = b.copyOfRange(p + 8, p + size)
      if (type !in listOf("udta", "meta", "uuid")) {
        if (type in listOf("moov", "trak", "mdia", "minf", "stbl", "edts", "dinf")) body = rewrite(body, delta)
        if (type in listOf("stco", "co64")) {
          val count = int(body, 4); val stride = if (type == "co64") 8 else 4; check(count in 1..4096 && body.size == 8 + count * stride)
          val bytes = ByteBuffer.wrap(body).order(ByteOrder.BIG_ENDIAN)
          for (i in 0 until count) { val at = 8 + i * stride; if (stride == 8) { val offset = bytes.getLong(at) + delta; check(offset > 0); bytes.putLong(at, offset) } else { val offset = bytes.getInt(at).toLong() + delta; check(offset in 1..Int.MAX_VALUE); bytes.putInt(at, offset.toInt()) } }
        }
        output.write(ByteBuffer.allocate(4).putInt(8 + body.size).array()); output.write(type.toByteArray(Charsets.US_ASCII)); output.write(body)
      }
      p += size
    }
    return output.toByteArray()
  }
  fun rewrite(source: File, destination: File): Int {
    RandomAccessFile(source, "r").use { input ->
      var ftyp: ByteArray? = null; var moov: ByteArray? = null; var mdatOffset = 0L; var mdatSize = 0; var duration = 0
      while (input.filePointer < input.length()) {
        val offset = input.filePointer; val size = input.readInt(); val kind = ByteArray(4); input.readFully(kind); val type = String(kind, Charsets.US_ASCII)
        check(size >= 8 && offset + size <= input.length())
        when (type) {
          "ftyp", "moov" -> {
            check(size <= if (type == "moov") 524288 else 1024)
            input.seek(offset); val data = ByteArray(size); input.readFully(data)
            if (type == "ftyp") { check(ftyp == null); ftyp = data } else { check(moov == null); moov = rewrite(data, 0) }
          }
          "mdat" -> { check(mdatSize == 0); mdatOffset = offset; mdatSize = size }
          "free", "wide" -> Unit
          else -> error("Unexpected MP4 atom")
        }
        input.seek(offset + size)
      }
      val fileType = requireNotNull(ftyp); val movie = requireNotNull(moov); check(mdatSize > 8)
      var p = 8
      while (p < movie.size) {
        val size = int(movie, p); check(size >= 8 && p + size <= movie.size)
        if (tag(movie, p + 4) == "mvhd") {
          val start = p + 8; check(movie[start].toInt() == 0); val scale = int(movie, start + 12); check(scale > 0)
          duration = ((int(movie, start + 16).toLong() * 1000 + scale / 2) / scale).toInt()
        }; p += size
      }
      val delta = fileType.size + movie.size - mdatOffset.toInt(); val finalMovie = rewrite(movie, delta)
      destination.outputStream().use { out ->
        out.write(fileType); out.write(finalMovie); input.seek(mdatOffset)
        val buffer = ByteArray(65_536); var remaining = mdatSize
        while (remaining > 0) { val n = input.read(buffer, 0, minOf(buffer.size, remaining)); check(n > 0); out.write(buffer, 0, n); remaining -= n }
      }
      return duration
    }
  }
}
