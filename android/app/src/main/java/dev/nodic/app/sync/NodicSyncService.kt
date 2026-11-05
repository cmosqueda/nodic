package dev.nodic.app.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.nodic.app.MainActivity
import dev.nodic.app.R
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class NodicSyncService : Service() {
    private val executor = Executors.newCachedThreadPool()
    private val peers = ConcurrentHashMap<String, NsdServiceInfo>()
    private lateinit var nsdManager: NsdManager
    private lateinit var store: PhaseZeroStore
    private var serverSocket: ServerSocket? = null
    private var serviceName = ""
    private var registered = false
    private var discovering = false

    override fun onCreate() {
        super.onCreate()
        liveService = this
        nsdManager = getSystemService(Context.NSD_SERVICE) as NsdManager
        store = PhaseZeroStore(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopNetworking()
            else -> {
                startForeground(NOTIFICATION_ID, buildNotification("Searching for nearby Nodic nodes"))
                if (serverSocket == null) startNetworking()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startNetworking() {
        updateState(SyncState(state = "SEARCHING", detail = "Advertising on local Wi-Fi"))
        executor.execute {
            try {
                val socket = ServerSocket(0)
                serverSocket = socket
                val preferences = getSharedPreferences("nodic_identity", 0)
                val deviceId = preferences.getString("device_id", null) ?: UUID.randomUUID().toString().also {
                    preferences.edit().putString("device_id", it).apply()
                }
                serviceName = "nodic-${deviceId.take(8)}"
                registerService(socket.localPort)
                discoverServices()
                acceptConnections(socket)
            } catch (error: Exception) {
                updateState(SyncState(state = "ERROR", detail = "Local listener failed: ${error.message}"))
            }
        }
    }

    private fun registerService(port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = this@NodicSyncService.serviceName
            serviceType = SERVICE_TYPE
            setPort(port)
        }
        nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener)
    }

    private fun discoverServices() {
        if (discovering) return
        discovering = true
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    private fun acceptConnections(server: ServerSocket) {
        while (!server.isClosed) {
            try {
                val client = server.accept()
                executor.execute { handleClient(client) }
            } catch (_: Exception) {
                if (!server.isClosed) updateState(currentState.copy(state = "ERROR", detail = "Peer listener interrupted"))
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 5_000
            val line = BufferedReader(InputStreamReader(client.getInputStream())).readLine() ?: return
            if (line.length > MAX_FRAME_CHARS) return
            try {
                val frame = JSONObject(line)
                val kind = frame.optString("kind")
                if (kind != "PROBE" && kind != "EVENT" && kind != "EVENT_BATCH") return
                val id = frame.getString("id")
                val sentAt = frame.optString("sentAt", Instant.now().toString())
                val from = frame.optString("from", client.inetAddress.hostAddress ?: "unknown")

                if (kind == "EVENT_BATCH") {
                    val batchArray = frame.optJSONArray("events")
                    if (batchArray != null) {
                        for (i in 0 until batchArray.length()) {
                            val ev = batchArray.getJSONObject(i)
                            val evId = ev.optString("id", UUID.randomUUID().toString())
                            NodicSyncPlugin.emitReceived(evId, from, sentAt, ev.toString())
                        }
                    }
                } else {
                    val eventJson = frame.optString("eventJson").takeIf { it.isNotBlank() }
                    NodicSyncPlugin.emitReceived(id, from, sentAt, eventJson)
                }

                store.insert(id, from, line)
                PrintWriter(client.getOutputStream(), true).println(JSONObject().put("kind", "ACK").put("id", id))
                updateState(currentState.copy(state = "CONNECTED", lastSyncAt = Instant.now().toString(), detail = "Received ${kind.lowercase()} from peer"))
                showReceiptNotification(from)
            } catch (_: Exception) {
                // Malformed Phase 0 frames are ignored. Production transport will quarantine them.
            }
        }
    }

    private fun sendFrame(id: String, eventJson: String?): Boolean {
        val snapshot = peers.values.toList()
        if (snapshot.isEmpty()) {
            updateState(currentState.copy(state = "SEARCHING", pendingEventCount = currentState.pendingEventCount + 1, detail = "No peer available; probe remains pending"))
            return false
        }

        updateState(currentState.copy(pendingEventCount = currentState.pendingEventCount + 1, detail = "Sending to ${snapshot.size} peer(s)"))
        snapshot.forEach { peer ->
            executor.execute {
                try {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(peer.host, peer.port), 3_000)
                        socket.soTimeout = 5_000
                        val frame = JSONObject()
                            .put("kind", if (eventJson == null) "PROBE" else "EVENT")
                            .put("id", id)
                            .put("from", serviceName)
                            .put("sentAt", Instant.now().toString())
                        if (eventJson != null) frame.put("eventJson", eventJson)
                        PrintWriter(socket.getOutputStream(), true).println(frame.toString())
                        val ack = BufferedReader(InputStreamReader(socket.getInputStream())).readLine()
                        if (ack != null && JSONObject(ack).optString("id") == id) {
                            updateState(currentState.copy(state = "CONNECTED", pendingEventCount = 0, lastSyncAt = Instant.now().toString(), detail = "Peer acknowledged Phase 0 frame"))
                        }
                    }
                } catch (error: Exception) {
                    updateState(currentState.copy(detail = "Peer send failed: ${error.message}"))
                }
            }
        }
        return true
    }

    private fun sendBatchFrame(id: String, batchJson: String): Boolean {
        val snapshot = peers.values.toList()
        if (snapshot.isEmpty()) return false

        snapshot.forEach { peer ->
            executor.execute {
                try {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(peer.host, peer.port), 3_000)
                        socket.soTimeout = 5_000
                        val frame = JSONObject()
                            .put("kind", "EVENT_BATCH")
                            .put("id", id)
                            .put("from", serviceName)
                            .put("sentAt", Instant.now().toString())
                            .put("events", org.json.JSONArray(batchJson))
                        PrintWriter(socket.getOutputStream(), true).println(frame.toString())
                        val ack = BufferedReader(InputStreamReader(socket.getInputStream())).readLine()
                        if (ack != null && JSONObject(ack).optString("id") == id) {
                            updateState(currentState.copy(state = "CONNECTED", lastSyncAt = Instant.now().toString(), detail = "Peer acknowledged event batch"))
                        }
                    }
                } catch (error: Exception) {
                    updateState(currentState.copy(detail = "Batch send failed: ${error.message}"))
                }
            }
        }
        return true
    }

    private val registrationListener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(info: NsdServiceInfo) { registered = true }
        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            updateState(SyncState(state = "ERROR", detail = "NSD registration failed ($errorCode)"))
        }
        override fun onServiceUnregistered(info: NsdServiceInfo) { registered = false }
        override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
    }

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) = Unit
        override fun onServiceFound(info: NsdServiceInfo) {
            if (info.serviceName == serviceName || !info.serviceType.startsWith(SERVICE_TYPE.removeSuffix("."))) return
            @Suppress("DEPRECATION")
            nsdManager.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    if (serviceInfo.serviceName == serviceName) return
                    peers[serviceInfo.serviceName] = serviceInfo
                    updatePeerState()
                }
            })
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            peers.remove(info.serviceName)
            updatePeerState()
        }
        override fun onDiscoveryStopped(type: String) { discovering = false }
        override fun onStartDiscoveryFailed(type: String, errorCode: Int) {
            discovering = false
            updateState(SyncState(state = "ERROR", detail = "NSD discovery failed ($errorCode)"))
        }
        override fun onStopDiscoveryFailed(type: String, errorCode: Int) { discovering = false }
    }

    private fun updatePeerState() {
        updateState(
            currentState.copy(
                state = if (peers.isEmpty()) "SEARCHING" else "CONNECTED",
                peerCount = peers.size,
                detail = if (peers.isEmpty()) "No nearby Nodic nodes yet" else "${peers.size} nearby Nodic node(s)",
            ),
        )
    }

    private fun updateState(state: SyncState) {
        currentState = state
        NodicSyncPlugin.emitStatus(state)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(state.detail ?: state.state))
    }

    private fun stopNetworking() {
        try { if (discovering) nsdManager.stopServiceDiscovery(discoveryListener) } catch (_: Exception) {}
        try { if (registered) nsdManager.unregisterService(registrationListener) } catch (_: Exception) {}
        try { serverSocket?.close() } catch (_: Exception) {}
        peers.clear()
        currentState = SyncState()
        NodicSyncPlugin.emitStatus(currentState)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Nodic local network", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps Nodic available to nearby department devices"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(detail: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_nodic)
        .setContentTitle("Nodic network is active")
        .setContentText(detail)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        .build()

    private fun showReceiptNotification(from: String) {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_nodic)
            .setContentTitle("Nodic probe received")
            .setContentText("Received from ${from.take(24)}")
            .setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(RECEIPT_NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        liveService = null
        try { store.close() } catch (_: Exception) {}
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "dev.nodic.app.sync.START"
        const val ACTION_STOP = "dev.nodic.app.sync.STOP"
        const val EXTRA_DISPLAY_NAME = "displayName"
        private const val SERVICE_TYPE = "_nodic._tcp."
        private const val CHANNEL_ID = "nodic_sync"
        private const val NOTIFICATION_ID = 4101
        private const val RECEIPT_NOTIFICATION_ID = 4102
        private const val MAX_FRAME_CHARS = 262_144

        @Volatile var currentState = SyncState()
            private set
        @Volatile private var liveService: NodicSyncService? = null

        fun broadcastProbe(id: String): Boolean = liveService?.sendFrame(id, null) ?: false
        fun broadcastEvent(id: String, eventJson: String): Boolean = liveService?.sendFrame(id, eventJson) ?: false
        fun broadcastBatch(id: String, batchJson: String): Boolean = liveService?.sendBatchFrame(id, batchJson) ?: false
    }
}
