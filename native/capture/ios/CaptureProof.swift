import Foundation
import DeviceCheck
import CryptoKit

struct CaptureBinding {
  let fields: [String: Any]
  init(_ json: String) throws {
    guard let data = json.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CaptureProofError.invalid }
    for key in ["sessionId", "installationId", "accountBindingId"] {
      guard let id = value[key] as? String, UUID(uuidString: id) != nil else { throw CaptureProofError.invalid }
    }
    guard let nonce = value["nonce"] as? String, nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
          let expiry = value["commitExpiresAt"] as? Double, expiry > Date().timeIntervalSince1970 * 1000 else { throw CaptureProofError.expired }
    fields = value
  }
}
enum CaptureProofError: LocalizedError {
  case invalid, expired, unsupported, busy, missingKey, configuration, upload
  var errorDescription: String? {
    switch self {
    case .invalid: return "撮影記録を読み込めませんでした。"
    case .expired: return "撮影の有効時間が過ぎました。もう一度撮影してください。"
    case .unsupported: return "撮影認証は対応するiPhone実機でご利用ください。"
    case .busy: return "前の写真を処理しています。少し待って再試行してください。"
    case .missingKey: return "端末認証をやり直してください。"
    case .configuration: return "アプリの接続先を設定してください。"
    case .upload: return "写真を送信できませんでした。再試行してください。"
    }
  }
}
actor CaptureProof {
  static let shared = CaptureProof()
  private var working = false
  func enroll(_ installationId: String, challenge: String) async throws -> [String: String] {
    guard DCAppAttestService.shared.isSupported else { throw CaptureProofError.unsupported }
    guard UUID(uuidString: installationId) != nil, challenge.hasPrefix("JUSTTAKEN_INSTALL_V1\0" + installationId + "\0"), challenge.count < 512 else { throw CaptureProofError.invalid }
    let defaults = UserDefaults.standard, prefix = "JustTakenAttest." + installationId
    if let proof = defaults.string(forKey: prefix + ".proof"), let key = defaults.string(forKey: prefix + ".key"), defaults.string(forKey: prefix + ".challenge") == challenge { return ["keyId": key, "attestation": proof] }
    guard !working else { throw CaptureProofError.busy }; working = true; defer { working = false }
    let key: String
    if let existing = defaults.string(forKey: prefix + ".key") { key = existing }
    else {
      key = try await withCheckedThrowingContinuation { continuation in
        DCAppAttestService.shared.generateKey { key, error in
          if let key { continuation.resume(returning: key) } else { continuation.resume(throwing: error ?? CaptureProofError.missingKey) }
        }
      }; defaults.set(key, forKey: prefix + ".key")
    }
    let hash = Data(SHA256.hash(data: Data(challenge.utf8)))
    let proof: Data = try await withCheckedThrowingContinuation { continuation in
      DCAppAttestService.shared.attestKey(key, clientDataHash: hash) { data, error in
        if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? CaptureProofError.invalid) }
      }
    }
    defaults.set(challenge, forKey: prefix + ".challenge"); defaults.set(proof.base64EncodedString(), forKey: prefix + ".proof")
    return ["keyId": key, "attestation": proof.base64EncodedString()]
  }
  func prepare(_ handle: String) async throws -> [String: Any] {
    guard DCAppAttestService.shared.isSupported else { throw CaptureProofError.unsupported }
    if let saved = try CaptureStore.shared.savedProof(handle) { return saved }
    guard !working else { throw CaptureProofError.busy }; working = true; defer { working = false }
    let manifest = try CaptureStore.shared.manifest(handle)
    guard let installation = manifest["installationId"] as? String,
          let key = UserDefaults.standard.string(forKey: "JustTakenAttest." + installation + ".key") else { throw CaptureProofError.missingKey }
    // All manifest values are ASCII IDs, integer image properties and UTC timestamps.
    // Foundation sorted keys + unescaped slashes are JCS-equivalent for this native-owned subset.
    let canonical = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys, .withoutEscapingSlashes])
    var payload = Data("CAPTURE_SNS_V1\0".utf8); payload.append(canonical)
    let hash = Data(SHA256.hash(data: payload))
    let assertion: Data = try await withCheckedThrowingContinuation { continuation in
      DCAppAttestService.shared.generateAssertion(key, clientDataHash: hash) { data, error in
        if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? CaptureProofError.invalid) }
      }
    }
    let result: [String: Any] = ["manifest": manifest, "proof": ["keyId": key, "assertion": assertion.base64EncodedString()]]
    try CaptureStore.shared.saveProof(handle, result: result)
    return result
  }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
