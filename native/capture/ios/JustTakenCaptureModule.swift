import ExpoModulesCore
import AVFoundation

public class JustTakenCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JustTakenCapture")
    Constant("supportsPhotoCapture") {
      #if targetEnvironment(simulator)
      return false
      #else
      return true
      #endif
    }
    AsyncFunction("requestPermission") { () async -> Bool in
      #if targetEnvironment(simulator)
      return false
      #else
      return await AVCaptureDevice.requestAccess(for: .video)
      #endif
    }
    AsyncFunction("setHDRDisplay") { (_ enabled: Bool) in /* expo-image manages EDR per UIImageView. */ }
    AsyncFunction("requestMicrophonePermission") { () async -> Bool in await AVCaptureDevice.requestAccess(for: .audio) }
    AsyncFunction("getLocationPermission") { () -> Bool in CaptureLocationPermission.shared.granted }.runOnQueue(.main)
    AsyncFunction("requestLocationPermission") { (promise: Promise) in
      CaptureLocationPermission.shared.request { granted in promise.resolve(granted) }
    }.runOnQueue(.main)
    AsyncFunction("finalize") { (handle: String) -> [String: Any] in
      return try CaptureStore.shared.read(handle)
    }
    AsyncFunction("enroll") { (installationId: String, challenge: String) async throws -> [String: String] in try await CaptureProof.shared.enroll(installationId, challenge: challenge) }
    AsyncFunction("prepareProof") { (handle: String) async throws -> [String: Any] in try await CaptureProof.shared.prepare(handle) }
    AsyncFunction("upload") { (handle: String, assetId: String, accessToken: String) async throws in try await CaptureStore.shared.upload(handle, assetId: assetId, accessToken: accessToken) }
    AsyncFunction("discard") { (handle: String) in try CaptureStore.shared.discard(handle) }
    AsyncFunction("listDrafts") { () -> [[String: Any]] in try CaptureStore.shared.list() }
    View(JustTakenCaptureView.self) {
      Events("onCapture", "onReady", "onError", "onRecording")
      Prop("captureSession") { (view: JustTakenCaptureView, value: String) in view.captureSession = value }
      Prop("facing") { (view: JustTakenCaptureView, value: String) in view.setFacing(value) }
      Prop("flash") { (view: JustTakenCaptureView, value: Bool) in view.flashEnabled = value }
      Prop("photoFormat") { (view: JustTakenCaptureView, value: String) in view.setPhotoFormat(value) }
      Prop("mode") { (view: JustTakenCaptureView, value: String) in view.setMode(value) }
      Prop("locationEnabled") { (view: JustTakenCaptureView, value: Bool) in view.setLocationEnabled(value) }
      Prop("audioEnabled") { (view: JustTakenCaptureView, value: Bool) in view.setAudio(value) }
      Prop("shutter") { (view: JustTakenCaptureView, value: Int) in view.shutter(value) }
    }
  }
}
