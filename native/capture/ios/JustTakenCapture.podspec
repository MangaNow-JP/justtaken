Pod::Spec.new do |s|
  s.name = 'JustTakenCapture'
  s.version = '0.1.0'
  s.summary = 'Camera-only local capture prototype for JustTaken'
  s.description = 'Private native capture handles; no external file import or signing API.'
  s.license = { :type => 'UNLICENSED' }
  s.author = 'JustTaken'
  s.homepage = 'https://example.invalid/justtaken'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'ImageIO', 'CryptoKit', 'UIKit', 'DeviceCheck', 'CoreLocation'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift}'
end
