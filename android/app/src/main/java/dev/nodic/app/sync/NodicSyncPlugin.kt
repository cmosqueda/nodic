package dev.nodic.app.sync

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

@CapacitorPlugin(
    name = "NodicSync",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class NodicSyncPlugin : Plugin() {
    private val pluginExecutor = Executors.newSingleThreadExecutor()

    override fun load() {
        instance = WeakReference(this)
    }

    override fun handleOnResume() {
        super.handleOnResume()
        isAppInForeground = true
    }

    override fun handleOnPause() {
        super.handleOnPause()
        isAppInForeground = false
    }

    @PluginMethod
    fun getPendingDeepLink(call: PluginCall) {
        val link = pendingDeepLink
        pendingDeepLink = null
        call.resolve(link ?: JSObject())
    }

    @PluginMethod
    fun setActiveRoute(call: PluginCall) {
        val route = call.getString("route")
        activeRoute = route
        call.resolve(JSObject().put("route", route))
    }

    @PluginMethod
    fun getBatteryOptimizationStatus(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val isIgnoring = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        } else {
            true
        }
        call.resolve(
            JSObject()
                .put("ignoringBatteryOptimizations", isIgnoring)
                .put("canRequest", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                .put("manufacturer", Build.MANUFACTURER)
                .put("model", Build.MODEL),
        )
    }

    @PluginMethod
    fun requestIgnoreBatteryOptimizations(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                call.resolve(JSObject().put("launched", true))
            } catch (_: Exception) {
                try {
                    val fallbackIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(fallbackIntent)
                    call.resolve(JSObject().put("launched", true))
                } catch (err: Exception) {
                    call.reject("Could not open battery optimization settings: ${err.message}")
                }
            }
        } else {
            call.resolve(JSObject().put("launched", false))
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) = call.resolve(stateToJs(NodicSyncService.currentState))

    @PluginMethod
    fun start(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "startAfterPermission")
            return
        }
        startService(call)
    }

    @PermissionCallback
    private fun startAfterPermission(call: PluginCall) {
        startService(call)
    }

    private fun startService(call: PluginCall) {
        val displayName = call.getString("displayName")?.take(80)
        val deviceId = call.getString("deviceId")?.take(128)
        val publicKey = call.getString("publicKey")?.take(2048)
        val identity = PhaseZeroStore(context).use { store ->
            if (!displayName.isNullOrBlank() || !deviceId.isNullOrBlank()) {
                store.updateLocalIdentity(deviceId, displayName ?: "Nodic member", publicKey)
            } else {
                store.getOrCreateLocalIdentity()
            }
        }
        val intent = Intent(context, NodicSyncService::class.java).apply {
            action = NodicSyncService.ACTION_START
            putExtra(NodicSyncService.EXTRA_DISPLAY_NAME, identity.displayName)
            putExtra(NodicSyncService.EXTRA_DEVICE_ID, identity.deviceId)
            putExtra(NodicSyncService.EXTRA_PUBLIC_KEY, identity.publicKey)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        call.resolve(stateToJs(NodicSyncService.currentState.copy(state = "SEARCHING", detail = "Starting local discovery")))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.startService(Intent(context, NodicSyncService::class.java).apply { action = NodicSyncService.ACTION_STOP })
        call.resolve(stateToJs(SyncState()))
    }

    @PluginMethod
    fun publishEvent(call: PluginCall) {
        val eventJson = call.getString("eventJson")
        if (eventJson.isNullOrBlank()) {
            call.reject("eventJson is required", "INVALID_EVENT")
            return
        }
        val eventId = Regex("\\\"id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").find(eventJson)?.groupValues?.get(1) ?: UUID.randomUUID().toString()
        val accepted = NodicSyncService.broadcastEvent(eventId, eventJson)
        call.resolve(JSObject().put("accepted", accepted).put("eventId", eventId))
    }

    @PluginMethod
    fun publishBatch(call: PluginCall) {
        val batchJson = call.getString("batchJson")
        if (batchJson.isNullOrBlank()) {
            call.reject("batchJson is required", "INVALID_BATCH")
            return
        }
        val id = UUID.randomUUID().toString()
        val accepted = NodicSyncService.broadcastBatch(id, batchJson)
        call.resolve(JSObject().put("accepted", accepted).put("batchId", id))
    }

    @PluginMethod
    fun publishSummary(call: PluginCall) {
        val summaryJson = call.getString("summaryJson")
        if (summaryJson.isNullOrBlank()) {
            call.reject("summaryJson is required", "INVALID_SUMMARY")
            return
        }
        val id = UUID.randomUUID().toString()
        val accepted = NodicSyncService.broadcastSummary(id, summaryJson)
        call.resolve(JSObject().put("accepted", accepted))
    }

    @PluginMethod
    fun sendProbe(call: PluginCall) {
        val id = UUID.randomUUID().toString()
        val accepted = NodicSyncService.broadcastProbe(id)
        call.resolve(JSObject().put("accepted", accepted).put("probeId", id))
    }

    @PluginMethod
    fun getDeviceIdentity(call: PluginCall) {
        val preferredName = call.getString("displayName")
        val identity = PhaseZeroStore(context).use { it.getOrCreateLocalIdentity(preferredName) }
        call.resolve(
            JSObject()
                .put("deviceId", identity.deviceId)
                .put("displayName", identity.displayName)
                .put("publicKey", identity.publicKey)
                .put("keystoreAlias", identity.keystoreAlias),
        )
    }

    @PluginMethod
    fun syncDeviceIdentity(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        val displayName = call.getString("displayName") ?: "Nodic member"
        val publicKey = call.getString("publicKey")
        val updated = PhaseZeroStore(context).use {
            it.updateLocalIdentity(deviceId, displayName, publicKey)
        }
        NodicSyncService.notifyIdentityUpdated()
        call.resolve(
            JSObject()
                .put("deviceId", updated.deviceId)
                .put("displayName", updated.displayName)
                .put("publicKey", updated.publicKey)
                .put("keystoreAlias", updated.keystoreAlias),
        )
    }

    @PluginMethod
    fun connectPeer(call: PluginCall) {
        val host = call.getString("host")?.trim()
        val port = call.getInt("port") ?: 0
        if (host.isNullOrBlank() || port <= 0) {
            call.reject("Valid host and port are required", "INVALID_ENDPOINT")
            return
        }
        pluginExecutor.execute {
            val connected = NodicSyncService.connectToPeer(host, port)
            call.resolve(JSObject().put("connected", connected).put("host", host).put("port", port))
        }
    }

    @PluginMethod
    fun getDiagnostics(call: PluginCall) {
        PhaseZeroStore(context).use { store ->
            val peers = jsonArrayToJsArray(store.getPeerIdentities())
            val sessions = jsonArrayToJsArray(store.getPeerSessions(50))
            val logs = jsonArrayToJsArray(store.getSyncLogs(100))
            call.resolve(
                JSObject()
                    .put("peerIdentities", peers)
                    .put("peerSessions", sessions)
                    .put("syncLogs", logs),
            )
        }
    }

    @PluginMethod
    fun clearLogs(call: PluginCall) {
        PhaseZeroStore(context).use { it.clearSyncLogs() }
        call.resolve(JSObject().put("cleared", true))
    }

    @PluginMethod
    fun runProbe(call: PluginCall) {
        val details = JSArray()
        var databaseReady = false
        var identity: LocalNodeIdentity? = null
        try {
            PhaseZeroStore(context).use { store ->
                databaseReady = store.verify()
                identity = store.getOrCreateLocalIdentity()
            }
            details.put("Native SQLite opened and accepted a query.")
        } catch (error: Exception) {
            details.put("SQLite failed: ${error.message}")
        }
        val serviceReady = NodicSyncService.currentState.state != "STOPPED"
        details.put(if (serviceReady) "Foreground sync service is active." else "Start networking to activate the foreground service.")
        details.put("Discovered peers: ${NodicSyncService.currentState.peerCount}.")
        if (NodicSyncService.currentState.localEndpoint != null) {
            details.put("Listening endpoint: ${NodicSyncService.currentState.localEndpoint}")
        }

        val deviceId = identity?.deviceId ?: UUID.randomUUID().toString()
        call.resolve(
            JSObject()
                .put("pluginReady", true)
                .put("databaseReady", databaseReady)
                .put("serviceReady", serviceReady)
                .put("deviceId", deviceId)
                .put("details", details),
        )
    }

    private fun jsonArrayToJsArray(arr: JSONArray): JSArray {
        val jsArr = JSArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i)
            if (item != null) {
                jsArr.put(JSObject.fromJSONObject(item))
            }
        }
        return jsArr
    }

    private fun emit(name: String, payload: JSObject) = notifyListeners(name, payload)

    companion object {
        private var instance = WeakReference<NodicSyncPlugin>(null)
        var pendingDeepLink: JSObject? = null
        var isAppInForeground: Boolean = false
        var activeRoute: String? = null

        fun handleDeepLink(route: String, channelId: String?, eventId: String?, taskId: String?) {
            val payload = JSObject()
                .put("route", route)
                .put("channelId", channelId)
                .put("eventId", eventId)
                .put("taskId", taskId)
            val plugin = instance.get()
            if (plugin != null) {
                plugin.emit("deepLinkOpened", payload)
            } else {
                pendingDeepLink = payload
            }
        }

        fun emitStatus(state: SyncState) = instance.get()?.emit("statusChanged", stateToJs(state))

        fun emitReceived(id: String, from: String, sentAt: String, eventJson: String?) {
            val payload = JSObject().put("id", id).put("from", from).put("sentAt", sentAt)
            instance.get()?.emit("probeEventReceived", payload)
            if (eventJson != null) {
                instance.get()?.emit("eventReceived", JSObject().put("eventJson", eventJson).put("peerId", from))
            }
        }

        fun emitSummaryReceived(peerId: String, summaryJson: String) {
            instance.get()?.emit("summaryReceived", JSObject().put("summaryJson", summaryJson).put("peerId", peerId))
        }

        fun emitPeerIdentity(peerJson: JSONObject) {
            try {
                instance.get()?.emit("peerIdentityUpdated", JSObject.fromJSONObject(peerJson))
            } catch (_: Exception) {}
        }

        fun emitPeerSession(sessionJson: JSONObject) {
            try {
                instance.get()?.emit("peerSessionUpdated", JSObject.fromJSONObject(sessionJson))
            } catch (_: Exception) {}
        }

        fun emitLogAdded(logJson: JSONObject) {
            try {
                instance.get()?.emit("syncLogAdded", JSObject.fromJSONObject(logJson))
            } catch (_: Exception) {}
        }

        private fun stateToJs(state: SyncState) = JSObject()
            .put("state", state.state)
            .put("peerCount", state.peerCount)
            .put("pendingEventCount", state.pendingEventCount)
            .put("lastSyncAt", state.lastSyncAt)
            .put("detail", state.detail)
            .put("localEndpoint", state.localEndpoint)
    }
}
