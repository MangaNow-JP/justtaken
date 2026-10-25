import UIKit
import AVFoundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

// Only the camera delegate calls create(). JS can only read or discard an issued UUID.
final class CaptureStore {
  static let shared = CaptureStore()
  private let lock = NSRecursiveLock()
  private let fm = FileManager.default
  private func root() throws -> URL {
    var url = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("JustTakenCaptures", isDirectory: true)
    try fm.createDirectory(at: url, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return url
  }
  private func directory(_ handle: String) throws -> URL {
    guard UUID(uuidString: handle) != nil else { throw failure("Invalid capture handle") }
    return try root().appendingPathComponent(handle, isDirectory: true)
  }
  private func failure(_ message: String) -> NSError { NSError(domain: "JustTakenCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  func create(cameraData: Data, mime: String, previewData: Data? = nil, capturedAt: Date, binding: CaptureBinding, location: [String: Any]) throws -> String {
    lock.lock(); defer { lock.unlock() }
    guard let source = CGImageSourceCreateWithData(cameraData as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
      max(width,height) <= 16384, width * height <= 200_000_000 else { throw failure("対応していない写真形式です。") }
    let detected = CGImageSourceGetType(source) as String? ?? ""
    guard (mime == "image/jpeg" && detected == UTType.jpeg.identifier) || (mime == "image/heic" && detected == UTType.heic.identifier) || (mime == "image/x-adobe-dng" && UTType(detected)?.conforms(to: .rawImage) == true) else { throw failure("撮影形式が一致しません。") }
    guard (properties[kCGImagePropertyGPSDictionary] as? [String: Any])?.isEmpty != false else { throw failure("位置情報を含む原本は投稿できません。") }
    let hasGainMap = CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeHDRGainMap) != nil || CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil
    let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
    // Keep the complete camera container, including EXIF, ICC, RAW calibration and gain maps.
    // Rebuilding EXIF/MPF or converting HEIF would change the authenticated original.
    let originalData = cameraData
    let limit = mime == "image/x-adobe-dng" ? 536_870_912 : 134_217_728
    guard originalData.count <= limit else { throw failure("写真が原本の容量上限を超えています。圧縮は行いません。") }
    let previewSource = previewData.flatMap { CGImageSourceCreateWithData($0 as CFData, nil) } ?? source
    guard let preview = CGImageSourceCreateThumbnailAtIndex(previewSource, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 480] as CFDictionary) else { throw failure("プレビューを作成できませんでした。") }
    let handle = UUID().uuidString
    let dir = try directory(handle)
    // Prototype local quota; the shared account quota will be enforced server-side.
    let existing = try list().reduce(0) { sum, draft in sum + ((draft["assets"] as? [[String: Any]]) ?? []).reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) } }
    guard existing + originalData.count + 65_536 <= 2_147_483_648 else { throw failure("保存枠がいっぱいです。下書きを削除してください。") }
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    do {
      let original = (data: originalData, width: width, height: height)
      let thumbnail = try encode(UIImage(cgImage: preview), edge: 480, limit: 65_536)
      var assets: [[String: Any]] = []
      for (role, output) in [("original", original), ("thumbnail", thumbnail)] {
        let url = dir.appendingPathComponent(role + (role == "original" ? try Self.fileExtension(mime) : ".jpg"))
        try output.data.write(to: url, options: [.atomic, .completeFileProtection])
        var asset: [String: Any] = ["id": role, "role": role, "mime": role == "original" ? mime : "image/jpeg", "bytes": output.data.count, "width": output.width, "height": output.height, "sha256": SHA256.hash(data: output.data).map { String(format: "%02x", $0) }.joined()]
        if role == "original" { asset["orientation"] = orientation; asset["preservation"] = "camera-original"; asset["hasGainMap"] = hasGainMap }
        assets.append(asset)
      }
      let metadata: [String: Any] = ["location": location, "session": binding.fields, "handle": handle, "capturedAt": ISO8601DateFormatter().string(from: capturedAt), "kind": "photo", "verification": "unverified", "policyVersion": "capture-v3", "assets": assets]
      try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]).write(to: dir.appendingPathComponent("draft.json"), options: [.atomic, .completeFileProtection])
      return handle
    } catch { try? fm.removeItem(at: dir); throw error }
  }
  func createVideo(_ video: NormalizedVideo, capturedAt: Date, binding: CaptureBinding, location: [String: Any]) throws -> String {
    lock.lock(); defer { lock.unlock() }
    let used = try list().reduce(0) { sum, draft in sum + ((draft["assets"] as? [[String: Any]]) ?? []).reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) } }
    guard used + (try video.url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) + 65_536 <= 2_147_483_648 else { throw failure("保存枠がいっぱいです。下書きを削除してください。") }
    let handle = UUID().uuidString, dir = try directory(handle)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    do {
      let file = dir.appendingPathComponent("original.mp4")
      try fm.copyItem(at: video.url, to: file)
      try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file)); generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 480, height: 480)
      let cg = try generator.copyCGImage(at: .zero, actualTime: nil)
      let poster = try encode(UIImage(cgImage: cg), edge: 480, limit: 65_536)
      try poster.data.write(to: dir.appendingPathComponent("poster.jpg"), options: [.atomic, .completeFileProtection])
      var original: [String: Any] = ["id": "original", "role": "original", "mime": "video/mp4", "bytes": try file.resourceValues(forKeys: [.fileSizeKey]).fileSize!, "width": video.width, "height": video.height, "durationMs": video.durationMs, "videoCodec": video.codec, "videoBitDepth": video.bitDepth, "colorTransfer": video.colorTransfer, "rotationDegrees": video.rotation, "fpsNumerator": video.fpsNumerator, "fpsDenominator": 1000, "sha256": try fileHash(file)]
      if video.hasAudio { original["audioCodec"] = "aac-lc" }
      let assets: [[String: Any]] = [original, ["id": "poster", "role": "poster", "mime": "image/jpeg", "bytes": poster.data.count, "width": poster.width, "height": poster.height, "sha256": SHA256.hash(data: poster.data).map { String(format: "%02x", $0) }.joined()]]
      let metadata: [String: Any] = ["location": location, "session": binding.fields, "handle": handle, "capturedAt": ISO8601DateFormatter().string(from: capturedAt), "kind": "video", "verification": "unverified", "policyVersion": "capture-v2", "assets": assets]
      try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]).write(to: dir.appendingPathComponent("draft.json"), options: [.atomic, .completeFileProtection])
      return handle
    } catch { try? fm.removeItem(at: dir); throw error }
  }
  static func fileExtension(_ mime: String) throws -> String {
    switch mime { case "image/jpeg": return ".jpg"; case "image/heic": return ".heic"; case "image/x-adobe-dng": return ".dng"; case "video/mp4": return ".mp4"; default: throw CaptureProofError.invalid }
  }
  private func fileHash(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
    var hash = SHA256()
    while let data = try file.read(upToCount: 65_536), !data.isEmpty { hash.update(data: data) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
  // Only previews are rendered/re-encoded. Originals never pass through this function.
  private func encode(_ source: UIImage, edge: CGFloat, limit: Int) throws -> (data: Data, width: Int, height: Int) {
    let ratio = min(1, edge / max(source.size.width, source.size.height))
    let size = CGSize(width: max(1, floor(source.size.width * ratio)), height: max(1, floor(source.size.height * ratio)))
    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true; format.preferredRange = .standard
    let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
    guard let cg = rendered.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB), let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw failure("Cannot normalize image") }
    context.draw(cg, in: CGRect(origin: .zero, size: size))
    guard let normalized = context.makeImage() else { throw failure("Cannot normalize image") }
    for quality in stride(from: 0.86, through: 0.26, by: -0.1) {
      let buffer = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil) else { throw failure("Cannot encode JPEG") }
      CGImageDestinationAddImage(destination, normalized, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw failure("Cannot finish JPEG") }
      let clean = try JPEGMetadata.strip(buffer as Data)
      if clean.count <= limit { return (clean, normalized.width, normalized.height) }
    }
    throw failure("写真を容量上限内に保存できませんでした。もう一度撮影してください。")
  }
  func read(_ handle: String) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    let dir = try directory(handle)
    let data = try Data(contentsOf: dir.appendingPathComponent("draft.json"))
    guard var metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("Invalid draft") }
    let isVideo = metadata["kind"] as? String == "video"
    metadata["previewUri"] = dir.appendingPathComponent(isVideo ? "poster.jpg" : "thumbnail.jpg").absoluteString
    metadata["mediaUri"] = dir.appendingPathComponent("original" + (try Self.fileExtension((metadata["assets"] as? [[String: Any]])?.first?["mime"] as? String ?? "image/jpeg"))).absoluteString
    return metadata
  }
  func manifest(_ handle: String) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    let metadata = try read(handle)
    guard let binding = metadata["session"] as? [String: Any], let assets = metadata["assets"] as? [[String: Any]] else { throw CaptureProofError.invalid }
    for asset in assets {
      guard let role = asset["id"] as? String, ["original", "thumbnail", "poster"].contains(role) else { throw CaptureProofError.invalid }
      let file = try directory(handle).appendingPathComponent(role + (try Self.fileExtension(asset["mime"] as? String ?? "")))
      guard try fileHash(file) == asset["sha256"] as? String, try file.resourceValues(forKeys: [.fileSizeKey]).fileSize == asset["bytes"] as? Int else { throw CaptureProofError.invalid }
    }
    var result: [String: Any] = ["version": 1, "policyVersion": metadata["policyVersion"] ?? "capture-v1", "sessionId": binding["sessionId"]!, "installationId": binding["installationId"]!, "accountBindingId": binding["accountBindingId"]!, "nonce": binding["nonce"]!, "clientCaptureId": handle, "clientCapturedAt": metadata["capturedAt"]!, "kind": metadata["kind"]!, "assets": assets]
    if let location = metadata["location"] { result["location"] = location }
    return result
  }
  func savedProof(_ handle: String) throws -> [String: Any]? {
    lock.lock(); defer { lock.unlock() }
    let url = try directory(handle).appendingPathComponent("proof.json")
    if !fm.fileExists(atPath: url.path) { return nil }
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
  }
  func saveProof(_ handle: String, result: [String: Any]) throws {
    lock.lock(); defer { lock.unlock() }
    try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes]).write(to: directory(handle).appendingPathComponent("proof.json"), options: [.atomic, .completeFileProtection])
  }
  func upload(_ handle: String, assetId: String, accessToken: String) async throws {
    guard ["original", "thumbnail", "poster"].contains(assetId), accessToken.range(of: "^[A-Za-z0-9_-]{36}\\.[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw CaptureProofError.invalid }
    guard let origin = Bundle.main.object(forInfoDictionaryKey: "JustTakenAPIOrigin") as? String, let base = URL(string: origin), base.scheme == "https", base.host != nil else { throw CaptureProofError.configuration }
    let metadata = try manifest(handle)
    guard let asset = (metadata["assets"] as? [[String: Any]])?.first(where: { $0["id"] as? String == assetId }), let mime = asset["mime"] as? String else { throw CaptureProofError.invalid }
    let installation = metadata["installationId"] as! String, session = metadata["sessionId"] as! String
    let url = base.appendingPathComponent("v1/installations/" + installation + "/captures/" + session + "/assets/" + assetId)
    let transport = URLSession(configuration: .ephemeral); defer { transport.finishTasksAndInvalidate() }
    func request(_ target: URL, method: String) -> URLRequest {
      var value = URLRequest(url: target); value.httpMethod = method; value.timeoutInterval = 180
      value.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization"); return value
    }
    func accepted(_ response: URLResponse) throws {
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw CaptureProofError.upload }
    }
    let fileURL = try directory(handle).appendingPathComponent(assetId + (try Self.fileExtension(mime)))
    let bytes = asset["bytes"] as! Int
    if bytes <= 8_388_608 {
      var put = request(url, method: "PUT"); put.setValue(mime, forHTTPHeaderField: "Content-Type")
      let (_, response) = try await transport.upload(for: put, fromFile: fileURL, delegate: NoRedirect()); try accepted(response); return
    }
    let (startData, startResponse) = try await transport.data(for: request(url.appendingPathComponent("multipart"), method: "POST"), delegate: NoRedirect())
    try accepted(startResponse)
    guard startData.count <= 65_536, let state = try JSONSerialization.jsonObject(with: startData) as? [String: Any],
      let partBytes = state["partBytes"] as? Int, partBytes == 8_388_608,
      let total = state["totalParts"] as? Int, total == (bytes + partBytes - 1) / partBytes,
      let uploaded = state["uploadedParts"] as? [Int] else { throw CaptureProofError.upload }
    if state["complete"] as? Bool == true { return }
    let input = try FileHandle(forReadingFrom: fileURL); defer { try? input.close() }
    for part in 1...total where !uploaded.contains(part) {
      try input.seek(toOffset: UInt64((part - 1) * partBytes))
      let length = min(partBytes, bytes - (part - 1) * partBytes)
      guard let chunk = try input.read(upToCount: length), chunk.count == length else { throw CaptureProofError.invalid }
      let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("justtaken-upload-" + UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: temporary) }
      try chunk.write(to: temporary, options: [.atomic, .completeFileProtection])
      var put = request(url.appendingPathComponent("parts/" + String(part)), method: "PUT")
      put.setValue(mime, forHTTPHeaderField: "Content-Type")
      put.setValue(SHA256.hash(data: chunk).map { String(format: "%02x", $0) }.joined(), forHTTPHeaderField: "X-Chunk-SHA256")
      let (_, response) = try await transport.upload(for: put, fromFile: temporary, delegate: NoRedirect()); try accepted(response)
    }
    let (_, response) = try await transport.data(for: request(url.appendingPathComponent("uploaded"), method: "POST"), delegate: NoRedirect())
    try accepted(response)
  }

  func list() throws -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    return try fm.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).compactMap { try? read($0.lastPathComponent) }.sorted { ($0["capturedAt"] as? String ?? "") > ($1["capturedAt"] as? String ?? "") }
  }
  func discard(_ handle: String) throws {
    lock.lock(); defer { lock.unlock() }
    let dir = try directory(handle)
    if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
  }
}
