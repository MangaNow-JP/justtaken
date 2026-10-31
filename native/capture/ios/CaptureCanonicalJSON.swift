import Foundation
import CoreFoundation

// The native manifest schema contains ASCII strings, booleans, arrays, objects and
// safe integers only (GPS is expressed in integer micro-units). Do not use
// JSONSerialization.sortedKeys: Foundation sorts case-insensitively and numerically,
// unlike RFC 8785's UTF-16 ordering (clientCaptureId must precede clientCapturedAt).
enum CaptureCanonicalJSON {
  enum Failure: Error { case unsupportedValue }
  static func encode(_ value: Any) throws -> Data { Data(try text(value).utf8) }
  private static func quote(_ value: String) throws -> String {
    guard value.unicodeScalars.allSatisfy({ $0.value < 128 }) else { throw Failure.unsupportedValue }
    return String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
  }
  private static func text(_ value: Any) throws -> String {
    if let object = value as? [String: Any] {
      return "{" + (try object.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map {
        try quote($0) + ":" + text(object[$0]!)
      }).joined(separator: ",") + "}"
    }
    if let array = value as? [Any] { return "[" + (try array.map(text)).joined(separator: ",") + "]" }
    if let string = value as? String { return try quote(string) }
    if let number = value as? NSNumber {
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
      let n = number.doubleValue
      guard n.isFinite, n.rounded(.towardZero) == n, abs(n) <= 9_007_199_254_740_991 else { throw Failure.unsupportedValue }
      return String(Int64(n))
    }
    throw Failure.unsupportedValue
  }
}
