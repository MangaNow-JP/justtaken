package app.justtaken.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import org.json.JSONObject
import java.time.Instant
import kotlin.math.ceil
import kotlin.math.roundToLong

internal object CaptureLocationPermission {
  fun precise(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
  fun granted(context: Context) = precise(context) || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
}

// Foreground camera only. No background service or persistent position cache.
internal class CaptureLocationTracker(private val context: Context) : LocationListener, DefaultLifecycleObserver {
  private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private var owner: LifecycleOwner? = null
  private var enabled = false
  private var running = false
  private var latest: Location? = null
  private var preciseSample = false
  fun setEnabled(value: Boolean) { enabled = value; refresh() }
  fun attach(value: LifecycleOwner) {
    detach(); owner = value; value.lifecycle.addObserver(this); refresh()
  }
  fun detach() { stop(); owner?.lifecycle?.removeObserver(this); owner = null }
  override fun onResume(owner: LifecycleOwner) { refresh() }
  override fun onPause(owner: LifecycleOwner) { stop() }
  override fun onStop(owner: LifecycleOwner) { stop() }
  override fun onDestroy(owner: LifecycleOwner) { detach() }
  private fun stop() { manager.removeUpdates(this); running = false; latest = null }
  private fun refresh() {
    val active = owner?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
    if (!enabled || !active || !CaptureLocationPermission.granted(context) || !manager.isLocationEnabled) { stop(); return }
    if (running) return
    latest = null
    val providers = buildList {
      if (CaptureLocationPermission.precise(context)) add(LocationManager.GPS_PROVIDER)
      add(LocationManager.NETWORK_PROVIDER)
    }
    for (provider in providers) {
      try {
        if (manager.isProviderEnabled(provider)) {
          manager.requestLocationUpdates(provider, 1000L, 0f, this, Looper.getMainLooper())
          running = true
        }
      } catch (_: SecurityException) { /* Revoked permission: no sample is accepted. */ }
        catch (_: IllegalArgumentException) { /* Provider absent on this device. */ }
    }
  }
  override fun onLocationChanged(location: Location) { if (running) { latest = location; preciseSample = CaptureLocationPermission.precise(context) } }
  override fun onProviderEnabled(provider: String) { refresh() }
  @Deprecated("Required only for older platform compilation")
  override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
  override fun onProviderDisabled(provider: String) { latest = null }
  fun snapshot(capturedAt: Instant): JSONObject {
    if (!enabled) return JSONObject().put("status", "off")
    val unavailable = JSONObject().put("status", "unavailable")
    val fix = latest ?: return unavailable
    if (!running || owner?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) != true || !CaptureLocationPermission.granted(context) || !manager.isLocationEnabled) return unavailable
    if (preciseSample && !CaptureLocationPermission.precise(context)) return unavailable
    val ageMs = (SystemClock.elapsedRealtimeNanos() - fix.elapsedRealtimeNanos) / 1_000_000
    val wallAgeMs = capturedAt.toEpochMilli() - fix.time
    if (fix.isFromMockProvider || ageMs !in 0..15_000 || wallAgeMs !in 0..15_000 || !fix.hasAccuracy() || !fix.accuracy.isFinite() || fix.accuracy < 0 || fix.accuracy > 100_000 || !fix.latitude.isFinite() || !fix.longitude.isFinite() || fix.latitude !in -90.0..90.0 || fix.longitude !in -180.0..180.0) return unavailable
    return JSONObject().put("status", "recorded").put("source", "device-location")
      .put("latitudeE7", (fix.latitude * 10_000_000).roundToLong())
      .put("longitudeE7", (fix.longitude * 10_000_000).roundToLong())
      .put("horizontalAccuracyMm", ceil(fix.accuracy.toDouble() * 1000).toLong())
      .put("measuredAt", Instant.ofEpochMilli(fix.time).toString())
      .put("accuracyAuthorization", if (CaptureLocationPermission.precise(context)) "precise" else "approximate")
  }
}
