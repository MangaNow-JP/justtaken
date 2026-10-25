package app.justtaken.capture

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.util.Range
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.core.DynamicRange
import androidx.camera.core.Camera
import androidx.camera.video.*
import java.io.File
import java.util.concurrent.TimeUnit
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.time.Instant
import java.util.concurrent.Executors

class JustTakenCaptureView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val locationTracker = CaptureLocationTracker(context)
  fun setLocationEnabled(value: Boolean) { locationTracker.setEnabled(value) }
  private val onCapture by EventDispatcher()
  private val onRecording by EventDispatcher()
  private val onReady by EventDispatcher()
  private val onError by EventDispatcher()
  private val previewView = PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
  private var provider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var recording: Recording? = null
  private var camera: Camera? = null
  private var mode = "photo"
  private var photoFormat = "jpeg"
  private var formats = listOf("jpeg")
  private var heifCamera: HeifCamera? = null
  private val heifPreview = android.view.TextureView(context)
  fun setPhotoFormat(value: String) { if (value != photoFormat && !capturing) { photoFormat = value; if (isAttachedToWindow) bind() } }
  var audioEnabled = false
  private var facing = CameraSelector.LENS_FACING_BACK
  private var lastShutter = 0
  private var capturing = false
  private var generation = 0
  private var executor = Executors.newSingleThreadExecutor()
  var flashEnabled = false
  var captureSession = ""
  init { addView(previewView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)); addView(heifPreview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)); heifPreview.visibility = android.view.View.GONE }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) { previewView.layout(0, 0, right - left, bottom - top); heifPreview.layout(0, 0, right - left, bottom - top) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); (appContext.currentActivity as? LifecycleOwner)?.let { locationTracker.attach(it) }; if (executor.isShutdown) executor = Executors.newSingleThreadExecutor(); bind() }
  override fun onDetachedFromWindow() {
    locationTracker.detach()
    generation++; heifCamera?.close(); heifCamera = null
    recording?.stop()
    videoCapture?.let { provider?.unbind(it) }
    preview?.let { provider?.unbind(it) }; imageCapture?.let { provider?.unbind(it) }
    executor.shutdown(); super.onDetachedFromWindow()
  }
  fun setFacing(value: String) {
    val next = if (value == "front") CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK
    if (next != facing && !capturing) { facing = next; if (isAttachedToWindow) bind() }
  }
  fun setMode(value: String) {
    if (value != mode && !capturing) { mode = if (value == "video") "video" else "photo"; if (isAttachedToWindow) bind() }
  }
  private fun bind() {
    val owner = appContext.currentActivity as? LifecycleOwner ?: run { onError(mapOf("message" to "撮影画面を準備できませんでした。")); return }
    val current = ++generation
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (!isAttachedToWindow || generation != current) return@addListener
      try {
        provider = future.get()
        preview?.let { provider?.unbind(it) }; imageCapture?.let { provider?.unbind(it) }; videoCapture?.let { provider?.unbind(it) }
        heifCamera?.close(); heifCamera = null
        val newPreview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val selector = CameraSelector.Builder().requireLensFacing(facing).build()
        onReady(mapOf("ready" to false))
        val info = selector.filter(provider!!.availableCameraInfos).first()
        val outputs = ImageCapture.getImageCaptureCapabilities(info).supportedOutputFormats
        formats = buildList {
          add("jpeg")
          if (HeifCamera.available(context, facing == CameraSelector.LENS_FACING_FRONT)) add("heif")
          if (outputs.contains(ImageCapture.OUTPUT_FORMAT_RAW_JPEG)) add("raw")
          if (android.os.Build.VERSION.SDK_INT >= 34 && outputs.contains(ImageCapture.OUTPUT_FORMAT_JPEG_ULTRA_HDR)) add("hdr")
        }
        onReady(mapOf("ready" to false, "photoFormats" to formats))
        if (mode == "photo" && !formats.contains(photoFormat)) { onError(mapOf("message" to "このカメラは選択した形式に対応していません。別の形式を選んでください。")); return@addListener }
        val heif = mode == "photo" && photoFormat == "heif"
        heifPreview.visibility = if (heif) android.view.View.VISIBLE else android.view.View.GONE
        previewView.visibility = if (heif) android.view.View.GONE else android.view.View.VISIBLE
        if (heif) {
          imageCapture = null; videoCapture = null; preview = null
          heifCamera = HeifCamera(context, heifPreview, facing == CameraSelector.LENS_FACING_FRONT, owner, { ready -> post { if(generation == current) onReady(mapOf("ready" to ready, "photoFormats" to formats)) } }, { message -> post { if(generation == current) { capturing = false; onError(mapOf("message" to message)) } } })
          heifCamera!!.open(); return@addListener
        }
        if (mode == "video") {
          val recorder = Recorder.Builder().setQualitySelector(QualitySelector.from(Quality.UHD, FallbackStrategy.lowerQualityThan(Quality.UHD))).build()
          val cameraInfo = selector.filter(provider!!.availableCameraInfos).first()
          val ranges = Recorder.getVideoCapabilities(cameraInfo).supportedDynamicRanges
          val dynamicRange = if (ranges.contains(DynamicRange.HLG_10_BIT)) DynamicRange.HLG_10_BIT else DynamicRange.SDR
          val video = VideoCapture.Builder(recorder).setDynamicRange(dynamicRange).setTargetFrameRate(Range(30, 30)).build()
          camera = provider!!.bindToLifecycle(owner, selector, newPreview, video)
          videoCapture = video; imageCapture = null
        } else {
          val newCapture = ImageCapture.Builder().setOutputFormat(when(photoFormat) { "raw" -> ImageCapture.OUTPUT_FORMAT_RAW_JPEG; "hdr" -> ImageCapture.OUTPUT_FORMAT_JPEG_ULTRA_HDR; else -> ImageCapture.OUTPUT_FORMAT_JPEG }).setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY).setJpegQuality(100).setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY).build()).build()
          camera = provider!!.bindToLifecycle(owner, selector, newPreview, newCapture)
          imageCapture = newCapture; videoCapture = null
        }
        preview = newPreview
        onReady(mapOf("ready" to true, "photoFormats" to formats))
      } catch (_: Exception) { onError(mapOf("message" to "この環境ではカメラを利用できません。")) }
    }, ContextCompat.getMainExecutor(context))
  }
  private fun startRecording() {
    if (capturing) return
    val video = videoCapture ?: return
    val binding = try { CaptureProof.binding(captureSession) } catch (_: Exception) { onError(mapOf("message" to "撮影の準備をやり直してください。")); return }
    if (audioEnabled && ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { onError(mapOf("message" to "マイクの許可を確認してください。無音でも撮影できます。")); return }
    val source = File.createTempFile("justtaken-camera-", ".mp4", context.cacheDir)
    val captureTime = Instant.now()
    val capturedAt = captureTime.toString()
    val location = locationTracker.snapshot(captureTime)
    capturing = true
    try {
      video.targetRotation = display?.rotation ?: 0
      camera?.cameraControl?.enableTorch(flashEnabled && camera?.cameraInfo?.hasFlashUnit() == true)
      val options = FileOutputOptions.Builder(source).setDurationLimitMillis(59_800).setFileSizeLimit(536_870_912).build()
      val pending = video.output.prepareRecording(context, options)
      if (audioEnabled) pending.withAudioEnabled()
      recording = pending.start(ContextCompat.getMainExecutor(context)) { event ->
        when (event) {
          is VideoRecordEvent.Start, is VideoRecordEvent.Status -> onRecording(mapOf("recording" to true, "finalizing" to false, "durationMs" to TimeUnit.NANOSECONDS.toMillis(event.recordingStats.recordedDurationNanos)))
          is VideoRecordEvent.Finalize -> {
            recording?.close(); recording = null; camera?.cameraControl?.enableTorch(false)
            val valid = event.error in listOf(VideoRecordEvent.Finalize.ERROR_NONE, VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED, VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED, VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE)
            if (!valid) { capturing = false; source.delete(); onRecording(mapOf("recording" to false, "finalizing" to false, "durationMs" to 0)); onError(mapOf("message" to "動画の録画が中断されました。もう一度撮影してください。")) }
            else {
              onRecording(mapOf("recording" to false, "finalizing" to true, "durationMs" to 0))
              // Independent executor survives view detachment while a completed recording is saved.
              val finalizeExecutor = Executors.newSingleThreadExecutor()
              finalizeExecutor.execute {
                var normalized: NormalizedVideo? = null
                try {
                  normalized = VideoNormalizer.normalize(context, source)
                  val handle = CaptureStore.createVideo(context, normalized, capturedAt, binding, location)
                  post { onCapture(mapOf("handle" to handle)) }
                } catch (_: Exception) { post { onError(mapOf("message" to "動画を保存できませんでした。保存枠を確認して、短く撮り直してください。")) } }
                finally { source.delete(); normalized?.file?.delete(); post { capturing = false; onRecording(mapOf("recording" to false, "finalizing" to false, "durationMs" to 0)) }; finalizeExecutor.shutdown() }
              }
            }
          }
        }
      }
    } catch (_: Exception) { capturing = false; source.delete(); onError(mapOf("message" to "動画撮影を開始できませんでした。")) }
  }
  fun shutter(value: Int) {
    if (value <= lastShutter) return
    lastShutter = value
    if (recording != null) { recording?.stop(); return }
    if (mode == "video") { startRecording(); return }
    if (capturing || !formats.contains(photoFormat)) return
    val binding = try { CaptureProof.binding(captureSession) } catch (_: Exception) { onError(mapOf("message" to "撮影の準備をやり直してください。")); return }
    val captureTime = Instant.now()
    val capturedAt = captureTime.toString()
    val location = locationTracker.snapshot(captureTime)
    val currentFormat = photoFormat
    capturing = true
    if (currentFormat == "heif") {
      val engine = heifCamera
      if(engine == null) { capturing = false; return }
      engine.capture(flashEnabled, display?.rotation ?: 0) { file ->
        try { val handle = CaptureStore.create(context, file, "image/heic", null, capturedAt, binding, location = location); post { onCapture(mapOf("handle" to handle)) } }
        catch (error: Exception) { post { onError(mapOf("message" to (error.message ?: "HEIF写真を保存できませんでした。"))) } }
        finally { file.delete(); post { capturing = false } }
      }
      return
    }
    val capture = imageCapture ?: run { capturing = false; return }
    val raw = currentFormat == "raw"
    val original = File.createTempFile("justtaken-camera-", if(raw) ".dng" else ".jpg", context.cacheDir)
    val companion = if(raw) File.createTempFile("justtaken-preview-", ".jpg", context.cacheDir) else null
    val saved = mutableSetOf<Int>(); var finished = false
    val callback = object : ImageCapture.OnImageSavedCallback {
      override fun onImageSaved(result: ImageCapture.OutputFileResults) {
        if(finished) { original.delete(); companion?.delete(); return }
        saved.add(result.imageFormat)
        if(raw && !(saved.contains(android.graphics.ImageFormat.RAW_SENSOR) && saved.contains(android.graphics.ImageFormat.JPEG))) return
        finished = true
        try {
          val handle = CaptureStore.create(context, original, if(raw) "image/x-adobe-dng" else "image/jpeg", companion, capturedAt, binding, currentFormat == "hdr", location)
          post { onCapture(mapOf("handle" to handle)) }
        } catch(error: Exception) { post { onError(mapOf("message" to (error.message ?: "写真を保存できませんでした。"))) } }
        finally { original.delete(); companion?.delete(); post { capturing = false } }
      }
      override fun onError(exception: ImageCaptureException) { if(finished) return; finished = true; original.delete(); companion?.delete(); post { capturing = false; onError(mapOf("message" to "撮影できませんでした。もう一度お試しください。")) } }
    }
    try {
      capture.flashMode = if (flashEnabled) ImageCapture.FLASH_MODE_ON else ImageCapture.FLASH_MODE_OFF
      capture.targetRotation = display?.rotation ?: 0
      val options = ImageCapture.OutputFileOptions.Builder(original).build()
      if(raw) capture.takePicture(options, ImageCapture.OutputFileOptions.Builder(companion!!).build(), executor, callback)
      else capture.takePicture(options, executor, callback)
    } catch (_: Exception) { original.delete(); companion?.delete(); capturing=false; onError(mapOf("message" to "選択した形式で撮影を開始できませんでした。")) }
  }
}
