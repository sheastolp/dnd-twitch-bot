// A local SQLite file with the same execute/batch interface as Val Town's
// std/sqlite (which wraps @libsql/client), so the bot's queries run unchanged
// on the Yoga laptop. Uses Deno's built-in node:sqlite: no download, no FFI.
//
// rowMode "object" matches std/sqlite/main.ts (val-scoped: rows are objects
// keyed by column name); "array" matches std/sqlite/global.ts (rows are
// arrays of values).

import { DatabaseSync } from "node:sqlite";

export type InValue = string | number | bigint | boolean | null | undefined | Uint8Array | Date;
export type InArgs = InValue[] | Record<string, InValue>;
export type InStatement = string | { sql: string; args?: InArgs };

export interface ResultSet {
  columns: string[];
  columnTypes: string[];
  rows: any[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

function toValue(v: InValue): string | number | bigint | null | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return v;
}

function toArgs(args: InArgs | undefined): any[] {
  if (args === undefined || args === null) return [];
  if (Array.isArray(args)) return args.map(toValue);
  // Named args: libsql accepts :name, @name and $name with bare keys.
  const named: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) named[k.replace(/^[:@$]/, "")] = toValue(v as InValue);
  return [named];
}

export function openLocalSqlite(path: string, rowMode: "object" | "array") {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) Deno.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  const changesStmt = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r");

  function run(stmt: InStatement, extraArgs?: InArgs): ResultSet {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const args = toArgs(typeof stmt === "string" ? extraArgs : stmt.args);
    const prepared = db.prepare(sql);
    const cols = prepared.columns();
    if (cols.length === 0) {
      const r = prepared.run(...args);
      return {
        columns: [],
        columnTypes: [],
        rows: [],
        rowsAffected: Number(r.changes),
        lastInsertRowid: r.lastInsertRowid === undefined ? undefined : BigInt(r.lastInsertRowid),
      };
    }
    const asArrays = rowMode === "array" && typeof (prepared as any).setReturnArrays === "function";
    if (asArrays) (prepared as any).setReturnArrays(true);
    const rows = prepared.all(...args).map((r: any) =>
      rowMode === "object" ? { ...r } : asArrays ? r : cols.map((c) => r[c.name])
    );
    const ch = changesStmt.get() as { c: number; r: number };
    return {
      columns: cols.map((c) => c.name),
      columnTypes: cols.map((c) => c.type ?? ""),
      rows,
      rowsAffected: /^\s*(insert|update|delete|replace)\b/i.test(sql) ? Number(ch.c) : 0,
      lastInsertRowid: BigInt(ch.r),
    };
  }

  return {
    db,
    /** execute(sql), execute(sql, args) or execute({ sql, args }), as in libsql. */
    execute(stmt: InStatement, args?: InArgs): Promise<ResultSet> {
      try {
        return Promise.resolve(run(stmt, args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    /** All statements in one transaction, like libsql's batch: all or nothing. */
    batch(stmts: InStatement[], _mode?: string): Promise<ResultSet[]> {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const out = stmts.map((s) => run(s));
          db.exec("COMMIT");
          return Promise.resolve(out);
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}
