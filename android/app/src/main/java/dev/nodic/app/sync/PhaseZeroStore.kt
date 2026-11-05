package dev.nodic.app.sync

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class PhaseZeroStore(context: Context) : SQLiteOpenHelper(context, "nodic-phase0.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE phase_zero_events (
                id TEXT PRIMARY KEY NOT NULL,
                from_peer TEXT NOT NULL,
                payload TEXT NOT NULL,
                received_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun verify(): Boolean {
        writableDatabase.rawQuery("SELECT 1", null).use { return it.moveToFirst() }
    }

    fun insert(id: String, fromPeer: String, payload: String) {
        writableDatabase.execSQL(
            "INSERT OR IGNORE INTO phase_zero_events (id, from_peer, payload, received_at) VALUES (?, ?, ?, ?)",
            arrayOf<Any>(id, fromPeer, payload, System.currentTimeMillis()),
        )
    }
}
