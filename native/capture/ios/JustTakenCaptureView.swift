import ExpoModulesCore
import AVFoundation
import UIKit

final class JustTakenCaptureView: ExpoView, AVCapturePhotoCaptureDelegate, AVCaptureFileOutputRecordingDelegate {
  let onCapture = EventDispatcher(), onReady = EventDispatcher(), onError = EventDispatcher(), onRecording = EventDispatcher()
  private let locationTracker = CaptureLocationTracker()
  private var captureLocation: [String: Any] = ["status": "off"]
  func setLocationEnabled(_ value: Bool) { locationTracker.setEnabled(value) }
  private let session = AVCaptureSession(), photo = AVCapturePhotoOutput(), movie = AVCaptureMovieFileOutput()
  private let queue = DispatchQueue(label: "app.justtaken.capture")
  private lazy var preview = AVCaptureVideoPreviewLayer(session: session)
  private var position: AVCaptureDevice.Position = .back
  private var mode = "photo", lastShutter = 0, capturing = false, audioEnabled = false
  private var capturedAt = Date(), captureBinding: CaptureBinding?, ticker: DispatchSourceTimer?
  private var photoFormat = "jpeg", capturePhotoFormat = "jpeg"
  private var rawPhoto: Data?, processedPhoto: Data?, photoFailure: Error?
  private func photoFormats() -> [String] {
    var values = ["jpeg"]
    if photo.availablePhotoCodecTypes.contains(.hevc) { values.append("heif") }
    if photo.availableRawPhotoPixelFormatTypes.contains(where: { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) { values.append("raw") }
    if photo.isAppleProRAWEnabled && photo.availableRawPhotoPixelFormatTypes.contains(where: { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }) { values.append("proraw") }
    return values
  }
  func setPhotoFormat(_ value: String) { guard photoFormat != value, !capturing else { return }; photoFormat = value; if window != nil { configure() } }
  // The switch is a continuous light in both modes: the torch stays on while previewing, through
  // photo captures and recordings. Photos never fire the flash on top of it.
  var flashEnabled = false { didSet { let enabled = flashEnabled; queue.async { [weak self] in self?.torchRequested = enabled; self?.applyTorch() } } }
  private var torchRequested = false
  var captureSession = ""
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext); preview.videoGravity = .resizeAspectFill; layer.addSublayer(preview)
    NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.didBecomeActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: .AVCaptureSessionWasInterrupted, object: session)
    NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
  }
  deinit { ticker?.cancel(); NotificationCenter.default.removeObserver(self); let session = session; queue.async { session.stopRunning() } }
  override func layoutSubviews() { super.layoutSubviews(); preview.frame = bounds }
  override func didMoveToWindow() { super.didMoveToWindow(); if window != nil { locationTracker.setActive(UIApplication.shared.applicationState == .active); configure() } else { background() } }
  @objc private func background() { locationTracker.setActive(false); queue.async { [weak self] in guard let self else { return }; if self.movie.isRecording { self.movie.stopRecording() }; self.session.stopRunning() } }
  @objc private func interrupted() { queue.async { [weak self] in if self?.movie.isRecording == true { self?.movie.stopRecording() } } }
  @objc private func foreground() { if window != nil { locationTracker.setActive(true); configure() } }
  func setFacing(_ facing: String) { let next: AVCaptureDevice.Position = facing == "front" ? .front : .back; guard position != next else { return }; position = next; if window != nil { configure() } }
  func setMode(_ value: String) { guard mode != value else { return }; mode = value == "video" ? "video" : "photo"; if window != nil { configure() } }
  func setAudio(_ value: Bool) { guard audioEnabled != value else { return }; audioEnabled = value; if window != nil && mode == "video" { configure() } }
  // Inputs also hold the microphone in video mode; never rely on their order.
  private var videoDevice: AVCaptureDevice? { session.inputs.compactMap { $0 as? AVCaptureDeviceInput }.first { $0.device.hasMediaType(.video) }?.device }
  // Call on `queue` after any change to the session or the switch.
  private func applyTorch() {
    guard let camera = videoDevice, camera.hasTorch else { return }
    let wanted: AVCaptureDevice.TorchMode = torchRequested && session.isRunning ? .on : .off
    guard camera.torchMode != wanted, camera.isTorchModeSupported(wanted) else { return }
    do { try camera.lockForConfiguration(); camera.torchMode = wanted; camera.unlockForConfiguration() } catch { /* Capture continues without the light. */ }
  }
  private func report(_ message: String) { DispatchQueue.main.async { [weak self] in self?.onError(["message": message]) } }
  private func state(recording: Bool, finalizing: Bool = false, milliseconds: Int = 0) { DispatchQueue.main.async { [weak self] in self?.onRecording(["recording": recording, "finalizing": finalizing, "durationMs": milliseconds]) } }
  private func configure() {
    let position = position, mode = mode, audio = audioEnabled
    queue.async { [weak self] in
      guard let self, !self.capturing else { return }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { self.report("カメラの使用を許可してください。"); return }
      DispatchQueue.main.async { [weak self] in self?.onReady(["ready": false]) }
      // A camera leaving the session must not keep its torch lit.
      if let camera = self.videoDevice, camera.hasTorch, camera.torchMode != .off { do { try camera.lockForConfiguration(); camera.torchMode = .off; camera.unlockForConfiguration() } catch {} }
      self.session.beginConfiguration(); self.session.inputs.forEach { self.session.removeInput($0) }; self.session.outputs.forEach { self.session.removeOutput($0) }
      self.session.sessionPreset = mode == "video" ? .high : .photo
      do {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else { throw CaptureProofError.invalid }
        let input = try AVCaptureDeviceInput(device: camera); guard self.session.canAddInput(input) else { throw CaptureProofError.invalid }; self.session.addInput(input)
        if mode == "video" {
          for preset in [AVCaptureSession.Preset.hd4K3840x2160, .hd1920x1080, .hd1280x720] { if self.session.canSetSessionPreset(preset) { self.session.sessionPreset = preset; break } }
          try camera.lockForConfiguration()
          if camera.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }) { camera.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30); camera.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30) }
          if camera.activeFormat.isVideoHDRSupported { camera.automaticallyAdjustsVideoHDREnabled = true }
          camera.unlockForConfiguration()
          if audio {
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized, let microphone = AVCaptureDevice.default(for: .audio) else { throw CaptureProofError.invalid }
            let mic = try AVCaptureDeviceInput(device: microphone); guard self.session.canAddInput(mic) else { throw CaptureProofError.invalid }; self.session.addInput(mic)
          }
          guard self.session.canAddOutput(self.movie) else { throw CaptureProofError.invalid }; self.session.addOutput(self.movie)
          self.movie.maxRecordedDuration = CMTime(value: 598, timescale: 10); self.movie.maxRecordedFileSize = 536_870_912
          if let connection = self.movie.connection(with: .video), self.movie.availableVideoCodecTypes.contains(.h264) { self.movie.setOutputSettings([AVVideoCodecKey: self.movie.availableVideoCodecTypes.contains(.hevc) ? AVVideoCodecType.hevc : .h264], for: connection) }
        } else { guard self.session.canAddOutput(self.photo) else { throw CaptureProofError.invalid }; self.session.addOutput(self.photo)
          self.photo.maxPhotoQualityPrioritization = .quality
          if self.photo.isAppleProRAWSupported { self.photo.isAppleProRAWEnabled = true }
          if let maximum = camera.activeFormat.supportedMaxPhotoDimensions.max(by: { Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height) }) { self.photo.maxPhotoDimensions = maximum }
        }
        self.session.commitConfiguration(); self.session.startRunning(); self.applyTorch()
        let formats = self.photoFormats(), supported = mode == "video" || formats.contains(self.photoFormat)
        DispatchQueue.main.async { [weak self] in self?.onReady(["ready": supported, "photoFormats": formats]) }
        if !supported { self.report("このカメラは選択した形式に対応していません。別の形式を選んでください。") }
      } catch { self.session.commitConfiguration(); self.report("カメラ・マイクを準備できませんでした。権限を確認し、もう一度お試しください。") }
    }
  }
  func shutter(_ value: Int) {
    guard value > lastShutter else { return }; lastShutter = value
    let captureTime = Date()
    let location = locationTracker.snapshot(at: captureTime)
    let rawBinding = captureSession, mode = mode, requestedFormat = photoFormat
    queue.async { [weak self] in
      guard let self else { return }
      if self.movie.isRecording { self.movie.stopRecording(); return }
      guard self.session.isRunning, !self.capturing else { return }
      do { self.captureBinding = try CaptureBinding(rawBinding) } catch { self.report(error.localizedDescription); return }
      self.capturing = true; self.capturedAt = captureTime; self.captureLocation = location
      if mode == "video" {
        self.applyTorch()
        if let connection = self.movie.connection(with: .video) { if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }; if connection.isVideoMirroringSupported { connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = false } }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("justtaken-" + UUID().uuidString + ".mov")
        self.movie.startRecording(to: file, recordingDelegate: self)
      } else {
        guard self.photoFormats().contains(requestedFormat) else { self.capturing = false; self.report("このカメラでは選択した形式を撮影できません。"); return }
        self.capturePhotoFormat = requestedFormat; self.rawPhoto = nil; self.processedPhoto = nil; self.photoFailure = nil
        let settings: AVCapturePhotoSettings
        if requestedFormat == "raw" || requestedFormat == "proraw" {
          guard let raw = self.photo.availableRawPhotoPixelFormatTypes.first(where: { requestedFormat == "proraw" ? AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) : AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) else { self.capturing = false; self.report("RAW撮影を開始できませんでした。"); return }
          settings = AVCapturePhotoSettings(rawPixelFormatType: raw, processedFormat: [AVVideoCodecKey: AVVideoCodecType.jpeg])
          settings.photoQualityPrioritization = requestedFormat == "raw" ? .speed : .quality
        } else {
          settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: requestedFormat == "heif" ? AVVideoCodecType.hevc : AVVideoCodecType.jpeg])
          settings.photoQualityPrioritization = .quality
        }
        settings.maxPhotoDimensions = self.photo.maxPhotoDimensions
        if let connection = self.photo.connection(with: .video), connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        self.photo.capturePhoto(with: settings, delegate: self)
      }
    }
  }
  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    let data = photo.fileDataRepresentation(), isRaw = photo.isRawPhoto
    queue.async { [weak self] in
      guard let self else { return }
      if let error { self.photoFailure = error }
      if isRaw { self.rawPhoto = data } else { self.processedPhoto = data }
    }
  }
  // RAW + processed captures deliver two processing callbacks. Issue exactly one draft,
  // only after AVFoundation reports that the entire exposure has completed.
  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    queue.async { [weak self] in
      guard let self else { return }
      defer { self.capturing = false; self.rawPhoto = nil; self.processedPhoto = nil; self.captureBinding = nil }
      let isRaw = self.capturePhotoFormat == "raw" || self.capturePhotoFormat == "proraw"
      guard error == nil, self.photoFailure == nil, let data = isRaw ? self.rawPhoto : self.processedPhoto, let binding = self.captureBinding, !isRaw || self.processedPhoto != nil else { self.report("撮影できませんでした。もう一度お試しください。"); return }
      let mime = isRaw ? "image/x-adobe-dng" : self.capturePhotoFormat == "heif" ? "image/heic" : "image/jpeg"
      do {
        let handle = try CaptureStore.shared.create(cameraData: data, mime: mime, previewData: isRaw ? self.processedPhoto : nil, capturedAt: self.capturedAt, binding: binding, location: self.captureLocation)
        DispatchQueue.main.async { [weak self] in self?.onCapture(["handle": handle]) }
      } catch { self.report(error.localizedDescription) }
    }
  }
  func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
    queue.async { [weak self] in
      guard let self else { return }; self.state(recording: true)
      let timer = DispatchSource.makeTimerSource(queue: self.queue); timer.schedule(deadline: .now(), repeating: .milliseconds(200)); timer.setEventHandler { [weak self] in guard let self else { return }; self.state(recording: true, milliseconds: max(0, Int(self.movie.recordedDuration.seconds * 1000))) }; self.ticker = timer; timer.resume()
    }
  }
  func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo fileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
    queue.async { [weak self] in
      guard let self else { return }; self.ticker?.cancel(); self.ticker = nil
      self.applyTorch()
      self.state(recording: false, finalizing: true)
      let successful = error == nil || (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
      guard successful, let binding = self.captureBinding else { try? FileManager.default.removeItem(at: fileURL); self.capturing = false; self.state(recording: false); self.report("動画の録画が中断されました。もう一度撮影してください。"); return }
      let capturedAt = self.capturedAt, location = self.captureLocation
      Task {
        let destination = fileURL.deletingPathExtension().appendingPathExtension("mp4")
        defer { try? FileManager.default.removeItem(at: fileURL); try? FileManager.default.removeItem(at: destination) }
        do {
          let video = try await VideoNormalizer.normalize(fileURL, destination: destination)
          let handle = try CaptureStore.shared.createVideo(video, capturedAt: capturedAt, binding: binding, location: location)
          DispatchQueue.main.async { [weak self] in self?.onCapture(["handle": handle]) }
        } catch { self.report("動画を保存できませんでした。保存枠を確認して、短く撮り直してください。") }
        self.queue.async { [weak self] in self?.capturing = false; self?.state(recording: false) }
      }
    }
  }
}
