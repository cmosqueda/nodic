import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

export interface NodicDatabase {
  connection: SQLiteDBConnection;
  db: SqliteRemoteDatabase<typeof schema>;
  close(): Promise<void>;
}

export async function openNodicDatabase(): Promise<NodicDatabase> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Native SQLite is available only in the Android build during Phase 0.');
  }

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistent = await sqlite.checkConnectionsConsistency();
  const hasConnection = (await sqlite.isConnection('nodic', false)).result;
  const connection = consistent.result && hasConnection
    ? await sqlite.retrieveConnection('nodic', false)
    : await sqlite.createConnection('nodic', false, 'no-encryption', 1, false);

  if (!(await connection.isDBOpen()).result) await connection.open();
  try {
    await connection.query('PRAGMA journal_mode = WAL;');
  } catch {
    // Ignore if WAL pragma returns cursor or is unsupported on device
  }
  try {
    await connection.execute('PRAGMA foreign_keys = ON;', false);
  } catch {
    // Ignore pragma errors
  }

  const db = drizzle<typeof schema>(async (sql, params, method) => {
    if (method === 'run') {
      const result = await connection.run(sql, params, false, 'all');
      return { rows: result.changes?.values ?? [] };
    }

    const result = await connection.query(sql, params);
    const values = result.values ?? [];
    if (method === 'values') {
      return { rows: values.map((row) => (Array.isArray(row) ? row : Object.values(row))) };
    }
    if (method === 'get') return { rows: values.slice(0, 1) };
    return { rows: values };
  }, { schema });

  return {
    connection,
    db,
    close: () => sqlite.closeConnection('nodic', false),
  };
}
