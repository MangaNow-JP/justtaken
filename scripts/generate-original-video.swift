import AVFoundation
import Foundation
import CryptoKit
import VideoToolbox
// Test executable only. Production uses the error type in CaptureProof.swift.
enum CaptureProofError: Error { case invalid }
@main struct GenerateVideoFixture {
  static func encodedHashes(_ url: URL) async throws -> [String] {
    let asset = AVURLAsset(url: url); var result: [String] = []
    for type in [AVMediaType.video, .audio] {
      for track in try await asset.loadTracks(withMediaType: type) {
        let reader = try AVAssetReader(asset: asset), output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output); guard reader.startReading() else { throw reader.error! }; var hash = SHA256(); var samples = 0
        while let sample = output.copyNextSampleBuffer() {
          if CMSampleBufferGetNumSamples(sample) == 0 { continue }
          guard let buffer = CMSampleBufferGetDataBuffer(sample) else { throw NSError(domain: "SampleHash.NoData", code: 1) }
          let size = CMBlockBufferGetDataLength(buffer); var bytes = [UInt8](repeating: 0, count: size)
          let status = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(buffer, atOffset: 0, dataLength: size, destination: $0.baseAddress!) }
          guard status == 0 else { throw NSError(domain: "SampleHash.Copy", code: Int(status)) }
          hash.update(data: Data(bytes)); samples += CMSampleBufferGetNumSamples(sample)
        }
        guard reader.status == .completed else { throw reader.error! }
        result.append(type.rawValue + ":" + String(samples) + ":" + hash.finalize().map { String(format:"%02x",$0) }.joined())
      }
    }; return result
  }
  static func main() async throws {
    setbuf(stdout, nil)
    let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    for (name, seconds, audio) in [("original-silent", 2, false), ("original-audio", 2, true), ("original-hevc", 1, false), ("original-hdr", 1, false), ("original-limit", 59, true), ("over-limit", 61, false)] {
      let hevc = name.contains("hevc") || name.contains("hdr"), hdr = name.contains("hdr")
      let width = hevc ? 3840 : 96, height = hevc ? 2160 : 64
      print("Generating " + name)
      let raw = temporary.appendingPathComponent(name + ".mov")
      let writer = try AVAssetWriter(outputURL: raw, fileType: .mov)
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : .h264, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: hdr ? AVVideoColorPrimaries_ITU_R_2020 : AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: hdr ? AVVideoTransferFunction_ITU_R_2100_HLG : AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: hdr ? AVVideoYCbCrMatrix_ITU_R_2020 : AVVideoYCbCrMatrix_ITU_R_709_2], AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: hevc ? 12_000_000 : 200_000, AVVideoAllowFrameReorderingKey: false, AVVideoProfileLevelKey: hevc ? (hdr ? kVTProfileLevel_HEVC_Main10_AutoLevel as String : kVTProfileLevel_HEVC_Main_AutoLevel as String) : AVVideoProfileLevelH264HighAutoLevel]])
      input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: CGFloat(height), ty: 0)
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: hdr ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
      writer.add(input); guard writer.startWriting() else { throw writer.error! }; writer.startSession(atSourceTime: .zero)
      for frame in 0..<(seconds * 30) {
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
        var optional: CVPixelBuffer?; CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &optional)
        let pixel = optional!; CVPixelBufferLockBaseAddress(pixel, [])
        if hdr {
          for plane in 0..<2 {
            let rowBytes=CVPixelBufferGetBytesPerRowOfPlane(pixel,plane), rows=CVPixelBufferGetHeightOfPlane(pixel,plane)
            let data=CVPixelBufferGetBaseAddressOfPlane(pixel,plane)!.assumingMemoryBound(to:UInt16.self)
            for y in 0..<rows { for x in 0..<(rowBytes/2) { data[y*rowBytes/2+x]=UInt16(plane==0 ? (64 + (x+frame)%876) : 512)<<6 } }
          }
        } else {
        let bytes = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(pixel)
        for y in 0..<height { for x in 0..<width { let p = y * stride + x * 4; bytes[p] = UInt8((x * 2 + frame) % 256); bytes[p+1] = UInt8((y * 3) % 256); bytes[p+2] = 90; bytes[p+3] = 255 } }
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { throw writer.error! }
      }
      writer.endSession(atSourceTime: CMTime(value: Int64(seconds), timescale: 1)); input.markAsFinished(); await writer.finishWriting()
      guard writer.status == .completed else { throw writer.error! }
      var source = raw
      if audio {
        let audioURL = temporary.appendingPathComponent(name + ".m4a"), format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * 44100))!; buffer.frameLength = buffer.frameCapacity
        for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][i] = Float(sin(Double(i) * 2 * Double.pi * 440 / 44100) * 0.15) }
        do { let file = try AVAudioFile(forWriting: audioURL, settings: [AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:44100,AVNumberOfChannelsKey:1,AVEncoderBitRateKey:128000]); try file.write(from: buffer) }
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
      if seconds > 60 {
        do { _ = try await VideoNormalizer.normalize(source, destination: destination); fatalError("Over-limit video accepted") } catch { print("PASS: 61 seconds rejected without trimming") }; continue
      }
      let inspect = AVURLAsset(url: source)
      let vt = try await inspect.loadTracks(withMediaType: .video)[0]
      print("Source duration", try await inspect.load(.duration).seconds, "fps", try await vt.load(.nominalFrameRate), "transform", try await vt.load(.preferredTransform))
      let before = try await encodedHashes(source)
      print("Read sample hashes", before)
      let result = try await VideoNormalizer.normalize(source, destination: destination)
      let after = try await encodedHashes(destination)
      precondition(before == after, "Encoded audio/video samples changed")
      print("PASS: encoded samples unchanged for " + name)
      let metadata: [String: Any] = ["id":"original", "role":"original", "mime":"video/mp4", "width":result.width, "height":result.height, "durationMs":result.durationMs, "videoCodec":result.codec, "videoBitDepth":result.bitDepth, "colorTransfer":result.colorTransfer, "rotationDegrees":result.rotation, "fpsNumerator":result.fpsNumerator, "fpsDenominator":1000, "bytes":try destination.resourceValues(forKeys:[.fileSizeKey]).fileSize!, "hasAudio":result.hasAudio]
      try JSONSerialization.data(withJSONObject: metadata, options:[.sortedKeys,.prettyPrinted]).write(to: folder.appendingPathComponent(name + ".json"))
      print("Generated \(name): \(result.width)x\(result.height), \(result.durationMs) ms, audio=\(result.hasAudio)")
    }
  }
}
