package dev.nodic.app.sync

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.UUID

data class LocalNodeIdentity(
    val deviceId: String,
    val displayName: String,
    val publicKey: String,
    val keystoreAlias: String,
)

class PhaseZeroStore(private val appContext: Context) : SQLiteOpenHelper(appContext, "nodic-phase0.db", null, 3) {
    override fun onCreate(db: SQLiteDatabase) {
        createTables(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        createTables(db)
    }

    private fun createTables(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS phase_zero_events (
                id TEXT PRIMARY KEY NOT NULL,
                from_peer TEXT NOT NULL,
                payload TEXT NOT NULL,
                received_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS workspace_channels (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                lead_device_id TEXT NOT NULL,
                genesis_event_id TEXT NOT NULL,
                key_version INTEGER NOT NULL DEFAULT 1,
                channel_key TEXT,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS workspace_events (
                id TEXT PRIMARY KEY NOT NULL,
                channel_id TEXT NOT NULL,
                author_device_id TEXT NOT NULL,
                author_sequence INTEGER NOT NULL,
                lamport_clock INTEGER NOT NULL,
                type TEXT NOT NULL,
                event_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS local_identity (
                device_id TEXT PRIMARY KEY NOT NULL,
                display_name TEXT NOT NULL,
                public_signing_key TEXT NOT NULL,
                keystore_alias TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS peer_identities (
                device_id TEXT PRIMARY KEY NOT NULL,
                display_name TEXT NOT NULL,
                public_signing_key TEXT NOT NULL,
                service_name TEXT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'ONLINE',
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS peer_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                peer_device_id TEXT NOT NULL,
                peer_display_name TEXT NOT NULL,
                peer_public_key TEXT NOT NULL,
                peer_address TEXT NOT NULL,
                peer_port INTEGER NOT NULL,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL,
                ended_at INTEGER,
                events_sent INTEGER NOT NULL DEFAULT 0,
                events_received INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sync_logs (
                id TEXT PRIMARY KEY NOT NULL,
                level TEXT NOT NULL,
                category TEXT NOT NULL,
                peer_device_id TEXT,
                session_id TEXT,
                message TEXT NOT NULL,
                details_json TEXT,
                created_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS paired_devices (
                device_id TEXT PRIMARY KEY NOT NULL,
                nodic_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                public_signing_key TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                pairing_state TEXT NOT NULL,
                paired_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS pairing_requests (
                request_id TEXT PRIMARY KEY NOT NULL,
                from_device_id TEXT NOT NULL,
                from_nodic_id TEXT NOT NULL,
                from_display_name TEXT NOT NULL,
                from_public_key TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS secure_kv (
                k TEXT PRIMARY KEY NOT NULL,
                v TEXT NOT NULL
            )
            """.trimIndent(),
        )
    }

    // ---- Pairing persistence (paired_devices / pairing_requests) ----

    @Synchronized
    fun upsertPairedDevice(
        deviceId: String,
        nodicId: String,
        displayName: String,
        publicKey: String,
        host: String,
        port: Int,
        pairingState: String,
        pairedAt: Long = System.currentTimeMillis(),
        updatedAt: Long = System.currentTimeMillis(),
    ) {
        val db = writableDatabase
        createTables(db)
        db.execSQL(
            """
            INSERT INTO paired_devices (device_id, nodic_id, display_name, public_signing_key, host, port, pairing_state, paired_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                nodic_id = excluded.nodic_id,
                display_name = excluded.display_name,
                public_signing_key = excluded.public_signing_key,
                host = excluded.host,
                port = excluded.port,
                pairing_state = excluded.pairing_state,
                updated_at = excluded.updated_at
            """.trimIndent(),
            arrayOf<Any>(deviceId, nodicId, displayName, publicKey, host, port, pairingState, pairedAt, updatedAt),
        )
    }

    @Synchronized
    fun setPairingState(deviceId: String, pairingState: String) {
        val db = writableDatabase
        createTables(db)
        db.execSQL(
            "UPDATE paired_devices SET pairing_state = ?, updated_at = ? WHERE device_id = ?",
            arrayOf<Any>(pairingState, System.currentTimeMillis(), deviceId),
        )
    }

    @Synchronized
    fun isPaired(deviceId: String): Boolean {
        val db = writableDatabase
        createTables(db)
        db.rawQuery(
            "SELECT 1 FROM paired_devices WHERE device_id = ? AND pairing_state = 'PAIRED' LIMIT 1",
            arrayOf(deviceId),
        ).use { return it.moveToFirst() }
    }

    /** Matches an NSD service name (nodic-<first 8 of device id>) against accepted pairings. */
    @Synchronized
    fun isPairedByServiceName(serviceName: String): Boolean {
        val db = writableDatabase
        createTables(db)
        db.rawQuery(
            "SELECT 1 FROM paired_devices WHERE pairing_state = 'PAIRED' AND (nodic_id = ? OR 'nodic-' || lower(substr(device_id, 1, 8)) = lower(?)) LIMIT 1",
            arrayOf(serviceName, serviceName),
        ).use { return it.moveToFirst() }
    }

    @Synchronized
    fun getPairedDevices(onlyPaired: Boolean = false): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        val sql = "SELECT device_id, nodic_id, display_name, public_signing_key, host, port, pairing_state, paired_at, updated_at FROM paired_devices" +
            (if (onlyPaired) " WHERE pairing_state = 'PAIRED'" else "") + " ORDER BY updated_at DESC"
        db.rawQuery(sql, null).use { c ->
            while (c.moveToNext()) {
                arr.put(
                    JSONObject()
                        .put("deviceId", c.getString(0))
                        .put("nodicId", c.getString(1))
                        .put("displayName", c.getString(2))
                        .put("publicSigningKey", c.getString(3))
                        .put("host", c.getString(4))
                        .put("port", c.getInt(5))
                        .put("pairingState", c.getString(6))
                        .put("pairedAt", Instant.ofEpochMilli(c.getLong(7)).toString())
                        .put("updatedAt", Instant.ofEpochMilli(c.getLong(8)).toString()),
                )
            }
        }
        return arr
    }

    @Synchronized
    fun upsertPairingRequest(
        requestId: String,
        fromDeviceId: String,
        fromNodicId: String,
        fromDisplayName: String,
        fromPublicKey: String,
        host: String,
        port: Int,
        direction: String,
        status: String,
        createdAt: Long = System.currentTimeMillis(),
    ) {
        val db = writableDatabase
        createTables(db)
        db.execSQL(
            """
            INSERT INTO pairing_requests (request_id, from_device_id, from_nodic_id, from_display_name, from_public_key, host, port, direction, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                status = excluded.status,
                host = excluded.host,
                port = excluded.port,
                from_display_name = excluded.from_display_name
            """.trimIndent(),
            arrayOf<Any>(requestId, fromDeviceId, fromNodicId, fromDisplayName, fromPublicKey, host, port, direction, status, createdAt),
        )
    }

    @Synchronized
    fun setPairingRequestStatus(requestId: String, status: String) {
        val db = writableDatabase
        createTables(db)
        db.execSQL("UPDATE pairing_requests SET status = ? WHERE request_id = ?", arrayOf<Any>(status, requestId))
    }

    @Synchronized
    fun getPairingRequest(requestId: String): JSONObject? {
        val db = writableDatabase
        createTables(db)
        db.rawQuery(
            "SELECT request_id, from_device_id, from_nodic_id, from_display_name, from_public_key, host, port, direction, status, created_at FROM pairing_requests WHERE request_id = ?",
            arrayOf(requestId),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return pairingRequestRow(c)
        }
    }

    @Synchronized
    fun getPairingRequests(): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        db.rawQuery(
            "SELECT request_id, from_device_id, from_nodic_id, from_display_name, from_public_key, host, port, direction, status, created_at FROM pairing_requests ORDER BY created_at DESC",
            null,
        ).use { c -> while (c.moveToNext()) arr.put(pairingRequestRow(c)) }
        return arr
    }

    private fun pairingRequestRow(c: android.database.Cursor): JSONObject = JSONObject()
        .put("requestId", c.getString(0))
        .put("fromDeviceId", c.getString(1))
        .put("fromNodicId", c.getString(2))
        .put("fromDisplayName", c.getString(3))
        .put("fromPublicKey", c.getString(4))
        .put("host", c.getString(5))
        .put("port", c.getInt(6))
        .put("direction", c.getString(7))
        .put("status", c.getString(8))
        .put("createdAt", Instant.ofEpochMilli(c.getLong(9)).toString())

    // ---- Keystore-wrapped secret storage (survives WebView storage loss / app kill) ----

    private fun secretKey(): javax.crypto.SecretKey? = try {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "nodic-secure-kv-key"
        if (!ks.containsAlias(alias)) {
            val gen = javax.crypto.KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            gen.generateKey()
        }
        ks.getKey(alias, null) as? javax.crypto.SecretKey
    } catch (_: Exception) {
        null
    }

    @Synchronized
    fun secureSet(key: String, value: String) {
        val db = writableDatabase
        createTables(db)
        var stored = "plain:$value"
        val sk = secretKey()
        if (sk != null) {
            try {
                val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, sk)
                val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                stored = "enc:" + Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
            } catch (_: Exception) {}
        }
        db.execSQL("INSERT OR REPLACE INTO secure_kv (k, v) VALUES (?, ?)", arrayOf<Any>(key, stored))
    }

    @Synchronized
    fun secureGet(key: String): String? {
        val db = writableDatabase
        createTables(db)
        val raw = db.rawQuery("SELECT v FROM secure_kv WHERE k = ?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: return null
        if (raw.startsWith("plain:")) return raw.removePrefix("plain:")
        if (!raw.startsWith("enc:")) return null
        return try {
            val parts = raw.split(":")
            val iv = Base64.decode(parts[1], Base64.NO_WRAP)
            val ct = Base64.decode(parts[2], Base64.NO_WRAP)
            val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey(), javax.crypto.spec.GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun verify(): Boolean {
        writableDatabase.rawQuery("SELECT 1", null).use { return it.moveToFirst() }
    }

    @Synchronized
    fun getOrCreateLocalIdentity(preferredDisplayName: String? = null): LocalNodeIdentity {
        val prefs = appContext.getSharedPreferences("nodic_identity", Context.MODE_PRIVATE)
        val db = writableDatabase
        createTables(db)

        // 1. Check SQLite local_identity first
        db.rawQuery("SELECT device_id, display_name, public_signing_key, keystore_alias FROM local_identity LIMIT 1", null).use { cursor ->
            if (cursor.moveToFirst()) {
                val deviceId = cursor.getString(0)
                val existingName = cursor.getString(1)
                val existingKey = cursor.getString(2)
                val alias = cursor.getString(3)
                val finalKey = if (existingKey.isBlank() || existingKey == "phase-0-key-not-generated" || existingKey == "p256-mock-key") {
                    ensureKeystorePublicKey(alias)
                } else {
                    existingKey
                }
                val finalName = if (!preferredDisplayName.isNullOrBlank() && preferredDisplayName != "Nodic member") {
                    preferredDisplayName.trim()
                } else {
                    existingName
                }
                if (finalName != existingName || finalKey != existingKey) {
                    db.execSQL(
                        "UPDATE local_identity SET display_name = ?, public_signing_key = ?, updated_at = ? WHERE device_id = ?",
                        arrayOf<Any>(finalName, finalKey, System.currentTimeMillis(), deviceId),
                    )
                }
                prefs.edit()
                    .putString("device_id", deviceId)
                    .putString("display_name", finalName)
                    .putString("public_key", finalKey)
                    .apply()
                return LocalNodeIdentity(deviceId, finalName, finalKey, alias)
            }
        }

        // 2. Otherwise initialize from SharedPreferences or generate fresh
        val deviceId = prefs.getString("device_id", null) ?: UUID.randomUUID().toString()
        val alias = "nodic-device-key"
        val publicKey = ensureKeystorePublicKey(alias)
        val defaultName = preferredDisplayName?.trim()?.takeIf { it.isNotEmpty() && it != "Nodic member" }
            ?: prefs.getString("display_name", null)?.takeIf { it.isNotBlank() }
            ?: "Node-${deviceId.take(4).uppercase()}"

        val now = System.currentTimeMillis()
        db.execSQL(
            """
            INSERT OR REPLACE INTO local_identity (device_id, display_name, public_signing_key, keystore_alias, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf<Any>(deviceId, defaultName, publicKey, alias, now),
        )
        prefs.edit()
            .putString("device_id", deviceId)
            .putString("display_name", defaultName)
            .putString("public_key", publicKey)
            .apply()

        insertLog(
            level = "INFO",
            category = "IDENTITY",
            peerDeviceId = deviceId,
            sessionId = null,
            message = "Initialized local device identity ($defaultName)",
            detailsJson = JSONObject().put("deviceId", deviceId).put("keystoreAlias", alias).toString(),
        )

        return LocalNodeIdentity(deviceId, defaultName, publicKey, alias)
    }

    @Synchronized
    fun updateLocalIdentity(deviceId: String?, displayName: String, publicKey: String? = null): LocalNodeIdentity {
        val current = getOrCreateLocalIdentity()
        val finalDeviceId = deviceId?.takeIf { it.isNotBlank() } ?: current.deviceId
        val finalName = displayName.trim().takeIf { it.isNotEmpty() } ?: current.displayName
        val finalKey = publicKey?.takeIf { it.isNotBlank() && it != "p256-mock-key" && it != "phase-0-key-not-generated" } ?: current.publicKey
        val now = System.currentTimeMillis()
        val db = writableDatabase

        db.execSQL("DELETE FROM local_identity")
        db.execSQL(
            """
            INSERT INTO local_identity (device_id, display_name, public_signing_key, keystore_alias, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf<Any>(finalDeviceId, finalName, finalKey, current.keystoreAlias, now),
        )

        appContext.getSharedPreferences("nodic_identity", Context.MODE_PRIVATE).edit()
            .putString("device_id", finalDeviceId)
            .putString("display_name", finalName)
            .putString("public_key", finalKey)
            .apply()

        insertLog(
            level = "INFO",
            category = "IDENTITY",
            peerDeviceId = finalDeviceId,
            sessionId = null,
            message = "Updated local device identity display name to $finalName",
            detailsJson = JSONObject().put("deviceId", finalDeviceId).put("displayName", finalName).toString(),
        )

        return LocalNodeIdentity(finalDeviceId, finalName, finalKey, current.keystoreAlias)
    }

    private fun ensureKeystorePublicKey(alias: String): String {
        return try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (!keyStore.containsAlias(alias)) {
                val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
                val spec = KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
                kpg.initialize(spec)
                val pair = kpg.generateKeyPair()
                "p256:" + Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
            } else {
                val cert = keyStore.getCertificate(alias)
                "p256:" + Base64.encodeToString(cert.publicKey.encoded, Base64.NO_WRAP)
            }
        } catch (_: Exception) {
            try {
                val kpg = KeyPairGenerator.getInstance("EC")
                kpg.initialize(ECGenParameterSpec("secp256r1"))
                val pair = kpg.generateKeyPair()
                "p256:" + Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
            } catch (_: Exception) {
                "p256:nodic-${UUID.randomUUID()}"
            }
        }
    }

    @Synchronized
    fun upsertPeerIdentity(
        deviceId: String,
        displayName: String,
        publicKey: String,
        serviceName: String?,
        host: String,
        port: Int,
        status: String = "ONLINE",
    ): JSONObject {
        val db = writableDatabase
        createTables(db)
        val now = System.currentTimeMillis()
        var firstSeen = now
        db.rawQuery("SELECT first_seen_at FROM peer_identities WHERE device_id = ?", arrayOf(deviceId)).use { cursor ->
            if (cursor.moveToFirst()) {
                firstSeen = cursor.getLong(0)
            }
        }

        db.execSQL(
            """
            INSERT INTO peer_identities (device_id, display_name, public_signing_key, service_name, host, port, status, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                display_name = excluded.display_name,
                public_signing_key = excluded.public_signing_key,
                service_name = COALESCE(excluded.service_name, peer_identities.service_name),
                host = excluded.host,
                port = excluded.port,
                status = excluded.status,
                last_seen_at = excluded.last_seen_at
            """.trimIndent(),
            arrayOf<Any?>(deviceId, displayName, publicKey, serviceName, host, port, status, firstSeen, now),
        )

        return JSONObject()
            .put("deviceId", deviceId)
            .put("displayName", displayName)
            .put("publicSigningKey", publicKey)
            .put("serviceName", serviceName ?: JSONObject.NULL)
            .put("host", host)
            .put("port", port)
            .put("status", status)
            .put("firstSeenAt", Instant.ofEpochMilli(firstSeen).toString())
            .put("lastSeenAt", Instant.ofEpochMilli(now).toString())
    }

    @Synchronized
    fun upsertPeerSession(
        sessionId: String,
        peerDeviceId: String,
        peerDisplayName: String,
        peerPublicKey: String,
        peerAddress: String,
        peerPort: Int,
        direction: String,
        status: String,
        eventsSentDelta: Int = 0,
        eventsReceivedDelta: Int = 0,
    ): JSONObject {
        val db = writableDatabase
        createTables(db)
        val now = System.currentTimeMillis()
        var startedAt = now
        var eventsSent = eventsSentDelta
        var eventsReceived = eventsReceivedDelta
        var existingDirection = direction

        db.rawQuery(
            "SELECT started_at, events_sent, events_received, direction FROM peer_sessions WHERE id = ?",
            arrayOf(sessionId),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                startedAt = cursor.getLong(0)
                eventsSent = cursor.getInt(1) + eventsSentDelta
                eventsReceived = cursor.getInt(2) + eventsReceivedDelta
                existingDirection = cursor.getString(3)
            }
        }

        val endedAt: Long? = if (status == "DISCONNECTED" || status == "ERROR") now else null

        db.execSQL(
            """
            INSERT INTO peer_sessions (
                id, peer_device_id, peer_display_name, peer_public_key, peer_address, peer_port,
                direction, status, started_at, last_activity_at, ended_at, events_sent, events_received
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                peer_device_id = excluded.peer_device_id,
                peer_display_name = excluded.peer_display_name,
                peer_public_key = excluded.peer_public_key,
                peer_address = excluded.peer_address,
                peer_port = excluded.peer_port,
                status = excluded.status,
                last_activity_at = excluded.last_activity_at,
                ended_at = excluded.ended_at,
                events_sent = excluded.events_sent,
                events_received = excluded.events_received
            """.trimIndent(),
            arrayOf<Any?>(
                sessionId,
                peerDeviceId,
                peerDisplayName,
                peerPublicKey,
                peerAddress,
                peerPort,
                existingDirection,
                status,
                startedAt,
                now,
                endedAt,
                eventsSent,
                eventsReceived,
            ),
        )

        return JSONObject()
            .put("id", sessionId)
            .put("peerDeviceId", peerDeviceId)
            .put("peerDisplayName", peerDisplayName)
            .put("peerPublicKey", peerPublicKey)
            .put("peerAddress", peerAddress)
            .put("peerPort", peerPort)
            .put("direction", existingDirection)
            .put("status", status)
            .put("startedAt", Instant.ofEpochMilli(startedAt).toString())
            .put("lastActivityAt", Instant.ofEpochMilli(now).toString())
            .put("endedAt", if (endedAt != null) Instant.ofEpochMilli(endedAt).toString() else JSONObject.NULL)
            .put("eventsSent", eventsSent)
            .put("eventsReceived", eventsReceived)
    }

    @Synchronized
    fun markPeerDisconnectedByServiceOrDevice(identifier: String): List<JSONObject> {
        val db = writableDatabase
        createTables(db)
        val now = System.currentTimeMillis()
        val updatedSessions = mutableListOf<JSONObject>()

        db.execSQL(
            "UPDATE peer_identities SET status = 'OFFLINE', last_seen_at = ? WHERE device_id = ? OR service_name = ?",
            arrayOf<Any>(now, identifier, identifier),
        )

        val sessionIds = mutableListOf<String>()
        db.rawQuery(
            """
            SELECT s.id FROM peer_sessions s
            LEFT JOIN peer_identities p ON p.device_id = s.peer_device_id
            WHERE (s.peer_device_id = ? OR p.service_name = ?) AND s.status = 'CONNECTED'
            """.trimIndent(),
            arrayOf(identifier, identifier),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                sessionIds.add(cursor.getString(0))
            }
        }

        for (sid in sessionIds) {
            db.execSQL(
                "UPDATE peer_sessions SET status = 'DISCONNECTED', last_activity_at = ?, ended_at = ? WHERE id = ?",
                arrayOf<Any>(now, now, sid),
            )
            getSessionById(sid)?.let { updatedSessions.add(it) }
        }
        return updatedSessions
    }

    @Synchronized
    fun closeAllActiveSessions() {
        val db = writableDatabase
        createTables(db)
        val now = System.currentTimeMillis()
        db.execSQL("UPDATE peer_identities SET status = 'OFFLINE', last_seen_at = ?", arrayOf<Any>(now))
        db.execSQL(
            "UPDATE peer_sessions SET status = 'DISCONNECTED', last_activity_at = ?, ended_at = ? WHERE status = 'CONNECTED'",
            arrayOf<Any>(now, now),
        )
    }

    @Synchronized
    fun getSessionById(sessionId: String): JSONObject? {
        val db = writableDatabase
        db.rawQuery(
            """
            SELECT id, peer_device_id, peer_display_name, peer_public_key, peer_address, peer_port,
                   direction, status, started_at, last_activity_at, ended_at, events_sent, events_received
            FROM peer_sessions WHERE id = ? LIMIT 1
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            val endedAt = if (cursor.isNull(10)) null else cursor.getLong(10)
            return JSONObject()
                .put("id", cursor.getString(0))
                .put("peerDeviceId", cursor.getString(1))
                .put("peerDisplayName", cursor.getString(2))
                .put("peerPublicKey", cursor.getString(3))
                .put("peerAddress", cursor.getString(4))
                .put("peerPort", cursor.getInt(5))
                .put("direction", cursor.getString(6))
                .put("status", cursor.getString(7))
                .put("startedAt", Instant.ofEpochMilli(cursor.getLong(8)).toString())
                .put("lastActivityAt", Instant.ofEpochMilli(cursor.getLong(9)).toString())
                .put("endedAt", if (endedAt != null) Instant.ofEpochMilli(endedAt).toString() else JSONObject.NULL)
                .put("eventsSent", cursor.getInt(11))
                .put("eventsReceived", cursor.getInt(12))
        }
    }

    @Synchronized
    fun insertLog(
        level: String,
        category: String,
        peerDeviceId: String?,
        sessionId: String?,
        message: String,
        detailsJson: String? = null,
    ): JSONObject {
        val db = writableDatabase
        createTables(db)
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        db.execSQL(
            """
            INSERT INTO sync_logs (id, level, category, peer_device_id, session_id, message, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf<Any?>(id, level, category, peerDeviceId, sessionId, message, detailsJson, now),
        )
        return JSONObject()
            .put("id", id)
            .put("level", level)
            .put("category", category)
            .put("peerDeviceId", peerDeviceId ?: JSONObject.NULL)
            .put("sessionId", sessionId ?: JSONObject.NULL)
            .put("message", message)
            .put("detailsJson", detailsJson ?: JSONObject.NULL)
            .put("createdAt", Instant.ofEpochMilli(now).toString())
    }

    @Synchronized
    fun getPeerIdentities(): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        db.rawQuery(
            """
            SELECT device_id, display_name, public_signing_key, service_name, host, port, status, first_seen_at, last_seen_at
            FROM peer_identities ORDER BY last_seen_at DESC
            """.trimIndent(),
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                arr.put(
                    JSONObject()
                        .put("deviceId", cursor.getString(0))
                        .put("displayName", cursor.getString(1))
                        .put("publicSigningKey", cursor.getString(2))
                        .put("serviceName", if (cursor.isNull(3)) JSONObject.NULL else cursor.getString(3))
                        .put("host", cursor.getString(4))
                        .put("port", cursor.getInt(5))
                        .put("status", cursor.getString(6))
                        .put("firstSeenAt", Instant.ofEpochMilli(cursor.getLong(7)).toString())
                        .put("lastSeenAt", Instant.ofEpochMilli(cursor.getLong(8)).toString()),
                )
            }
        }
        return arr
    }

    @Synchronized
    fun getPeerSessions(limit: Int = 50): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        db.rawQuery(
            """
            SELECT id, peer_device_id, peer_display_name, peer_public_key, peer_address, peer_port,
                   direction, status, started_at, last_activity_at, ended_at, events_sent, events_received
            FROM peer_sessions ORDER BY last_activity_at DESC LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val endedAt = if (cursor.isNull(10)) null else cursor.getLong(10)
                arr.put(
                    JSONObject()
                        .put("id", cursor.getString(0))
                        .put("peerDeviceId", cursor.getString(1))
                        .put("peerDisplayName", cursor.getString(2))
                        .put("peerPublicKey", cursor.getString(3))
                        .put("peerAddress", cursor.getString(4))
                        .put("peerPort", cursor.getInt(5))
                        .put("direction", cursor.getString(6))
                        .put("status", cursor.getString(7))
                        .put("startedAt", Instant.ofEpochMilli(cursor.getLong(8)).toString())
                        .put("lastActivityAt", Instant.ofEpochMilli(cursor.getLong(9)).toString())
                        .put("endedAt", if (endedAt != null) Instant.ofEpochMilli(endedAt).toString() else JSONObject.NULL)
                        .put("eventsSent", cursor.getInt(11))
                        .put("eventsReceived", cursor.getInt(12)),
                )
            }
        }
        return arr
    }

    @Synchronized
    fun getSyncLogs(limit: Int = 100): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        db.rawQuery(
            """
            SELECT id, level, category, peer_device_id, session_id, message, details_json, created_at
            FROM sync_logs ORDER BY created_at DESC LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                arr.put(
                    JSONObject()
                        .put("id", cursor.getString(0))
                        .put("level", cursor.getString(1))
                        .put("category", cursor.getString(2))
                        .put("peerDeviceId", if (cursor.isNull(3)) JSONObject.NULL else cursor.getString(3))
                        .put("sessionId", if (cursor.isNull(4)) JSONObject.NULL else cursor.getString(4))
                        .put("message", cursor.getString(5))
                        .put("detailsJson", if (cursor.isNull(6)) JSONObject.NULL else cursor.getString(6))
                        .put("createdAt", Instant.ofEpochMilli(cursor.getLong(7)).toString()),
                )
            }
        }
        return arr
    }

    @Synchronized
    fun clearSyncLogs() {
        val db = writableDatabase
        createTables(db)
        db.execSQL("DELETE FROM sync_logs")
    }

    @Synchronized
    fun insert(id: String, fromPeer: String, payload: String) {
        val db = writableDatabase
        createTables(db)
        db.execSQL(
            "INSERT OR IGNORE INTO phase_zero_events (id, from_peer, payload, received_at) VALUES (?, ?, ?, ?)",
            arrayOf<Any>(id, fromPeer, payload, System.currentTimeMillis()),
        )
    }

    @Synchronized
    fun upsertWorkspaceChannel(
        id: String,
        sessionId: String,
        name: String,
        description: String?,
        leadDeviceId: String,
        genesisEventId: String,
        keyVersion: Int = 1,
        channelKey: String? = null,
        isActive: Boolean = true,
        createdAt: Long = System.currentTimeMillis(),
    ) {
        val db = writableDatabase
        createTables(db)
        if (isActive) {
            db.execSQL("UPDATE workspace_channels SET is_active = 0")
        }
        db.execSQL(
            """
            INSERT INTO workspace_channels (
                id, session_id, name, description, lead_device_id, genesis_event_id, key_version, channel_key, is_active, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                session_id = COALESCE(NULLIF(excluded.session_id, ''), workspace_channels.session_id),
                name = CASE WHEN excluded.name != 'Connected Channel' THEN excluded.name ELSE workspace_channels.name END,
                description = COALESCE(excluded.description, workspace_channels.description),
                lead_device_id = CASE WHEN excluded.lead_device_id != 'remote-lead' THEN excluded.lead_device_id ELSE workspace_channels.lead_device_id END,
                genesis_event_id = CASE WHEN excluded.genesis_event_id != 'joined' THEN excluded.genesis_event_id ELSE workspace_channels.genesis_event_id END,
                key_version = MAX(workspace_channels.key_version, excluded.key_version),
                channel_key = COALESCE(excluded.channel_key, workspace_channels.channel_key),
                is_active = excluded.is_active
            """.trimIndent(),
            arrayOf<Any?>(
                id,
                sessionId,
                name,
                description,
                leadDeviceId,
                genesisEventId,
                keyVersion,
                channelKey,
                if (isActive) 1 else 0,
                createdAt,
            ),
        )
    }

    @Synchronized
    fun setActiveWorkspaceChannel(channelId: String?) {
        val db = writableDatabase
        createTables(db)
        db.execSQL("UPDATE workspace_channels SET is_active = 0")
        if (!channelId.isNullOrBlank()) {
            db.execSQL("UPDATE workspace_channels SET is_active = 1 WHERE id = ?", arrayOf<Any>(channelId))
        }
    }

    @Synchronized
    fun getWorkspaceChannels(): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        db.rawQuery(
            """
            SELECT id, session_id, name, description, lead_device_id, genesis_event_id, key_version, channel_key, is_active, created_at
            FROM workspace_channels ORDER BY is_active DESC, created_at DESC
            """.trimIndent(),
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                arr.put(
                    JSONObject()
                        .put("id", cursor.getString(0))
                        .put("sessionId", cursor.getString(1))
                        .put("name", cursor.getString(2))
                        .put("description", if (cursor.isNull(3)) JSONObject.NULL else cursor.getString(3))
                        .put("leadDeviceId", cursor.getString(4))
                        .put("genesisEventId", cursor.getString(5))
                        .put("keyVersion", cursor.getInt(6))
                        .put("channelKey", if (cursor.isNull(7)) JSONObject.NULL else cursor.getString(7))
                        .put("isActive", cursor.getInt(8) == 1)
                        .put("createdAt", cursor.getLong(9)),
                )
            }
        }
        return arr
    }

    @Synchronized
    fun hasWorkspaceEvent(eventId: String): Boolean {
        val db = writableDatabase
        createTables(db)
        db.rawQuery("SELECT 1 FROM workspace_events WHERE id = ? LIMIT 1", arrayOf(eventId)).use { cursor ->
            return cursor.moveToFirst()
        }
    }

    @Synchronized
    fun hasWorkspaceChannel(channelId: String): Boolean {
        val db = writableDatabase
        createTables(db)
        db.rawQuery("SELECT 1 FROM workspace_channels WHERE id = ? LIMIT 1", arrayOf(channelId)).use {
            return it.moveToFirst()
        }
    }

    /**
     * Stores an event received from a remote peer. Events for channels this device has not
     * joined (via invite code or by creating them) are dropped, so pairing alone never
     * grants channel membership. Join requests are transient and always pass through.
     */
    @Synchronized
    fun upsertRemoteWorkspaceEvent(eventJsonStr: String): Boolean {
        return try {
            val ev = JSONObject(eventJsonStr)
            val channelId = ev.optString("channelId")
            if (channelId.isBlank()) return false
            if (!hasWorkspaceChannel(channelId)) return false
            upsertWorkspaceEvent(eventJsonStr)
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun upsertWorkspaceEvent(eventJsonStr: String): Boolean {
        return try {
            val ev = JSONObject(eventJsonStr)
            val id = ev.optString("id")
            val channelId = ev.optString("channelId")
            val authorDeviceId = ev.optString("authorDeviceId")
            val authorSequence = ev.optInt("authorSequence", 1)
            val lamportClock = ev.optInt("lamportClock", 1)
            val type = ev.optString("type")
            if (id.isBlank() || channelId.isBlank() || type.isBlank()) return false
            // Join requests are transient and must never be persisted as channel history
            if (type == "JOIN_REQUESTED") return true

            val createdAtStr = ev.optString("createdAt")
            val createdAtMs = try {
                Instant.parse(createdAtStr).toEpochMilli()
            } catch (_: Exception) {
                System.currentTimeMillis()
            }

            val db = writableDatabase
            createTables(db)
            db.execSQL(
                """
                INSERT OR IGNORE INTO workspace_events (
                    id, channel_id, author_device_id, author_sequence, lamport_clock, type, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any>(
                    id,
                    channelId,
                    authorDeviceId,
                    authorSequence,
                    lamportClock,
                    type,
                    eventJsonStr,
                    createdAtMs,
                ),
            )

            if (type == "CHANNEL_CREATED") {
                val payload = ev.optJSONObject("payload") ?: JSONObject()
                val name = payload.optString("name", "Channel")
                val desc = if (payload.isNull("description")) null else payload.optString("description")
                val sessionId = payload.optString("sessionId").takeIf { it.isNotBlank() }
                    ?: "sess-${channelId.take(12)}"
                upsertWorkspaceChannel(
                    id = channelId,
                    sessionId = sessionId,
                    name = name,
                    description = desc,
                    leadDeviceId = authorDeviceId,
                    genesisEventId = id,
                    keyVersion = ev.optInt("keyVersion", 1),
                    channelKey = null,
                    isActive = true,
                    createdAt = createdAtMs,
                )
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun getWorkspaceEvents(channelId: String? = null, limit: Int = 500): JSONArray {
        val db = writableDatabase
        createTables(db)
        val arr = JSONArray()
        val sql = if (!channelId.isNullOrBlank()) {
            "SELECT event_json FROM workspace_events WHERE channel_id = ? ORDER BY lamport_clock ASC, author_sequence ASC, created_at ASC LIMIT ?"
        } else {
            "SELECT event_json FROM workspace_events ORDER BY lamport_clock ASC, author_sequence ASC, created_at ASC LIMIT ?"
        }
        val args = if (!channelId.isNullOrBlank()) {
            arrayOf(channelId, limit.toString())
        } else {
            arrayOf(limit.toString())
        }
        db.rawQuery(sql, args).use { cursor ->
            while (cursor.moveToNext()) {
                val raw = cursor.getString(0)
                try {
                    arr.put(JSONObject(raw))
                } catch (_: Exception) {}
            }
        }
        return arr
    }

    @Synchronized
    fun clearWorkspaceData() {
        val db = writableDatabase
        createTables(db)
        db.execSQL("DELETE FROM workspace_channels")
        db.execSQL("DELETE FROM workspace_events")
        db.execSQL("DELETE FROM phase_zero_events")
        db.execSQL("DELETE FROM peer_identities")
        db.execSQL("DELETE FROM peer_sessions")
        db.execSQL("DELETE FROM sync_logs")
        db.execSQL("DELETE FROM paired_devices")
        db.execSQL("DELETE FROM pairing_requests")
    }
}
