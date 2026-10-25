import Foundation
import CoreLocation

// Called only on the main queue. Permission requests never start location updates.
final class CaptureLocationPermission: NSObject, CLLocationManagerDelegate {
  static let shared = CaptureLocationPermission()
  private let manager = CLLocationManager()
  private var callbacks: [(Bool) -> Void] = []
  override init() { super.init(); manager.delegate = self }
  var granted: Bool {
    manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
  }
  func request(_ completion: @escaping (Bool) -> Void) {
    guard manager.authorizationStatus == .notDetermined else { completion(granted); return }
    callbacks.append(completion)
    manager.requestWhenInUseAuthorization()
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard manager.authorizationStatus != .notDetermined else { return }
    let waiting = callbacks; callbacks.removeAll()
    waiting.forEach { $0(granted) }
  }
}

// One tracker per visible camera. No background mode, geofencing, or last-known
// position lookup. A fresh native sample is snapshotted at the capture start.
final class CaptureLocationTracker: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var enabled = false, active = false, running = false
  private var latest: CLLocation?
  override init() {
    super.init(); manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    manager.distanceFilter = kCLDistanceFilterNone
    manager.pausesLocationUpdatesAutomatically = true
  }
  deinit { manager.stopUpdatingLocation() }
  func setEnabled(_ value: Bool) { enabled = value; refresh() }
  func setActive(_ value: Bool) { active = value; refresh() }
  private func refresh() {
    let permitted = manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
    let shouldRun = enabled && active && permitted
    if shouldRun && !running { latest = nil; running = true; manager.startUpdatingLocation() }
    if !shouldRun { manager.stopUpdatingLocation(); running = false; latest = nil }
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { latest = nil; refresh() }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard running else { return }
    latest = locations.last
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { latest = nil }
  func snapshot(at capturedAt: Date) -> [String: Any] {
    guard enabled else { return ["status": "off"] }
    let unavailable: [String: Any] = ["status": "unavailable"]
    guard active, running, CaptureLocationPermission.shared.granted, let fix = latest,
      CLLocationCoordinate2DIsValid(fix.coordinate), fix.horizontalAccuracy.isFinite,
      fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 100_000,
      fix.sourceInformation?.isSimulatedBySoftware != true else { return unavailable }
    let age = capturedAt.timeIntervalSince(fix.timestamp)
    guard age >= 0, age <= 15 else { return unavailable }
    return ["status": "recorded", "source": "device-location",
      "latitudeE7": Int((fix.coordinate.latitude * 10_000_000).rounded()),
      "longitudeE7": Int((fix.coordinate.longitude * 10_000_000).rounded()),
      "horizontalAccuracyMm": Int((fix.horizontalAccuracy * 1000).rounded(.up)),
      "measuredAt": ISO8601DateFormatter().string(from: fix.timestamp),
      "accuracyAuthorization": manager.accuracyAuthorization == .fullAccuracy ? "precise" : "approximate"]
  }
}
