package dev.nodic.app.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.nodic.app.MainActivity
import dev.nodic.app.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashSet
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

data class ConnectedPeerEndpoint(
    val deviceId: String,
    val displayName: String,
    val publicKey: String,
    val serviceName: String,
    val host: String,
    val port: Int,
    val sessionId: String,
    val direction: String,
)

class NodicSyncService : Service() {
    private val executor = Executors.newCachedThreadPool()
    private val nsdPeers = ConcurrentHashMap<String, NsdServiceInfo>()
    private val connectedPeers = ConcurrentHashMap<String, ConnectedPeerEndpoint>()
    private val notifiedEventIds = Collections.synchronizedSet(LinkedHashSet<String>())
    private lateinit var nsdManager: NsdManager
    private lateinit var store: PhaseZeroStore
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastResolvedIp: String? = null
    private var serverSocket: ServerSocket? = null
    private var serviceName = ""
    private var listenPort = 0
    private var registered = false
    private var discovering = false

    override fun onCreate() {
        super.onCreate()
        liveService = this
        nsdManager = getSystemService(Context.NSD_SERVICE) as NsdManager
        store = PhaseZeroStore(this)
        createNotificationChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopNetworking()
            else -> {
                val displayName = intent?.getStringExtra(EXTRA_DISPLAY_NAME)
                val deviceId = intent?.getStringExtra(EXTRA_DEVICE_ID)
                val publicKey = intent?.getStringExtra(EXTRA_PUBLIC_KEY)
                if (!displayName.isNullOrBlank() || !deviceId.isNullOrBlank()) {
                    val current = store.getOrCreateLocalIdentity(displayName)
                    store.updateLocalIdentity(
                        deviceId = deviceId ?: current.deviceId,
                        displayName = displayName ?: current.displayName,
                        publicKey = publicKey ?: current.publicKey,
                    )
                }
                startForeground(NOTIFICATION_ID, buildNotification("Searching for nearby Nodic nodes"))
                if (serverSocket == null) startNetworking()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startNetworking() {
        updateState(SyncState(state = "SEARCHING", detail = "Advertising on local Wi-Fi"))
        registerNetworkCallback()
        executor.execute {
            try {
                val identity = store.getOrCreateLocalIdentity()
                val socket = ServerSocket(0)
                serverSocket = socket
                listenPort = socket.localPort
                serviceName = "nodic-${identity.deviceId.take(8)}"
                val localIp = resolveLocalIpv4Address() ?: "0.0.0.0"
                lastResolvedIp = localIp
                val endpoint = "$localIp:$listenPort"

                val logObj = store.insertLog(
                    level = "INFO",
                    category = "DISCOVERY",
                    peerDeviceId = identity.deviceId,
                    sessionId = null,
                    message = "Nodic sync listener started on $endpoint as ${identity.displayName}",
                    detailsJson = JSONObject()
                        .put("endpoint", endpoint)
                        .put("serviceName", serviceName)
                        .put("deviceId", identity.deviceId)
                        .toString(),
                )
                NodicSyncPlugin.emitLogAdded(logObj)

                updateState(
                    currentState.copy(
                        state = "SEARCHING",
                        detail = "Listening on $endpoint",
                        localEndpoint = endpoint,
                    ),
                )

                registerService(socket.localPort)
                discoverServices()
                acceptConnections(socket)
            } catch (error: Exception) {
                val logObj = store.insertLog(
                    level = "ERROR",
                    category = "DISCOVERY",
                    peerDeviceId = null,
                    sessionId = null,
                    message = "Local listener failed: ${error.message}",
                )
                NodicSyncPlugin.emitLogAdded(logObj)
                updateState(SyncState(state = "ERROR", detail = "Local listener failed: ${error.message}"))
            }
        }
    }

    private fun resolveLocalIpv4Address(): String? {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            for (intf in interfaces) {
                if (!intf.isUp || intf.isLoopback) continue
                for (addr in intf.inetAddresses) {
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        return addr.hostAddress
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
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
                val localIdentity = store.getOrCreateLocalIdentity()
                val remoteHost = client.inetAddress.hostAddress ?: "unknown"

                if (kind == "HELLO") {
                    val sessionId = frame.optString("sessionId").takeIf { it.isNotBlank() }
                        ?: frame.optString("id").takeIf { it.isNotBlank() }
                        ?: UUID.randomUUID().toString()
                    val remoteDeviceId = frame.optString("deviceId").takeIf { it.isNotBlank() }
                        ?: frame.optString("from", "peer-$remoteHost")
                    if (remoteDeviceId == localIdentity.deviceId) return

                    val remoteDisplayName = frame.optString("displayName").takeIf { it.isNotBlank() }
                        ?: "Node-${remoteDeviceId.take(4).uppercase()}"
                    val remotePublicKey = frame.optString("publicKey").takeIf { it.isNotBlank() }
                        ?: "p256-peer-key"
                    val remoteServiceName = frame.optString("serviceName").takeIf { it.isNotBlank() }
                        ?: "nodic-${remoteDeviceId.take(8)}"
                    val remoteListenPort = frame.optInt("listenPort", client.port).takeIf { it > 0 } ?: client.port

                    val existingPeer = connectedPeers[remoteDeviceId]
                    val effectiveSessionId = existingPeer?.sessionId ?: sessionId

                    val endpoint = ConnectedPeerEndpoint(
                        deviceId = remoteDeviceId,
                        displayName = remoteDisplayName,
                        publicKey = remotePublicKey,
                        serviceName = remoteServiceName,
                        host = remoteHost,
                        port = remoteListenPort,
                        sessionId = effectiveSessionId,
                        direction = "INBOUND",
                    )
                    connectedPeers[remoteDeviceId] = endpoint

                    val peerIdentityJson = store.upsertPeerIdentity(
                        deviceId = remoteDeviceId,
                        displayName = remoteDisplayName,
                        publicKey = remotePublicKey,
                        serviceName = remoteServiceName,
                        host = remoteHost,
                        port = remoteListenPort,
                        status = "ONLINE",
                    )
                    val sessionJson = store.upsertPeerSession(
                        sessionId = effectiveSessionId,
                        peerDeviceId = remoteDeviceId,
                        peerDisplayName = remoteDisplayName,
                        peerPublicKey = remotePublicKey,
                        peerAddress = remoteHost,
                        peerPort = remoteListenPort,
                        direction = "INBOUND",
                        status = "CONNECTED",
                    )
                    val logJson = store.insertLog(
                        level = "INFO",
                        category = "SESSION",
                        peerDeviceId = remoteDeviceId,
                        sessionId = effectiveSessionId,
                        message = "Connected with peer $remoteDisplayName ($remoteHost:$remoteListenPort)",
                        detailsJson = JSONObject()
                            .put("direction", "INBOUND")
                            .put("peerDeviceId", remoteDeviceId)
                            .put("peerDisplayName", remoteDisplayName)
                            .put("host", remoteHost)
                            .put("port", remoteListenPort)
                            .toString(),
                    )

                    val ack = JSONObject()
                        .put("kind", "HELLO_ACK")
                        .put("id", effectiveSessionId)
                        .put("sessionId", effectiveSessionId)
                        .put("protocolVersion", 1)
                        .put("deviceId", localIdentity.deviceId)
                        .put("displayName", localIdentity.displayName)
                        .put("publicKey", localIdentity.publicKey)
                        .put("serviceName", serviceName)
                        .put("listenPort", listenPort)
                        .put("sentAt", Instant.now().toString())
                    PrintWriter(client.getOutputStream(), true).println(ack.toString())

                    NodicSyncPlugin.emitPeerIdentity(peerIdentityJson)
                    NodicSyncPlugin.emitPeerSession(sessionJson)
                    NodicSyncPlugin.emitLogAdded(logJson)
                    updatePeerState("Session established with $remoteDisplayName")
                    return
                }

                if (kind != "PROBE" && kind != "EVENT" && kind != "EVENT_BATCH" && kind != "SUMMARY") return
                val id = frame.optString("id").takeIf { it.isNotBlank() } ?: frame.optString("requestId", UUID.randomUUID().toString())
                val sentAt = frame.optString("sentAt", Instant.now().toString())
                val from = frame.optString("from", remoteHost)
                val senderDeviceId = frame.optString("deviceId").takeIf { it.isNotBlank() } ?: from
                val senderDisplayName = frame.optString("displayName").takeIf { it.isNotBlank() }
                    ?: connectedPeers[senderDeviceId]?.displayName
                    ?: from
                val senderPublicKey = frame.optString("publicKey").takeIf { it.isNotBlank() }
                    ?: connectedPeers[senderDeviceId]?.publicKey
                    ?: "p256-peer-key"
                val senderListenPort = frame.optInt("listenPort", 0).takeIf { it > 0 }
                    ?: connectedPeers[senderDeviceId]?.port
                    ?: client.port
                val sessionId = frame.optString("sessionId").takeIf { it.isNotBlank() }
                    ?: connectedPeers[senderDeviceId]?.sessionId
                    ?: "session-$senderDeviceId"

                // Ensure sender identity and active session are saved on receiver
                if (senderDeviceId != localIdentity.deviceId) {
                    val endpoint = ConnectedPeerEndpoint(
                        deviceId = senderDeviceId,
                        displayName = senderDisplayName,
                        publicKey = senderPublicKey,
                        serviceName = from,
                        host = remoteHost,
                        port = senderListenPort,
                        sessionId = sessionId,
                        direction = connectedPeers[senderDeviceId]?.direction ?: "INBOUND",
                    )
                    connectedPeers[senderDeviceId] = endpoint

                    val peerIdentityJson = store.upsertPeerIdentity(
                        deviceId = senderDeviceId,
                        displayName = senderDisplayName,
                        publicKey = senderPublicKey,
                        serviceName = from,
                        host = remoteHost,
                        port = senderListenPort,
                        status = "ONLINE",
                    )
                    NodicSyncPlugin.emitPeerIdentity(peerIdentityJson)
                }

                var receivedEventCount = 0
                if (kind == "SUMMARY") {
                    val summaryObj = frame.optJSONObject("summary") ?: frame
                    NodicSyncPlugin.emitSummaryReceived(senderDeviceId, summaryObj.toString())
                } else if (kind == "EVENT_BATCH") {
                    val batchArray = frame.optJSONArray("events")
                    if (batchArray != null) {
                        receivedEventCount = batchArray.length()
                        for (i in 0 until batchArray.length()) {
                            val ev = batchArray.getJSONObject(i)
                            val evId = ev.optString("id", UUID.randomUUID().toString())
                            NodicSyncPlugin.emitReceived(evId, senderDeviceId, sentAt, ev.toString())
                            processReceivedEventForNotification(ev, senderDisplayName)
                        }
                    }
                } else if (kind == "JOIN_REQUEST") {
                    val applicantName = frame.optString("applicantDisplayName", "Applicant")
                    val channelId = frame.optString("channelId").takeIf { it.isNotBlank() }
                    val requestId = frame.optString("requestId", id)
                    if (shouldNotifyEvent(requestId)) {
                        postContentNotification(
                            id = requestId.hashCode(),
                            channel = CHANNEL_MEMBERSHIP,
                            title = "Join Request",
                            body = "$applicantName requested to join channel",
                            route = "/members",
                            channelId = channelId,
                            eventId = requestId,
                            taskId = null,
                        )
                    }
                    val eventJson = frame.optString("eventJson").takeIf { it.isNotBlank() }
                    NodicSyncPlugin.emitReceived(id, senderDeviceId, sentAt, eventJson ?: frame.toString())
                } else {
                    val eventJson = frame.optString("eventJson").takeIf { it.isNotBlank() }
                    receivedEventCount = if (eventJson != null) 1 else 0
                    NodicSyncPlugin.emitReceived(id, senderDeviceId, sentAt, eventJson)
                    if (eventJson != null) {
                        try {
                            processReceivedEventForNotification(JSONObject(eventJson), senderDisplayName)
                        } catch (_: Exception) {}
                    }
                }

                if (senderDeviceId != localIdentity.deviceId) {
                    val sessionJson = store.upsertPeerSession(
                        sessionId = sessionId,
                        peerDeviceId = senderDeviceId,
                        peerDisplayName = senderDisplayName,
                        peerPublicKey = senderPublicKey,
                        peerAddress = remoteHost,
                        peerPort = senderListenPort,
                        direction = connectedPeers[senderDeviceId]?.direction ?: "INBOUND",
                        status = "CONNECTED",
                        eventsSentDelta = 0,
                        eventsReceivedDelta = receivedEventCount.coerceAtLeast(1),
                    )
                    NodicSyncPlugin.emitPeerSession(sessionJson)
                }

                val logJson = store.insertLog(
                    level = "INFO",
                    category = if (kind == "PROBE") "SYNC" else "EVENT",
                    peerDeviceId = senderDeviceId,
                    sessionId = sessionId,
                    message = "Received ${kind.lowercase()} from $senderDisplayName ($remoteHost)",
                    detailsJson = JSONObject()
                        .put("frameId", id)
                        .put("kind", kind)
                        .put("eventsCount", receivedEventCount)
                        .toString(),
                )
                NodicSyncPlugin.emitLogAdded(logJson)

                store.insert(id, senderDeviceId, line)
                val ackFrame = JSONObject()
                    .put("kind", "ACK")
                    .put("id", id)
                    .put("sessionId", sessionId)
                    .put("deviceId", localIdentity.deviceId)
                    .put("displayName", localIdentity.displayName)
                    .put("publicKey", localIdentity.publicKey)
                    .put("listenPort", listenPort)
                PrintWriter(client.getOutputStream(), true).println(ackFrame.toString())

                updateState(
                    currentState.copy(
                        state = "CONNECTED",
                        peerCount = activePeerCount(),
                        lastSyncAt = Instant.now().toString(),
                        detail = "Received ${kind.lowercase()} from $senderDisplayName",
                    ),
                )
            } catch (error: Exception) {
                val logJson = store.insertLog(
                    level = "WARN",
                    category = "SYNC",
                    peerDeviceId = null,
                    sessionId = null,
                    message = "Ignored malformed peer frame: ${error.message}",
                )
                NodicSyncPlugin.emitLogAdded(logJson)
            }
        }
    }

    private fun initiateHandshakeWithPeer(host: String, port: Int, discoveredServiceName: String? = null): Boolean {
        val localIdentity = store.getOrCreateLocalIdentity()
        val sessionId = UUID.randomUUID().toString()
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), 3_500)
                socket.soTimeout = 5_000
                val hello = JSONObject()
                    .put("kind", "HELLO")
                    .put("id", sessionId)
                    .put("sessionId", sessionId)
                    .put("protocolVersion", 1)
                    .put("deviceId", localIdentity.deviceId)
                    .put("displayName", localIdentity.displayName)
                    .put("publicKey", localIdentity.publicKey)
                    .put("serviceName", serviceName)
                    .put("listenPort", listenPort)
                    .put("sentAt", Instant.now().toString())
                PrintWriter(socket.getOutputStream(), true).println(hello.toString())

                val replyLine = BufferedReader(InputStreamReader(socket.getInputStream())).readLine() ?: return false
                val reply = JSONObject(replyLine)
                val kind = reply.optString("kind")
                if (kind != "HELLO_ACK" && kind != "ACK") return false

                val remoteDeviceId = reply.optString("deviceId").takeIf { it.isNotBlank() }
                    ?: discoveredServiceName
                    ?: "peer-$host:$port"
                if (remoteDeviceId == localIdentity.deviceId) return false

                val remoteDisplayName = reply.optString("displayName").takeIf { it.isNotBlank() }
                    ?: "Node-${remoteDeviceId.take(4).uppercase()}"
                val remotePublicKey = reply.optString("publicKey").takeIf { it.isNotBlank() }
                    ?: "p256-peer-key"
                val remoteServiceName = reply.optString("serviceName").takeIf { it.isNotBlank() }
                    ?: discoveredServiceName
                    ?: "nodic-${remoteDeviceId.take(8)}"
                val remotePort = reply.optInt("listenPort", port).takeIf { it > 0 } ?: port
                val agreedSessionId = reply.optString("sessionId").takeIf { it.isNotBlank() } ?: sessionId

                val endpoint = ConnectedPeerEndpoint(
                    deviceId = remoteDeviceId,
                    displayName = remoteDisplayName,
                    publicKey = remotePublicKey,
                    serviceName = remoteServiceName,
                    host = host,
                    port = remotePort,
                    sessionId = agreedSessionId,
                    direction = "OUTBOUND",
                )
                connectedPeers[remoteDeviceId] = endpoint

                val peerIdentityJson = store.upsertPeerIdentity(
                    deviceId = remoteDeviceId,
                    displayName = remoteDisplayName,
                    publicKey = remotePublicKey,
                    serviceName = remoteServiceName,
                    host = host,
                    port = remotePort,
                    status = "ONLINE",
                )
                val sessionJson = store.upsertPeerSession(
                    sessionId = agreedSessionId,
                    peerDeviceId = remoteDeviceId,
                    peerDisplayName = remoteDisplayName,
                    peerPublicKey = remotePublicKey,
                    peerAddress = host,
                    peerPort = remotePort,
                    direction = "OUTBOUND",
                    status = "CONNECTED",
                )
                val logJson = store.insertLog(
                    level = "INFO",
                    category = "SESSION",
                    peerDeviceId = remoteDeviceId,
                    sessionId = agreedSessionId,
                    message = "Established session with $remoteDisplayName ($host:$remotePort)",
                    detailsJson = JSONObject()
                        .put("direction", "OUTBOUND")
                        .put("peerDeviceId", remoteDeviceId)
                        .put("peerDisplayName", remoteDisplayName)
                        .put("host", host)
                        .put("port", remotePort)
                        .toString(),
                )

                NodicSyncPlugin.emitPeerIdentity(peerIdentityJson)
                NodicSyncPlugin.emitPeerSession(sessionJson)
                NodicSyncPlugin.emitLogAdded(logJson)
                updatePeerState("Connected to $remoteDisplayName")
                true
            }
        } catch (error: Exception) {
            val logJson = store.insertLog(
                level = "WARN",
                category = "HANDSHAKE",
                peerDeviceId = discoveredServiceName,
                sessionId = sessionId,
                message = "Handshake with $host:$port failed: ${error.message}",
            )
            NodicSyncPlugin.emitLogAdded(logJson)
            false
        }
    }

    private fun collectTargetEndpoints(): List<ConnectedPeerEndpoint> {
        val targets = LinkedHashMap<String, ConnectedPeerEndpoint>()
        for (peer in connectedPeers.values) {
            targets["${peer.host}:${peer.port}"] = peer
        }
        for ((name, info) in nsdPeers.entries) {
            val host = info.host?.hostAddress ?: continue
            val key = "$host:${info.port}"
            if (!targets.containsKey(key)) {
                targets[key] = ConnectedPeerEndpoint(
                    deviceId = name,
                    displayName = name,
                    publicKey = "p256-peer-key",
                    serviceName = name,
                    host = host,
                    port = info.port,
                    sessionId = UUID.randomUUID().toString(),
                    direction = "OUTBOUND",
                )
            }
        }
        return targets.values.toList()
    }

    private fun sendFrame(id: String, eventJson: String?): Boolean {
        val snapshot = collectTargetEndpoints()
        if (snapshot.isEmpty()) {
            val logJson = store.insertLog(
                level = "WARN",
                category = "SYNC",
                peerDeviceId = null,
                sessionId = null,
                message = "No connected peers available; event $id queued in local database",
            )
            NodicSyncPlugin.emitLogAdded(logJson)
            updateState(
                currentState.copy(
                    state = "SEARCHING",
                    pendingEventCount = currentState.pendingEventCount + 1,
                    detail = "No peer available; event saved locally",
                ),
            )
            return false
        }

        val localIdentity = store.getOrCreateLocalIdentity()
        updateState(
            currentState.copy(
                pendingEventCount = currentState.pendingEventCount + 1,
                detail = "Sending to ${snapshot.size} peer(s)",
            ),
        )
        snapshot.forEach { peer ->
            executor.execute {
                try {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(peer.host, peer.port), 3_000)
                        socket.soTimeout = 5_000
                        val kind = if (eventJson == null) "PROBE" else "EVENT"
                        val frame = JSONObject()
                            .put("kind", kind)
                            .put("id", id)
                            .put("sessionId", peer.sessionId)
                            .put("from", serviceName)
                            .put("deviceId", localIdentity.deviceId)
                            .put("displayName", localIdentity.displayName)
                            .put("publicKey", localIdentity.publicKey)
                            .put("listenPort", listenPort)
                            .put("sentAt", Instant.now().toString())
                        if (eventJson != null) frame.put("eventJson", eventJson)
                        PrintWriter(socket.getOutputStream(), true).println(frame.toString())
                        val ackLine = BufferedReader(InputStreamReader(socket.getInputStream())).readLine()
                        if (ackLine != null) {
                            val ack = JSONObject(ackLine)
                            if (ack.optString("id") == id) {
                                val remoteDeviceId = ack.optString("deviceId").takeIf { it.isNotBlank() } ?: peer.deviceId
                                val remoteDisplayName = ack.optString("displayName").takeIf { it.isNotBlank() } ?: peer.displayName
                                val remotePublicKey = ack.optString("publicKey").takeIf { it.isNotBlank() } ?: peer.publicKey
                                val sessionJson = store.upsertPeerSession(
                                    sessionId = peer.sessionId,
                                    peerDeviceId = remoteDeviceId,
                                    peerDisplayName = remoteDisplayName,
                                    peerPublicKey = remotePublicKey,
                                    peerAddress = peer.host,
                                    peerPort = peer.port,
                                    direction = peer.direction,
                                    status = "CONNECTED",
                                    eventsSentDelta = 1,
                                    eventsReceivedDelta = 0,
                                )
                                val logJson = store.insertLog(
                                    level = "INFO",
                                    category = if (eventJson == null) "SYNC" else "EVENT",
                                    peerDeviceId = remoteDeviceId,
                                    sessionId = peer.sessionId,
                                    message = "Peer $remoteDisplayName acknowledged ${kind.lowercase()} (${id.take(8)})",
                                )
                                NodicSyncPlugin.emitPeerSession(sessionJson)
                                NodicSyncPlugin.emitLogAdded(logJson)
                                updateState(
                                    currentState.copy(
                                        state = "CONNECTED",
                                        peerCount = activePeerCount(),
                                        pendingEventCount = 0,
                                        lastSyncAt = Instant.now().toString(),
                                        detail = "Peer $remoteDisplayName acknowledged ${kind.lowercase()}",
                                    ),
                                )
                            }
                        }
                    }
                } catch (error: Exception) {
                    val logJson = store.insertLog(
                        level = "ERROR",
                        category = "SYNC",
                        peerDeviceId = peer.deviceId,
                        sessionId = peer.sessionId,
                        message = "Failed sending to ${peer.displayName} (${peer.host}:${peer.port}): ${error.message}",
                    )
                    NodicSyncPlugin.emitLogAdded(logJson)
                    updateState(currentState.copy(detail = "Peer send failed: ${error.message}"))
                }
            }
        }
        return true
    }

    private fun sendBatchFrame(id: String, batchJson: String): Boolean {
        val snapshot = collectTargetEndpoints()
        if (snapshot.isEmpty()) return false
        val localIdentity = store.getOrCreateLocalIdentity()
        val eventsArray = JSONArray(batchJson)
        val batchCount = eventsArray.length()

        snapshot.forEach { peer ->
            executor.execute {
                try {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(peer.host, peer.port), 3_000)
                        socket.soTimeout = 5_000
                        val frame = JSONObject()
                            .put("kind", "EVENT_BATCH")
                            .put("id", id)
                            .put("sessionId", peer.sessionId)
                            .put("from", serviceName)
                            .put("deviceId", localIdentity.deviceId)
                            .put("displayName", localIdentity.displayName)
                            .put("publicKey", localIdentity.publicKey)
                            .put("listenPort", listenPort)
                            .put("sentAt", Instant.now().toString())
                            .put("events", eventsArray)
                        PrintWriter(socket.getOutputStream(), true).println(frame.toString())
                        val ackLine = BufferedReader(InputStreamReader(socket.getInputStream())).readLine()
                        if (ackLine != null && JSONObject(ackLine).optString("id") == id) {
                            val sessionJson = store.upsertPeerSession(
                                sessionId = peer.sessionId,
                                peerDeviceId = peer.deviceId,
                                peerDisplayName = peer.displayName,
                                peerPublicKey = peer.publicKey,
                                peerAddress = peer.host,
                                peerPort = peer.port,
                                direction = peer.direction,
                                status = "CONNECTED",
                                eventsSentDelta = batchCount,
                                eventsReceivedDelta = 0,
                            )
                            val logJson = store.insertLog(
                                level = "INFO",
                                category = "SYNC",
                                peerDeviceId = peer.deviceId,
                                sessionId = peer.sessionId,
                                message = "Synced batch of $batchCount event(s) with ${peer.displayName}",
                            )
                            NodicSyncPlugin.emitPeerSession(sessionJson)
                            NodicSyncPlugin.emitLogAdded(logJson)
                            updateState(
                                currentState.copy(
                                    state = "CONNECTED",
                                    peerCount = activePeerCount(),
                                    lastSyncAt = Instant.now().toString(),
                                    detail = "Synced $batchCount event(s) with ${peer.displayName}",
                                ),
                            )
                        }
                    }
                } catch (error: Exception) {
                    val logJson = store.insertLog(
                        level = "WARN",
                        category = "SYNC",
                        peerDeviceId = peer.deviceId,
                        sessionId = peer.sessionId,
                        message = "Batch sync failed with ${peer.displayName}: ${error.message}",
                    )
                    NodicSyncPlugin.emitLogAdded(logJson)
                    updateState(currentState.copy(detail = "Batch send failed: ${error.message}"))
                }
            }
        }
        return true
    }

    private fun sendSummaryFrame(id: String, summaryJson: String): Boolean {
        val snapshot = collectTargetEndpoints()
        if (snapshot.isEmpty()) return false
        val localIdentity = store.getOrCreateLocalIdentity()
        val summaryObj = JSONObject(summaryJson)

        snapshot.forEach { peer ->
            executor.execute {
                try {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(peer.host, peer.port), 3_000)
                        socket.soTimeout = 5_000
                        val frame = JSONObject()
                            .put("kind", "SUMMARY")
                            .put("id", id)
                            .put("requestId", id)
                            .put("sessionId", peer.sessionId)
                            .put("from", serviceName)
                            .put("deviceId", localIdentity.deviceId)
                            .put("displayName", localIdentity.displayName)
                            .put("publicKey", localIdentity.publicKey)
                            .put("listenPort", listenPort)
                            .put("sentAt", Instant.now().toString())
                            .put("summary", summaryObj)
                        PrintWriter(socket.getOutputStream(), true).println(frame.toString())
                    }
                } catch (error: Exception) {
                    val logJson = store.insertLog(
                        level = "WARN",
                        category = "SYNC",
                        peerDeviceId = peer.deviceId,
                        sessionId = peer.sessionId,
                        message = "Summary send failed with ${peer.displayName}: ${error.message}",
                    )
                    NodicSyncPlugin.emitLogAdded(logJson)
                }
            }
        }
        return true
    }

    private fun reannounceIdentity() {
        val snapshot = collectTargetEndpoints()
        for (peer in snapshot) {
            executor.execute {
                initiateHandshakeWithPeer(peer.host, peer.port, peer.serviceName)
            }
        }
    }

    private val registrationListener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(info: NsdServiceInfo) {
            registered = true
            serviceName = info.serviceName
        }
        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            updateState( currentState.copy(state = "ERROR", detail = "NSD registration failed ($errorCode)"))
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
                    val host = serviceInfo.host?.hostAddress ?: return
                    nsdPeers[serviceInfo.serviceName] = serviceInfo
                    val logJson = store.insertLog(
                        level = "INFO",
                        category = "DISCOVERY",
                        peerDeviceId = serviceInfo.serviceName,
                        sessionId = null,
                        message = "Discovered nearby Nodic peer ${serviceInfo.serviceName} at $host:${serviceInfo.port}",
                    )
                    NodicSyncPlugin.emitLogAdded(logJson)
                    updatePeerState()
                    executor.execute {
                        initiateHandshakeWithPeer(host, serviceInfo.port, serviceInfo.serviceName)
                    }
                }
            })
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            nsdPeers.remove(info.serviceName)
            val removedPeer = connectedPeers.values.firstOrNull { it.serviceName == info.serviceName }
            if (removedPeer != null) {
                connectedPeers.remove(removedPeer.deviceId)
            }
            val closedSessions = store.markPeerDisconnectedByServiceOrDevice(removedPeer?.deviceId ?: info.serviceName)
            for (s in closedSessions) {
                NodicSyncPlugin.emitPeerSession(s)
            }
            val logJson = store.insertLog(
                level = "INFO",
                category = "SESSION",
                peerDeviceId = removedPeer?.deviceId ?: info.serviceName,
                sessionId = removedPeer?.sessionId,
                message = "Peer ${removedPeer?.displayName ?: info.serviceName} disconnected from local Wi-Fi",
            )
            NodicSyncPlugin.emitLogAdded(logJson)
            updatePeerState()
        }
        override fun onDiscoveryStopped(type: String) { discovering = false }
        override fun onStartDiscoveryFailed(type: String, errorCode: Int) {
            discovering = false
            updateState(currentState.copy(state = "ERROR", detail = "NSD discovery failed ($errorCode)"))
        }
        override fun onStopDiscoveryFailed(type: String, errorCode: Int) { discovering = false }
    }

    private fun activePeerCount(): Int {
        val uniqueEndpoints = HashSet<String>()
        for (p in connectedPeers.values) uniqueEndpoints.add("${p.host}:${p.port}")
        for (p in nsdPeers.values) {
            val h = p.host?.hostAddress ?: continue
            uniqueEndpoints.add("$h:${p.port}")
        }
        return uniqueEndpoints.size
    }

    private fun updatePeerState(customDetail: String? = null) {
        val count = activePeerCount()
        updateState(
            currentState.copy(
                state = if (count == 0) "SEARCHING" else "CONNECTED",
                peerCount = count,
                detail = customDetail ?: if (count == 0) "No nearby Nodic nodes yet" else "$count nearby Nodic node(s) connected",
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
        unregisterNetworkCallback()
        try { if (discovering) nsdManager.stopServiceDiscovery(discoveryListener) } catch (_: Exception) {}
        try { if (registered) nsdManager.unregisterService(registrationListener) } catch (_: Exception) {}
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        nsdPeers.clear()
        connectedPeers.clear()
        store.closeAllActiveSessions()
        val logJson = store.insertLog(
            level = "INFO",
            category = "SESSION",
            peerDeviceId = null,
            sessionId = null,
            message = "Nodic networking stopped and all active peer sessions closed",
        )
        NodicSyncPlugin.emitLogAdded(logJson)
        currentState = SyncState()
        NodicSyncPlugin.emitStatus(currentState)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun restartNsd() {
        try {
            if (discovering) {
                nsdManager.stopServiceDiscovery(discoveryListener)
                discovering = false
            }
        } catch (_: Exception) {}
        try {
            if (registered) {
                nsdManager.unregisterService(registrationListener)
                registered = false
            }
        } catch (_: Exception) {}
        if (listenPort > 0) {
            registerService(listenPort)
            discoverServices()
        }
    }

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        connectivityManager = cm

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                handleNetworkStateChange("Network available")
            }

            override fun onLost(network: Network) {
                handleNetworkLost()
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                handleNetworkStateChange("Link properties changed")
            }
        }
        networkCallback = callback
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(callback)
            } else {
                val request = NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                cm.registerNetworkCallback(request, callback)
            }
        } catch (e: Exception) {
            val logObj = store.insertLog(
                level = "WARN",
                category = "DISCOVERY",
                peerDeviceId = null,
                sessionId = null,
                message = "Could not register network callback: ${e.message}",
            )
            NodicSyncPlugin.emitLogAdded(logObj)
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        } catch (_: Exception) {}
        networkCallback = null
    }

    private fun handleNetworkStateChange(reason: String) {
        executor.execute {
            val currentIp = resolveLocalIpv4Address()
            if (currentIp == null) {
                handleNetworkLost()
                return@execute
            }

            if (currentIp != lastResolvedIp && serverSocket != null) {
                val oldIp = lastResolvedIp
                lastResolvedIp = currentIp
                val newEndpoint = "$currentIp:$listenPort"

                val logObj = store.insertLog(
                    level = "INFO",
                    category = "DISCOVERY",
                    peerDeviceId = null,
                    sessionId = null,
                    message = "Network state recovery ($reason): IP changed from $oldIp to $currentIp, re-announcing NSD",
                    detailsJson = JSONObject().put("endpoint", newEndpoint).toString(),
                )
                NodicSyncPlugin.emitLogAdded(logObj)

                updateState(
                    currentState.copy(
                        state = "SEARCHING",
                        detail = "Listening on $newEndpoint",
                        localEndpoint = newEndpoint,
                    ),
                )
                restartNsd()
            }
        }
    }

    private fun handleNetworkLost() {
        updateState(
            currentState.copy(
                state = "OFFLINE",
                detail = "Local Wi-Fi disconnected. Waiting for connection...",
            ),
        )
        val logObj = store.insertLog(
            level = "WARN",
            category = "DISCOVERY",
            peerDeviceId = null,
            sessionId = null,
            message = "Local network connection lost",
        )
        NodicSyncPlugin.emitLogAdded(logObj)
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)

            val fgChannel = NotificationChannel(
                CHANNEL_FOREGROUND,
                "Nodic Background Sync",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps Nodic network and discovery active in the background"
                setShowBadge(false)
            }

            val msgChannel = NotificationChannel(
                CHANNEL_MESSAGES,
                "Chat Messages",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Notifications for incoming chat messages"
                enableVibration(true)
                setShowBadge(true)
            }

            val taskChannel = NotificationChannel(
                CHANNEL_TASKS,
                "Task Updates",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Notifications for task assignments, updates, and completions"
                enableVibration(true)
                setShowBadge(true)
            }

            val memberChannel = NotificationChannel(
                CHANNEL_MEMBERSHIP,
                "Membership & Invites",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Notifications for join requests and member approvals"
                enableVibration(true)
                setShowBadge(true)
            }

            nm.createNotificationChannels(listOf(fgChannel, msgChannel, taskChannel, memberChannel))
        }
    }

    private fun buildNotification(detail: String): android.app.Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("route", "/network")
        }
        val openPendingIntent = PendingIntent.getActivity(
            this,
            1001,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val pauseIntent = Intent(this, NodicSyncService::class.java).apply {
            action = ACTION_STOP
        }
        val pausePendingIntent = PendingIntent.getService(
            this,
            1002,
            pauseIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_FOREGROUND)
            .setSmallIcon(R.drawable.ic_stat_nodic)
            .setContentTitle("Nodic network is active")
            .setContentText(detail)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(0, "Open", openPendingIntent)
            .addAction(0, "Pause", pausePendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun shouldNotifyEvent(eventId: String): Boolean {
        synchronized(notifiedEventIds) {
            if (notifiedEventIds.contains(eventId)) return false
            if (notifiedEventIds.size >= 1000) {
                val it = notifiedEventIds.iterator()
                if (it.hasNext()) {
                    it.next()
                    it.remove()
                }
            }
            notifiedEventIds.add(eventId)
            return true
        }
    }

    private fun postContentNotification(
        id: Int,
        channel: String,
        title: String,
        body: String,
        route: String,
        channelId: String?,
        eventId: String?,
        taskId: String?,
    ) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("route", route)
            if (channelId != null) putExtra("channelId", channelId)
            if (eventId != null) putExtra("eventId", eventId)
            if (taskId != null) putExtra("taskId", taskId)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_nodic)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        getSystemService(NotificationManager::class.java).notify(id, notification)
    }

    private fun processReceivedEventForNotification(ev: JSONObject, senderDisplayName: String) {
        val eventId = ev.optString("id")
        if (eventId.isBlank()) return
        if (!shouldNotifyEvent(eventId)) return

        val localIdentity = store.getOrCreateLocalIdentity()
        val authorDeviceId = ev.optString("authorDeviceId")
        if (authorDeviceId == localIdentity.deviceId) return

        val type = ev.optString("type")
        val channelId = ev.optString("channelId").takeIf { it.isNotBlank() }
        val payload = ev.optJSONObject("payload") ?: JSONObject()

        when (type) {
            "MESSAGE_POSTED" -> {
                if (NodicSyncPlugin.isAppInForeground && NodicSyncPlugin.activeRoute == "/chat") {
                    return
                }
                val text = payload.optString("text")
                val sender = senderDisplayName.ifBlank { "Nodic member" }
                postContentNotification(
                    id = eventId.hashCode(),
                    channel = CHANNEL_MESSAGES,
                    title = sender,
                    body = text.ifBlank { "Sent a message" },
                    route = "/chat",
                    channelId = channelId,
                    eventId = eventId,
                    taskId = null,
                )
            }
            "TASK_CREATED" -> {
                val assignee = payload.optString("assigneeDeviceId")
                val title = payload.optString("title", "Untitled task")
                val sender = senderDisplayName.ifBlank { "Nodic member" }
                val taskId = ev.optString("entityId").ifBlank { payload.optString("id") }

                if (assignee == localIdentity.deviceId) {
                    postContentNotification(
                        id = eventId.hashCode(),
                        channel = CHANNEL_TASKS,
                        title = "Task Assigned",
                        body = "$sender assigned you: '$title'",
                        route = "/board",
                        channelId = channelId,
                        eventId = eventId,
                        taskId = taskId,
                    )
                }
            }
            "TASK_MUTATED" -> {
                val status = payload.optString("status")
                val assignee = payload.optString("assigneeDeviceId")
                val title = payload.optString("title", "task")
                val sender = senderDisplayName.ifBlank { "Nodic member" }
                val taskId = ev.optString("entityId").ifBlank { payload.optString("id") }

                if (status == "DONE") {
                    postContentNotification(
                        id = eventId.hashCode(),
                        channel = CHANNEL_TASKS,
                        title = "Task Completed",
                        body = "$sender completed: '$title'",
                        route = "/board",
                        channelId = channelId,
                        eventId = eventId,
                        taskId = taskId,
                    )
                } else if (assignee == localIdentity.deviceId) {
                    postContentNotification(
                        id = eventId.hashCode(),
                        channel = CHANNEL_TASKS,
                        title = "Task Updated",
                        body = "$sender updated: '$title'",
                        route = "/board",
                        channelId = channelId,
                        eventId = eventId,
                        taskId = taskId,
                    )
                }
            }
            "MEMBER_ADDED", "MEMBER_JOINED" -> {
                val memberName = payload.optString("displayName", senderDisplayName)
                postContentNotification(
                    id = eventId.hashCode(),
                    channel = CHANNEL_MEMBERSHIP,
                    title = "New Member",
                    body = "$memberName joined the channel",
                    route = "/members",
                    channelId = channelId,
                    eventId = eventId,
                    taskId = null,
                )
            }
        }
    }

    override fun onDestroy() {
        liveService = null
        unregisterNetworkCallback()
        try { store.close() } catch (_: Exception) {}
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "dev.nodic.app.sync.START"
        const val ACTION_STOP = "dev.nodic.app.sync.STOP"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_DEVICE_ID = "deviceId"
        const val EXTRA_PUBLIC_KEY = "publicKey"
        const val CHANNEL_FOREGROUND = "nodic_foreground"
        const val CHANNEL_MESSAGES = "nodic_messages"
        const val CHANNEL_TASKS = "nodic_tasks"
        const val CHANNEL_MEMBERSHIP = "nodic_membership"
        private const val SERVICE_TYPE = "_nodic._tcp."
        private const val NOTIFICATION_ID = 4101
        private const val MAX_FRAME_CHARS = 262_144

        @Volatile var currentState = SyncState()
            private set
        @Volatile private var liveService: NodicSyncService? = null

        fun broadcastProbe(id: String): Boolean = liveService?.sendFrame(id, null) ?: false
        fun broadcastEvent(id: String, eventJson: String): Boolean = liveService?.sendFrame(id, eventJson) ?: false
        fun broadcastBatch(id: String, batchJson: String): Boolean = liveService?.sendBatchFrame(id, batchJson) ?: false
        fun broadcastSummary(id: String, summaryJson: String): Boolean = liveService?.sendSummaryFrame(id, summaryJson) ?: false
        fun connectToPeer(host: String, port: Int): Boolean = liveService?.initiateHandshakeWithPeer(host, port, null) ?: false
        fun notifyIdentityUpdated() {
            liveService?.reannounceIdentity()
        }
    }
}
