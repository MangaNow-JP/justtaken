package app.justtaken.capture
import java.io.File
fun main(args: Array<String>) {
  val source=File(args[0]).readBytes();val expected=File(args[1]).readBytes()
  val output=JPEGMetadata.original(source,6)
  check(output.contentEquals(expected)) { "Android and iOS metadata-only outputs differ" }
  check(JPEGMetadata.strip(output).contentEquals(JPEGMetadata.strip(source)))
  println("PASS: Android JPEG keeps compressed pixels + ICC, matches iOS orientation-only metadata")
}
