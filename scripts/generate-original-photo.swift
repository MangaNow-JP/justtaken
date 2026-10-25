import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@main struct OriginalPhotoFixture {
  static func main() throws {
    let folder=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
    let width=4032, height=3024, space=CGColorSpace(name:CGColorSpace.displayP3)!
    let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:space,bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
    for y in stride(from:0,to:height,by:32) { context.setFillColor(CGColor(colorSpace:space,components:[0.1,CGFloat(y)/CGFloat(height),0.3,1])!);context.fill(CGRect(x:0,y:y,width:width,height:32)) }
    let raw=NSMutableData(), output=CGImageDestinationCreateWithData(raw,UTType.jpeg.identifier as CFString,1,nil)!
    CGImageDestinationAddImage(output,context.makeImage()!,[kCGImageDestinationLossyCompressionQuality:1.0,kCGImagePropertyOrientation:6,kCGImagePropertyGPSDictionary:[kCGImagePropertyGPSLatitude:35.0,kCGImagePropertyGPSLatitudeRef:"N",kCGImagePropertyGPSLongitude:139.0,kCGImagePropertyGPSLongitudeRef:"E"]] as CFDictionary)
    precondition(CGImageDestinationFinalize(output))
    let source=raw as Data, result=try JPEGMetadata.original(source,orientation:6)
    let sourcePixels=try JPEGMetadata.strip(source), resultPixels=try JPEGMetadata.strip(result)
    precondition(sourcePixels==resultPixels,"Compressed JPEG data or ICC changed")
    func pixels(_ data:Data)->Data { let image=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(data as CFData,nil)!,0,nil)!;return image.dataProvider!.data! as Data }
    precondition(pixels(source)==pixels(result),"Decoded pixels changed")
    let props=CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(result as CFData,nil)!,0,nil)! as NSDictionary
    precondition(props[kCGImagePropertyGPSDictionary]==nil)
    precondition((props[kCGImagePropertyOrientation] as? Int)==6)
    try source.write(to:folder.appendingPathComponent("original-photo-source.jpg"))
    try result.write(to:folder.appendingPathComponent("original-photo.jpg"))
    print("PASS: 4032×3024 JPEG compressed bytes, Display P3 ICC and pixels unchanged; orientation preserved, GPS removed")
  }
}
