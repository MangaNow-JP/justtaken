import Foundation
// ImageIO adds color/dimension EXIF and empty Photoshop records even for a fresh CGImage.
// Remove nonessential APP/COM segments before hashes are calculated; retain JFIF and ICC only.
enum JPEGMetadata {
  // Keep compressed pixels and ICC byte-for-byte; replace private EXIF with orientation only.
  static func original(_ data: Data, orientation: Int) throws -> Data {
    guard (1...8).contains(orientation) else { throw CocoaError(.fileReadCorruptFile) }
    let clean = try strip(data)
    var result = Data([255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,UInt8(orientation),0,0,0,0,0,0,0])
    result.append(clean.dropFirst(2)); return result
  }
  static func strip(_ data: Data) throws -> Data {
    let bytes = [UInt8](data)
    guard bytes.count >= 4, bytes[0] == 255, bytes[1] == 216 else { throw CocoaError(.fileReadCorruptFile) }
    var out = Data(bytes[0..<2]); var offset = 2
    while offset + 3 < bytes.count {
      guard bytes[offset] == 255 else { throw CocoaError(.fileReadCorruptFile) }
      let marker = bytes[offset + 1]
      if marker == 218 || marker == 217 { out.append(contentsOf: bytes[offset...]); return out }
      let length = Int(bytes[offset + 2]) * 256 + Int(bytes[offset + 3])
      guard length >= 2, offset + 2 + length <= bytes.count else { throw CocoaError(.fileReadCorruptFile) }
      if marker == 226 && (length < 16 || String(bytes: bytes[(offset+4)..<(offset+16)], encoding: .ascii) != "ICC_PROFILE\0") { throw CocoaError(.fileReadUnsupportedScheme) }
      let metadata = (224...239).contains(Int(marker)) && marker != 224 && marker != 226 || marker == 254
      if !metadata { out.append(contentsOf: bytes[offset..<(offset + length + 2)]) }
      offset += length + 2
    }
    throw CocoaError(.fileReadCorruptFile)
  }
}
