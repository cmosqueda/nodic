package dev.nodic.app.sync

data class SyncState(
    val state: String = "STOPPED",
    val peerCount: Int = 0,
    val pendingEventCount: Int = 0,
    val lastSyncAt: String? = null,
    val detail: String? = null,
)
