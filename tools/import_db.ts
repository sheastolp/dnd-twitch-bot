// One-time move of a bot's data into its local SQLite file (DB_PATH).
//
//   deno task import-db --file ~/Downloads/export.sqlite
//       Copies every table from a SQLite file (e.g. a backup of the bot's
//       database).
//
// Run it with the bot stopped, before its first start (or add --force to
// replace an existing local database). The source file is opened read-only.

import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB = "./data/guildscribe.sqlite"; // same default as sqlite.ts

const argv = Deno.args;
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = { file: option("file"), force: flag("force") };
const target = Deno.env.get("DB_PATH") || DEFAULT_DB;

interface Source {
  query(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;
}

function fileSource(path: string): Source {
  const db = new DatabaseSync(path, { readOnly: true } as any);
  return {
    query(sql) {
      const st = db.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const rows = st.all().map((r: any) => columns.map((c) => r[c]));
      return Promise.resolve({ columns, rows });
    },
  };
}

if (!args.file) {
  console.error("Usage: deno task import-db --file <export.sqlite> [--force]");
  Deno.exit(1);
}
const source = fileSource(args.file);

try {
  Deno.statSync(target);
  if (!args.force) {
    console.error(`${target} already exists. Stop the bot and add --force to replace it.`);
    Deno.exit(1);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { Deno.removeSync(target + suffix); } catch { /* not there */ }
  }
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
if (target.includes("/")) Deno.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });

const out = new DatabaseSync(target);
const schema = await source.query(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
);
const tables: string[] = [];
for (const [type, name, sql] of schema.rows as [string, string, string][]) {
  out.exec(sql);
  if (type === "table") tables.push(name);
}

const PAGE = 500;
for (const table of tables) {
  const q = `"${table.replaceAll('"', '""')}"`;
  let copied = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await source.query(`SELECT * FROM ${q} LIMIT ${PAGE} OFFSET ${offset}`);
    if (page.rows.length === 0) break;
    const cols = page.columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    const insert = out.prepare(`INSERT INTO ${q} (${cols}) VALUES (${page.columns.map(() => "?").join(", ")})`);
    out.exec("BEGIN");
    for (const row of page.rows) insert.run(...(row as any[]));
    out.exec("COMMIT");
    copied += page.rows.length;
    if (page.rows.length < PAGE) break;
  }
  console.log(`${table}: ${copied} row(s)`);
}
out.close();
console.log(`Done: ${tables.length} table(s) into ${target}`);
