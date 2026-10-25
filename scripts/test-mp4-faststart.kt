package app.justtaken.capture
import java.io.File
fun main(args: Array<String>) {
  val duration = MP4FastStart.rewrite(File(args[0]), File(args[1]))
  check(duration == 2000)
  println("Kotlin faststart: duration=$duration, bytes=${File(args[1]).length()}")
}
