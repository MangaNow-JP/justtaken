package app.justtaken.capture

import android.content.Context
import android.content.pm.PackageManager
import android.util.Base64
import com.google.android.gms.tasks.Tasks
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

internal object CaptureProof {
  private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
  fun binding(json: String): JSONObject {
    val data = JSONObject(json)
    listOf("sessionId", "installationId", "accountBindingId").forEach { UUID.fromString(data.getString(it)) }
    require(Regex("^[A-Za-z0-9_-]{43}$").matches(data.getString("nonce")))
    check(data.getLong("commitExpiresAt") > System.currentTimeMillis()) { "撮影の有効時間が過ぎました。" }
    return data
  }
  @Synchronized private fun integrity(context: Context, payload: String): String {
    if (provider == null) {
      val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      val project = info.metaData.getString("app.justtaken.INTEGRITY_PROJECT")?.removePrefix("project:")?.toLongOrNull()
      require(project != null && project > 0) { "Google Playの接続設定が必要です。" }
      provider = Tasks.await(IntegrityManagerFactory.createStandard(context).prepareIntegrityToken(StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(project).build()), 120, TimeUnit.SECONDS)
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8))
    val hash = Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    try { return Tasks.await(provider!!.request(StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(hash).build()), 120, TimeUnit.SECONDS).token() }
    catch (error: Exception) { provider = null; throw error }
  }
  @Synchronized fun enroll(context: Context, installation: String, challenge: String): Map<String, String> {
    UUID.fromString(installation)
    require(challenge.startsWith("JUSTTAKEN_INSTALL_V1\u0000$installation\u0000") && challenge.length < 512)
    return mapOf("token" to integrity(context, challenge))
  }
  @Synchronized fun prepare(context: Context, handle: String): Map<String, Any?> {
    val manifest = CaptureStore.manifest(context, handle)
    // A fresh Standard token may be requested on retry. The server checks the saved digest first.
    val token = integrity(context, "CAPTURE_SNS_V1\u0000" + canonical(manifest))
    return CaptureStore.jsonMap(JSONObject().put("manifest", manifest).put("proof", JSONObject().put("token", token)))
  }
  private fun canonical(value: Any?): String = when(value) {
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value).replace("\\/", "/")
    null, JSONObject.NULL -> "null"
    else -> value.toString()
  }
}
