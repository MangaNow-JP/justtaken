// Synthetic 8×8 JPEG fixture using the same fresh ImageIO/sRGB path as iOS capture.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@main struct GenerateFixture { static func main() throws {
let context = CGContext(data:nil,width:8,height:8,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red:0.2,green:0.5,blue:0.3,alpha:1));context.fill(CGRect(x:0,y:0,width:8,height:8))
let destination=CGImageDestinationCreateWithURL(URL(fileURLWithPath:CommandLine.arguments[1]) as CFURL,UTType.jpeg.identifier as CFString,1,nil)!
CGImageDestinationAddImage(destination,context.makeImage()!,[kCGImageDestinationLossyCompressionQuality:0.86] as CFDictionary)
precondition(CGImageDestinationFinalize(destination))
let url = URL(fileURLWithPath: CommandLine.arguments[1])
try JPEGMetadata.strip(Data(contentsOf: url)).write(to: url)

}}
