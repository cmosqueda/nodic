package dev.nodic.app.sync

import android.Manifest
import android.content.Intent
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.lang.ref.WeakReference
import java.time.Instant
import java.util.UUID

@CapacitorPlugin(
    name = "NodicSync",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class NodicSyncPlugin : Plugin() {
    override fun load() {
        instance = WeakReference(this)
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
        val displayName = call.getString("displayName")?.take(80) ?: "Nodic member"
        val intent = Intent(context, NodicSyncService::class.java).apply {
            action = NodicSyncService.ACTION_START
            putExtra(NodicSyncService.EXTRA_DISPLAY_NAME, displayName)
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
    fun sendProbe(call: PluginCall) {
        val id = UUID.randomUUID().toString()
        val accepted = NodicSyncService.broadcastProbe(id)
        call.resolve(JSObject().put("accepted", accepted).put("probeId", id))
    }

    @PluginMethod
    fun getDeviceIdentity(call: PluginCall) {
        val preferences = context.getSharedPreferences("nodic_identity", 0)
        val existing = preferences.getString("device_id", null)
        val deviceId = existing ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("device_id", it).apply()
        }
        call.resolve(JSObject().put("deviceId", deviceId).put("publicKey", "phase-0-key-not-generated"))
    }

    @PluginMethod
    fun runProbe(call: PluginCall) {
        val details = com.getcapacitor.JSArray()
        var databaseReady = false
        try {
            databaseReady = PhaseZeroStore(context).use { it.verify() }
            details.put("Native SQLite opened and accepted a query.")
        } catch (error: Exception) {
            details.put("SQLite failed: ${error.message}")
        }
        val serviceReady = NodicSyncService.currentState.state != "STOPPED"
        details.put(if (serviceReady) "Foreground sync service is active." else "Start networking to activate the foreground service.")
        details.put("Discovered peers: ${NodicSyncService.currentState.peerCount}.")

        val preferences = context.getSharedPreferences("nodic_identity", 0)
        val deviceId = preferences.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("device_id", it).apply()
        }
        call.resolve(
            JSObject()
                .put("pluginReady", true)
                .put("databaseReady", databaseReady)
                .put("serviceReady", serviceReady)
                .put("deviceId", deviceId)
                .put("details", details),
        )
    }

    private fun emit(name: String, payload: JSObject) = notifyListeners(name, payload)

    companion object {
        private var instance = WeakReference<NodicSyncPlugin>(null)

        fun emitStatus(state: SyncState) = instance.get()?.emit("statusChanged", stateToJs(state))

        fun emitReceived(id: String, from: String, sentAt: String, eventJson: String?) {
            val payload = JSObject().put("id", id).put("from", from).put("sentAt", sentAt)
            instance.get()?.emit("probeEventReceived", payload)
            if (eventJson != null) {
                instance.get()?.emit("eventReceived", JSObject().put("eventJson", eventJson).put("peerId", from))
            }
        }

        private fun stateToJs(state: SyncState) = JSObject()
            .put("state", state.state)
            .put("peerCount", state.peerCount)
            .put("pendingEventCount", state.pendingEventCount)
            .put("lastSyncAt", state.lastSyncAt)
            .put("detail", state.detail)
    }
}
