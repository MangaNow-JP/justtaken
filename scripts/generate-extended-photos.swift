import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@main struct ExtendedPhotoFixtures {
  static func main() throws {
    let folder=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
    try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
    let large = CommandLine.arguments.contains("--large")
    let width = large ? 4032 : 512, height = large ? 3024 : 384
    let space=CGColorSpace(name:CGColorSpace.extendedLinearDisplayP3)!
    let ctx=CGContext(data:nil,width:width,height:height,bitsPerComponent:32,bytesPerRow:0,space:space,bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    for y in 0..<height { ctx.setFillColor(CGColor(colorSpace:space,components:[0.2,CGFloat(y)/CGFloat(height)*8,0.3,1])!);ctx.fill(CGRect(x:0,y:y,width:width,height:1)) }
    for (baseName,type,gain) in [("heif-sdr",UTType.heic,false),("heif-hdr",UTType.heic,true),("jpeg-hdr",UTType.jpeg,true)] {
      let name = large ? baseName + "-large" : baseName
      let path=folder.appendingPathComponent(name+(type == .heic ? ".heic" : ".jpg"))
      let dst=CGImageDestinationCreateWithURL(path as CFURL,type.identifier as CFString,1,nil)!
      CGImageDestinationAddImage(dst,ctx.makeImage()!,[kCGImagePropertyOrientation:6,kCGImageDestinationLossyCompressionQuality:0.95,kCGImageDestinationEncodeRequest:gain ? kCGImageDestinationEncodeToISOGainmap : kCGImageDestinationEncodeToSDR] as CFDictionary)
      guard CGImageDestinationFinalize(dst) else { throw NSError(domain:"ImageIO",code:1) }
      let src=CGImageSourceCreateWithURL(path as CFURL,nil)!
      let props=CGImageSourceCopyPropertiesAtIndex(src,0,nil)! as NSDictionary
      let hasGain=CGImageSourceCopyAuxiliaryDataInfoAtIndex(src,0,kCGImageAuxiliaryDataTypeHDRGainMap) != nil || CGImageSourceCopyAuxiliaryDataInfoAtIndex(src,0,kCGImageAuxiliaryDataTypeISOGainMap) != nil
      precondition(hasGain==gain)
      let info:[String:Any] = ["id":"original","role":"original","mime":type == .heic ? "image/heic":"image/jpeg","width":props[kCGImagePropertyPixelWidth]!,"height":props[kCGImagePropertyPixelHeight]!,"orientation":props[kCGImagePropertyOrientation] ?? 1,"preservation":"camera-original","hasGainMap":hasGain,"bytes":try path.resourceValues(forKeys:[.fileSizeKey]).fileSize!]
      try JSONSerialization.data(withJSONObject:info,options:[.prettyPrinted,.sortedKeys]).write(to:folder.appendingPathComponent(name+".json"))
      print(name,info)
    }
  }
}
