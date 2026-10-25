import AVFoundation
import Foundation

struct NormalizedVideo {
  let url: URL
  let width: Int
  let height: Int
  let durationMs: Int
  let hasAudio: Bool
  let codec: String
  let bitDepth: Int
  let colorTransfer: String
  let rotation: Int
  let fpsNumerator: Int
}
// Internal camera URL only. Passthrough remux keeps every encoded video/audio sample.
// Private container metadata is removed before the immutable capture hash is calculated.
enum VideoNormalizer {
  private static func invalid(_ step: Int) -> NSError { NSError(domain: "JustTakenCapture.Video", code: step, userInfo: [NSLocalizedDescriptionKey: "動画の形式を確認できませんでした（\(step)）。"]) }
  static func normalize(_ source: URL, destination: URL) async throws -> NormalizedVideo {
    let asset = AVURLAsset(url: source)
    let videos = try await asset.loadTracks(withMediaType: .video), audios = try await asset.loadTracks(withMediaType: .audio)
    guard videos.count == 1, audios.count <= 1, let track = videos.first,
      let format = try await track.load(.formatDescriptions).first else { throw invalid(1) }
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    let width = Int(dimensions.width), height = Int(dimensions.height)
    let sourceDuration = try await asset.load(.duration)
    guard sourceDuration.seconds > 0, sourceDuration.seconds <= 60,
      max(width,height) <= 4096, min(width,height) <= 2160 else { throw invalid(2) }
    let subtype = CMFormatDescriptionGetMediaSubType(format)
    guard [kCMVideoCodecType_H264, kCMVideoCodecType_HEVC].contains(subtype) else { throw invalid(3) }
    let codec = subtype == kCMVideoCodecType_HEVC ? "hevc" : "h264"
    let extensions = (CMFormatDescriptionGetExtensions(format) as NSDictionary?) ?? NSDictionary()
    var bitDepth = 8
    if codec == "hevc" {
      guard let atoms = extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms] as? NSDictionary,
        let config = atoms["hvcC"] as? Data, config.count >= 23 else { throw invalid(4) }
      bitDepth = 8 + Int(config[17] & 7)
    }
    let transfer = extensions[kCMFormatDescriptionExtension_TransferFunction] as? String ?? ""
    let colorTransfer = transfer == kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String ? "hlg" : transfer == kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String ? "pq" : "sdr"
    guard [8,10].contains(bitDepth), colorTransfer == "sdr" || bitDepth == 10 else { throw invalid(5) }
    let transform = try await track.load(.preferredTransform)
    let angle = Int((atan2(transform.b, transform.a) * 180 / .pi).rounded())
    let rotation = (angle + 360) % 360
    let fps = try await track.load(.nominalFrameRate)
    guard [0,90,180,270].contains(rotation), fps > 0, fps <= 60.1 else { throw invalid(6) }
    for audio in audios {
      guard let description = try await audio.load(.formatDescriptions).first,
        CMFormatDescriptionGetMediaSubType(description) == kAudioFormatMPEG4AAC else { throw invalid(7) }
    }
    guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else { throw invalid(8) }
    export.metadata = []; export.metadataItemFilter = AVMetadataItemFilter.forSharing(); export.shouldOptimizeForNetworkUse = true
    try await export.export(to: destination, as: .mp4)
    let final = AVURLAsset(url: destination), ms = Int((try await final.load(.duration)).seconds * 1000 + 0.5)
    let bytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard ms > 0, ms <= 60_000, bytes > 0, bytes <= 536_870_912 else {
      throw NSError(domain: "JustTakenCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "動画は60秒・512 MiBまでです。原画を保持するため圧縮は行いません。"])
    }
    return NormalizedVideo(url: destination, width: width, height: height, durationMs: ms, hasAudio: !audios.isEmpty, codec: codec, bitDepth: bitDepth, colorTransfer: colorTransfer, rotation: rotation, fpsNumerator: min(60000, Int((fps * 1000).rounded())))
  }
}
