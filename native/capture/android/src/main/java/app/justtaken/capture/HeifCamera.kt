package app.justtaken.capture

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import android.view.Surface
import android.view.TextureView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import java.io.File

// CameraX has no HEIF output. This camera2 session requests the advertised HEIC
// hardware output directly; JPEG-to-HEIF conversion is intentionally absent.
internal class HeifCamera(
  private val context: Context, private val texture: TextureView, private val front: Boolean,
  private val owner: LifecycleOwner, private val ready: (Boolean) -> Unit, private val error: (String) -> Unit
) : TextureView.SurfaceTextureListener {
  companion object {
    private const val HEIC = 0x48454946 // ImageFormat.HEIC (API 29); minSdk is 31.
    private fun candidate(context: Context, front: Boolean): Pair<String, Size>? {
      val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      return manager.cameraIdList.mapNotNull { id ->
        val c = manager.getCameraCharacteristics(id)
        if(c.get(CameraCharacteristics.LENS_FACING) != if(front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK) return@mapNotNull null
        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return@mapNotNull null
        val sizes = map.getOutputSizes(HEIC).orEmpty()
        val size = sizes.filter { maxOf(it.width,it.height)<=16384 && it.width.toLong()*it.height<=200_000_000 }.maxByOrNull { it.width.toLong()*it.height } ?: return@mapNotNull null
        id to size
      }.firstOrNull()
    }
    fun available(context: Context, front: Boolean) = runCatching { candidate(context, front) != null }.getOrDefault(false)
  }
  private val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
  private val worker = HandlerThread("JustTakenHEIF").apply { start() }
  private val handler = Handler(worker.looper)
  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var reader: ImageReader? = null
  private var surface: Surface? = null
  private var preview: CaptureRequest.Builder? = null
  private var characteristics: CameraCharacteristics? = null
  private var opening = false
  @Volatile private var closed = false
  private var generation = 0
  private var pending: ((File) -> Unit)? = null
  private var shotRequested = false
  private var torch = false
  private var pendingRotation = 0
  private val observer = LifecycleEventObserver { _, event ->
    if(event == Lifecycle.Event.ON_STOP) handler.post { stopCamera() }
    if(event == Lifecycle.Event.ON_START) open()
  }
  init { texture.surfaceTextureListener = this; owner.lifecycle.addObserver(observer) }
  fun open() {
    if(closed || !texture.isAvailable || !owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
    handler.post {
      if(closed || opening || device != null) return@post
      try {
        val (id,size) = requireNotNull(candidate(context,front))
        val c=manager.getCameraCharacteristics(id); characteristics=c
        val map=requireNotNull(c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP))
        val previewSize=map.getOutputSizes(SurfaceTexture::class.java).filter { maxOf(it.width,it.height)<=1920 }.minByOrNull { kotlin.math.abs(it.width.toDouble()/it.height - size.width.toDouble()/size.height) + 1.0/it.width } ?: Size(1280,720)
        val st=requireNotNull(texture.surfaceTexture);st.setDefaultBufferSize(previewSize.width,previewSize.height)
        surface=Surface(st)
        reader=ImageReader.newInstance(size.width,size.height,HEIC,2).also { images ->
          images.setOnImageAvailableListener({ source ->
            if(source !== reader) return@setOnImageAvailableListener
            val image=runCatching { source.acquireNextImage() }.getOrNull() ?: return@setOnImageAvailableListener
            val callback=pending
            if(callback==null) { image.close();return@setOnImageAvailableListener }
            pending=null;shotRequested=false;handler.removeCallbacks(timeout)
            var file: File?=null
            try {
              file=File.createTempFile("justtaken-heif-", ".heic",context.cacheDir)
              val buffer=image.planes[0].buffer;check(buffer.remaining() in 1..134_217_728)
              file.outputStream().channel.use { out -> while(buffer.hasRemaining())out.write(buffer) }
              image.close();callback(file)
            } catch (_: Exception) { image.close();file?.delete();error("HEIF写真を保存できませんでした。") }
          },handler)
        }
        val epoch=++generation;opening=true
        manager.openCamera(id,object: CameraDevice.StateCallback(){
          override fun onOpened(camera: CameraDevice) {
            opening=false;if(closed||epoch!=generation){camera.close();return};device=camera
            try { camera.createCaptureSession(listOf(surface!!,reader!!.surface),object:CameraCaptureSession.StateCallback(){
              override fun onConfigured(configured:CameraCaptureSession){
                if(closed||epoch!=generation){configured.close();return};session=configured
                try {
                  preview=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(surface!!);set(CaptureRequest.CONTROL_AF_MODE,focusMode());set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON);set(CaptureRequest.FLASH_MODE,flashMode()) }
                  configured.setRepeatingRequest(preview!!.build(),captureCallback,handler)
                  texture.post { transform(previewSize,c.get(CameraCharacteristics.SENSOR_ORIENTATION)?:0) };ready(true)
                }catch(_:Exception){error("HEIFプレビューを開始できませんでした。");stopCamera()}
              }
              override fun onConfigureFailed(configured:CameraCaptureSession){error("この端末のHEIF撮影を準備できませんでした。");stopCamera()}
            },handler) }catch(_:Exception){error("HEIFカメラを開けませんでした。");stopCamera()}
          }
          override fun onDisconnected(camera:CameraDevice){camera.close();if(epoch==generation){error("カメラとの接続が中断されました。");stopCamera()}}
          override fun onError(camera:CameraDevice,code:Int){camera.close();if(epoch==generation){error("HEIFカメラを利用できません。");stopCamera()}}
        },handler)
      }catch(_:Exception){opening=false;error("HEIF撮影を準備できませんでした。");stopCamera()}
    }
  }
  private fun transform(size:Size,sensor:Int){
    if(texture.width==0||texture.height==0)return
    val degrees=(sensor-(texture.display?.rotation?:0)*90+360)%360
    val matrix=Matrix();val w=texture.width.toFloat();val h=texture.height.toFloat()
    if(degrees==90||degrees==270){val scale=maxOf(w/size.height,h/size.width);matrix.setScale(size.width*scale/w,size.height*scale/h,w/2,h/2);matrix.postRotate(degrees.toFloat(),w/2,h/2)}
    if(front)matrix.postScale(-1f,1f,w/2,h/2)
    texture.setTransform(matrix)
  }
  private fun focusMode(): Int {
    val modes=characteristics?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
    return when { modes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) -> CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE; modes.contains(CaptureRequest.CONTROL_AF_MODE_AUTO) -> CaptureRequest.CONTROL_AF_MODE_AUTO; else -> CaptureRequest.CONTROL_AF_MODE_OFF }
  }
  // A timed-out reader is never reused: late frames must not bind to a new nonce.
  private val timeout=Runnable { if(pending!=null){pending=null;error("HEIF撮影がタイムアウトしました。撮り直してください。");stopCamera();open()} }
  private val captureCallback=object:CameraCaptureSession.CaptureCallback(){
    override fun onCaptureCompleted(session:CameraCaptureSession,request:CaptureRequest,result:TotalCaptureResult){
      if(pending==null||shotRequested)return
      val af=result.get(CaptureResult.CONTROL_AF_STATE);val ae=result.get(CaptureResult.CONTROL_AE_STATE)
      if((focusMode()==CaptureRequest.CONTROL_AF_MODE_OFF||af==null||af==CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED||af==CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED||af==CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED) && (ae==null||ae==CaptureResult.CONTROL_AE_STATE_CONVERGED||ae==CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED)) takeStill()
    }
  }
  // Every request carries the torch state; a request without it would switch the light off.
  private fun flashMode()=if(torch&&characteristics?.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)==true)CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF
  fun setTorch(on:Boolean){
    handler.post {
      torch=on
      val request=preview?:return@post
      try { request.set(CaptureRequest.FLASH_MODE,flashMode());session?.setRepeatingRequest(request.build(),captureCallback,handler) }catch(_:Exception){}
    }
  }
  fun capture(rotation:Int,callback:(File)->Unit){
    handler.post {
      if(closed||device==null||session==null||pending!=null){error("HEIFカメラの準備を待ってください。");return@post}
      pending=callback;pendingRotation=rotation;shotRequested=false
      handler.postDelayed(timeout,15000)
      try {
        val request=preview!!
        request.set(CaptureRequest.CONTROL_AF_TRIGGER,if(focusMode()==CaptureRequest.CONTROL_AF_MODE_OFF)CaptureRequest.CONTROL_AF_TRIGGER_IDLE else CaptureRequest.CONTROL_AF_TRIGGER_START)
        request.set(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER,CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER_START)
        session!!.capture(request.build(),captureCallback,handler)
        request.set(CaptureRequest.CONTROL_AF_TRIGGER,CaptureRequest.CONTROL_AF_TRIGGER_IDLE)
        request.set(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER,CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER_IDLE)
        handler.postDelayed({if(pending!=null&&!shotRequested)takeStill()},2000)
      }catch(_:Exception){pending=null;handler.removeCallbacks(timeout);error("HEIF撮影を開始できませんでした。")}
    }
  }
  private fun takeStill(){
    if(pending==null||shotRequested)return
    shotRequested=true
    try {
      val c=requireNotNull(characteristics);val sensor=c.get(CameraCharacteristics.SENSOR_ORIENTATION)?:0
      val orientation=(sensor+(if(front)1 else -1)*pendingRotation*90+360)%360
      val request=requireNotNull(device).createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
        addTarget(reader!!.surface);set(CaptureRequest.JPEG_ORIENTATION,orientation);set(CaptureRequest.JPEG_QUALITY,100.toByte())
        set(CaptureRequest.CONTROL_AF_MODE,focusMode())
        set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON);set(CaptureRequest.FLASH_MODE,flashMode())
      }
      session!!.capture(request.build(),object:CameraCaptureSession.CaptureCallback(){
        override fun onCaptureFailed(session:CameraCaptureSession,request:CaptureRequest,failure:CaptureFailure){pending=null;handler.removeCallbacks(timeout);error("HEIF写真を撮影できませんでした。");stopCamera();open()}
        override fun onCaptureCompleted(session:CameraCaptureSession,request:CaptureRequest,result:TotalCaptureResult){
          try { preview?.set(CaptureRequest.CONTROL_AF_TRIGGER,CaptureRequest.CONTROL_AF_TRIGGER_CANCEL);session.capture(preview!!.build(),null,handler);preview?.set(CaptureRequest.CONTROL_AF_TRIGGER,CaptureRequest.CONTROL_AF_TRIGGER_IDLE) }catch(_:Exception){}
        }
      },handler)
    }catch(_:Exception){pending=null;handler.removeCallbacks(timeout);error("HEIF写真を撮影できませんでした。");stopCamera();open()}
  }
  private fun stopCamera(){
    generation++;opening=false;ready(false)
    if(pending!=null)error("撮影が中断されました。もう一度撮影してください。")
    pending=null;shotRequested=false;handler.removeCallbacksAndMessages(null)
    session?.close();session=null;device?.close();device=null;reader?.close();reader=null;surface?.release();surface=null
  }
  fun close(){closed=true;owner.lifecycle.removeObserver(observer);texture.surfaceTextureListener=null;handler.post {stopCamera();worker.quitSafely()}}
  override fun onSurfaceTextureAvailable(surface:SurfaceTexture,width:Int,height:Int){open()}
  override fun onSurfaceTextureSizeChanged(surface:SurfaceTexture,width:Int,height:Int){}
  override fun onSurfaceTextureUpdated(surface:SurfaceTexture){}
  override fun onSurfaceTextureDestroyed(surface:SurfaceTexture):Boolean{handler.post {stopCamera()};return true}
}
