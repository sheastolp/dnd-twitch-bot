// Battle map persistence (maps, terrain cells, character tokens).
// Split out of db.ts (which re-exports everything here) to keep every file
// well under Val Town's per-file size ceiling.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// ── Maps ──

export type MapRow = {
  broadcaster_id: string;
  map_name: string;
  width: number;
  height: number;
  default_terrain: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export type MapToken = {
  username: string;
  display_name: string | null;
  x: number;
  y: number;
};

export async function getMap(broadcasterId: string, mapName: string): Promise<MapRow | null> {
  const res = await sqlite.execute("SELECT * FROM maps WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return {
    broadcaster_id: r.broadcaster_id,
    map_name: r.map_name,
    width: Number(r.width),
    height: Number(r.height),
    default_terrain: r.default_terrain,
    created_by: r.created_by,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

export async function listMaps(broadcasterId: string): Promise<MapRow[]> {
  const res = await sqlite.execute("SELECT * FROM maps WHERE broadcaster_id = ? ORDER BY map_name ASC", [broadcasterId]);
  return res.rows.map((r: any) => ({
    broadcaster_id: r.broadcaster_id,
    map_name: r.map_name,
    width: Number(r.width),
    height: Number(r.height),
    default_terrain: r.default_terrain,
    created_by: r.created_by,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }));
}

export async function createMap(
  broadcasterId: string,
  mapName: string,
  width: number,
  height: number,
  createdBy: string,
) {
  const maxMaps = Math.max(1, Number(Deno.env.get("MAX_MAPS_PER_CHANNEL") ?? "25"));
  const count = await sqlite.execute("SELECT COUNT(*) AS count FROM maps WHERE broadcaster_id = ?", [broadcasterId]);
  if (Number(count.rows[0]?.count ?? 0) >= maxMaps) throw new Error(`Channel map cap reached (${maxMaps}).`);
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO maps (broadcaster_id,map_name,width,height,default_terrain,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [broadcasterId, mapName, width, height, "grass", createdBy, now, now],
  );
}

export async function deleteMap(broadcasterId: string, mapName: string) {
  await sqlite.execute("DELETE FROM maps WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("DELETE FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("DELETE FROM map_tokens WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
}

async function touchMap(broadcasterId: string, mapName: string) {
  await sqlite.execute("UPDATE maps SET updated_at = ? WHERE broadcaster_id = ? AND map_name = ?", [Date.now(), broadcasterId, mapName]);
}

export async function getMapCells(broadcasterId: string, mapName: string): Promise<Record<string, string>> {
  const res = await sqlite.execute("SELECT x,y,terrain FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  const out: Record<string, string> = {};
  for (const r of res.rows as any[]) out[`${r.x},${r.y}`] = r.terrain;
  return out;
}

export async function setMapCell(broadcasterId: string, mapName: string, x: number, y: number, terrain: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO map_cells (broadcaster_id,map_name,x,y,terrain) VALUES (?,?,?,?,?)",
    [broadcasterId, mapName, x, y, terrain],
  );
  await touchMap(broadcasterId, mapName);
}

export async function fillMap(broadcasterId: string, mapName: string, terrain: string) {
  await sqlite.execute("DELETE FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("UPDATE maps SET default_terrain = ?, updated_at = ? WHERE broadcaster_id = ? AND map_name = ?", [
    terrain,
    Date.now(),
    broadcasterId,
    mapName,
  ]);
}

export async function getMapTokens(broadcasterId: string, mapName: string): Promise<MapToken[]> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ?",
    [broadcasterId, mapName],
  );
  return (res.rows as any[]).map((r) => ({ username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) }));
}

export async function getMapToken(broadcasterId: string, mapName: string, username: string): Promise<MapToken | null> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND username = ?",
    [broadcasterId, mapName, username],
  );
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return { username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) };
}

export async function findTokenAt(broadcasterId: string, mapName: string, x: number, y: number): Promise<MapToken | null> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND x = ? AND y = ?",
    [broadcasterId, mapName, x, y],
  );
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return { username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) };
}

export async function upsertMapToken(
  broadcasterId: string,
  mapName: string,
  username: string,
  displayName: string,
  x: number,
  y: number,
) {
  const now = Date.now();
  await sqlite.execute(
    "INSERT OR REPLACE INTO map_tokens (broadcaster_id,map_name,username,display_name,x,y,placed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [broadcasterId, mapName, username, displayName, x, y, now, now],
  );
  await touchMap(broadcasterId, mapName);
}

export async function removeMapToken(broadcasterId: string, mapName: string, username: string) {
  await sqlite.execute("DELETE FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND username = ?", [broadcasterId, mapName, username]);
  await touchMap(broadcasterId, mapName);
}
