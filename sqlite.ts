// GuildScribe — the database: a local SQLite file on the host laptop.
//
// Same execute/batch interface (and object rows) as Val Town's std/sqlite
// main.ts, which this replaced, so every query runs unchanged. The file lives
// at DB_PATH (default ./data/guildscribe.sqlite, next to the code).
//
// Every module imports `sqlite` from here.

import { openLocalSqlite } from "./local_sqlite.ts";

export const DB_PATH = Deno.env.get("DB_PATH") || "./data/guildscribe.sqlite";

const db = openLocalSqlite(DB_PATH, "object");

export const sqlite = {
  execute: db.execute,
  batch: db.batch,
};
