package app.justtaken.capture
import java.io.ByteArrayOutputStream
internal object JPEGMetadata {
  fun original(bytes: ByteArray, orientation: Int): ByteArray {
    require(orientation in 1..8)
    val clean = strip(bytes)
    val header = intArrayOf(255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0).map { it.toByte() }.toByteArray()
    return header + clean.copyOfRange(2, clean.size)
  }
  fun strip(bytes: ByteArray): ByteArray {
    fun at(index: Int) = bytes[index].toInt() and 255
    require(bytes.size >= 4 && at(0) == 255 && at(1) == 216)
    val out = ByteArrayOutputStream(bytes.size); out.write(bytes, 0, 2); var offset = 2
    while (offset + 3 < bytes.size) {
      require(at(offset) == 255)
      val marker = at(offset + 1)
      if (marker == 218 || marker == 217) { out.write(bytes, offset, bytes.size - offset); return out.toByteArray() }
      val length = at(offset + 2) * 256 + at(offset + 3)
      require(length >= 2 && offset + length + 2 <= bytes.size)
      if (marker == 226) require(length >= 16 && String(bytes, offset+4, 12, Charsets.US_ASCII) == "ICC_PROFILE\u0000") { "Unsupported JPEG auxiliary image; original must not be flattened" }
      val metadata = (marker in 224..239 && marker != 224 && marker != 226) || marker == 254
      if (!metadata) out.write(bytes, offset, length + 2)
      offset += length + 2
    }
    error("Invalid JPEG")
  }
}
