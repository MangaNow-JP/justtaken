import AVFoundation
import Foundation
// Test executable only. Production uses the error type in CaptureProof.swift.
enum CaptureProofError: Error { case invalid }
@main struct GenerateVideoFixture {
  static func main() async throws {
    let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    for (name, seconds, audio) in [("silent", 2, false), ("audio", 2, true), ("limit", 61, true)] {
      let raw = temporary.appendingPathComponent(name + ".mov")
      let writer = try AVAssetWriter(outputURL: raw, fileType: .mov)
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 96, AVVideoHeightKey: 64, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 200_000, AVVideoAllowFrameReorderingKey: false]])
      input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 64, ty: 0)
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 96, kCVPixelBufferHeightKey as String: 64])
      writer.add(input); guard writer.startWriting() else { throw writer.error! }; writer.startSession(atSourceTime: .zero)
      for frame in 0..<(seconds * 30) {
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
        var optional: CVPixelBuffer?; CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &optional)
        let pixel = optional!; CVPixelBufferLockBaseAddress(pixel, [])
        let bytes = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(pixel)
        for y in 0..<64 { for x in 0..<96 { let p = y * stride + x * 4; bytes[p] = UInt8((x * 2 + frame) % 256); bytes[p+1] = UInt8(y * 3); bytes[p+2] = 90; bytes[p+3] = 255 } }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { throw writer.error! }
      }
      writer.endSession(atSourceTime: CMTime(value: Int64(seconds), timescale: 1)); input.markAsFinished(); await writer.finishWriting()
      guard writer.status == .completed else { throw writer.error! }
      var source = raw
      if audio {
        let audioURL = temporary.appendingPathComponent(name + ".caf"), format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * 44100))!; buffer.frameLength = buffer.frameCapacity
        for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][i] = Float(sin(Double(i) * 2 * Double.pi * 440 / 44100) * 0.15) }
        do { let file = try AVAudioFile(forWriting: audioURL, settings: format.settings); try file.write(from: buffer) }
        let composition = AVMutableComposition(), videoAsset = AVURLAsset(url: raw), audioAsset = AVURLAsset(url: audioURL)
        let videoTrack = try await videoAsset.loadTracks(withMediaType: .video)[0], audioTrack = try await audioAsset.loadTracks(withMediaType: .audio)[0]
        let range = CMTimeRange(start: .zero, duration: CMTime(value: Int64(seconds), timescale: 1))
        let v = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!, a = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        try v.insertTimeRange(range, of: videoTrack, at: .zero); v.preferredTransform = try await videoTrack.load(.preferredTransform)
        try a.insertTimeRange(range, of: audioTrack, at: .zero)
        source = temporary.appendingPathComponent(name + "-audio.mov")
        let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
        let location = AVMutableMetadataItem(); location.identifier = .quickTimeMetadataLocationISO6709; location.value = "+35.0000+139.0000/" as NSString; export.metadata = [location]
        try await export.export(to: source, as: .mov)
      }
      let destination = folder.appendingPathComponent(name + ".mp4"); try? FileManager.default.removeItem(at: destination)
      let result = try await VideoNormalizer.normalize(source, destination: destination)
      let metadata: [String: Any] = ["id":"original", "role":"original", "mime":"video/mp4", "width":result.width, "height":result.height, "durationMs":result.durationMs, "videoCodec":"h264", "fpsNumerator":30, "fpsDenominator":1, "bytes":try destination.resourceValues(forKeys:[.fileSizeKey]).fileSize!, "hasAudio":result.hasAudio]
      try JSONSerialization.data(withJSONObject: metadata, options:[.sortedKeys,.prettyPrinted]).write(to: folder.appendingPathComponent(name + ".json"))
      print("Generated \(name): \(result.width)x\(result.height), \(result.durationMs) ms, audio=\(result.hasAudio)")
    }
  }
}
