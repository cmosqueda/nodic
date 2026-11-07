package dev.nodic.app.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class NodicBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED || action == "android.intent.action.QUICKBOOT_POWERON") {
            try {
                val store = PhaseZeroStore(context)
                val identity = store.getOrCreateLocalIdentity()
                store.insertLog(
                    level = "INFO",
                    category = "SYSTEM",
                    peerDeviceId = identity.deviceId,
                    sessionId = null,
                    message = "Device boot completed; initializing Nodic foreground sync service",
                )
                store.close()

                val serviceIntent = Intent(context, NodicSyncService::class.java).apply {
                    this.action = NodicSyncService.ACTION_START
                    putExtra(NodicSyncService.EXTRA_DISPLAY_NAME, identity.displayName)
                    putExtra(NodicSyncService.EXTRA_DEVICE_ID, identity.deviceId)
                    putExtra(NodicSyncService.EXTRA_PUBLIC_KEY, identity.publicKey)
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (_: Exception) {
                // Ignore background launch restrictions or startup failures on boot
            }
        }
    }
}
