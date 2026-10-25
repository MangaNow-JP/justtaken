package app.justtaken.capture

import android.Manifest
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues

class JustTakenCaptureModule : Module() {
  private var previousColorMode: Int? = null
  override fun definition() = ModuleDefinition {
    Name("JustTakenCapture")
    Constant("supportsPhotoCapture") { true }
    AsyncFunction("requestPermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (permissions == null) promise.resolve(false)
      else permissions.askForPermissions({ _ -> promise.resolve(permissions.hasGrantedPermissions(Manifest.permission.CAMERA)) }, Manifest.permission.CAMERA)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setHDRDisplay") { enabled: Boolean ->
      appContext.currentActivity?.window?.let { window ->
        if(enabled) { if(previousColorMode == null) previousColorMode = window.colorMode; window.colorMode = android.content.pm.ActivityInfo.COLOR_MODE_HDR }
        else { previousColorMode?.let { window.colorMode = it }; previousColorMode = null }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestMicrophonePermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (permissions == null) promise.resolve(false)
      else permissions.askForPermissions({ _ -> promise.resolve(permissions.hasGrantedPermissions(Manifest.permission.RECORD_AUDIO)) }, Manifest.permission.RECORD_AUDIO)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getLocationPermission") { CaptureLocationPermission.granted(requireNotNull(appContext.reactContext)) }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestLocationPermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (permissions == null) promise.resolve(false)
      else permissions.askForPermissions({ _ -> promise.resolve(CaptureLocationPermission.granted(requireNotNull(appContext.reactContext))) }, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("finalize") { handle: String -> CaptureStore.read(requireNotNull(appContext.reactContext), handle) }
    AsyncFunction("enroll") { installationId: String, challenge: String -> CaptureProof.enroll(requireNotNull(appContext.reactContext), installationId, challenge) }
    AsyncFunction("prepareProof") { handle: String -> CaptureProof.prepare(requireNotNull(appContext.reactContext), handle) }
    AsyncFunction("upload") { handle: String, assetId: String, accessToken: String -> CaptureStore.upload(requireNotNull(appContext.reactContext), handle, assetId, accessToken) }
    AsyncFunction("discard") { handle: String -> CaptureStore.discard(requireNotNull(appContext.reactContext), handle) }
    AsyncFunction("listDrafts") { CaptureStore.list(requireNotNull(appContext.reactContext)) }
    View(JustTakenCaptureView::class) {
      Events("onCapture", "onReady", "onError", "onRecording")
      Prop("captureSession") { view: JustTakenCaptureView, value: String -> view.captureSession = value }
      Prop("facing") { view: JustTakenCaptureView, value: String -> view.setFacing(value) }
      Prop("flash") { view: JustTakenCaptureView, value: Boolean -> view.flashEnabled = value }
      Prop("photoFormat") { view: JustTakenCaptureView, value: String -> view.setPhotoFormat(value) }
      Prop("mode") { view: JustTakenCaptureView, value: String -> view.setMode(value) }
      Prop("locationEnabled") { view: JustTakenCaptureView, value: Boolean -> view.setLocationEnabled(value) }
      Prop("audioEnabled") { view: JustTakenCaptureView, value: Boolean -> view.audioEnabled = value }
      Prop("shutter") { view: JustTakenCaptureView, value: Int -> view.shutter(value) }
    }
  }
}
