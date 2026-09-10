// GuildScribe — battle maps
//
// Chat commands create/edit maps and place character tokens on them; a
// public, read-only web page (see pages.ts / main.ts route "/map") renders
// the grid visually. Editing (creating a map, painting terrain, deleting a
// map, and moving someone else's token) stays behind Twitch chat identity
// (chatterId, verified by EventSub) rather than an open web form — that
// matches how every other piece of shared channel state in this bot
// (parties, duels, the initiative tracker) is only ever mutated through an
// authenticated chat command, never through an unauthenticated web request.

import { sendChatMessage } from "./twitch.ts";
import {
  createMap,
  deleteMap,
  fillMap,
  findTokenAt,
  getCharacter,
  getMap,
  getMapCells,
  getMapToken,
  getMapTokens,
  listMaps,
  removeMapToken,
  setMapCell,
  upsertMapToken,
} from "./db.ts";

// ── Map templates ──
//
// Publicly listable (!map templates), publicly usable (!map create <name>
// [WxH] <template>) preset terrain layouts. A template is just a default
// terrain plus a list of cell overrides — reuses the existing fillMap /
// setMapCell primitives, so no schema changes are needed. Cells are applied
// in array order, so later entries in a template's `cells` list win over
// earlier ones at the same coordinate (e.g. a door punched through a wall).

interface TemplateCell {
  x: number;
  y: number;
  terrain: string;
}

export interface MapTemplate {
  name: string;
  label: string;
  description: string;
  width: number;
  height: number;
  defaultTerrain: string;
  cells: TemplateCell[];
}

function rectFill(x1: number, y1: number, x2: number, y2: number, terrain: string): TemplateCell[] {
  const cells: TemplateCell[] = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) cells.push({ x, y, terrain });
  return cells;
}

function rectBorder(x1: number, y1: number, x2: number, y2: number, terrain: string): TemplateCell[] {
  const cells: TemplateCell[] = [];
  for (let x = x1; x <= x2; x++) {
    cells.push({ x, y: y1, terrain });
    cells.push({ x, y: y2, terrain });
  }
  for (let y = y1 + 1; y < y2; y++) {
    cells.push({ x: x1, y, terrain });
    cells.push({ x: x2, y, terrain });
  }
  return cells;
}

function hLine(x1: number, x2: number, y: number, terrain: string): TemplateCell[] {
  const cells: TemplateCell[] = [];
  for (let x = x1; x <= x2; x++) cells.push({ x, y, terrain });
  return cells;
}

function vLine(y1: number, y2: number, x: number, terrain: string): TemplateCell[] {
  const cells: TemplateCell[] = [];
  for (let y = y1; y <= y2; y++) cells.push({ x, y, terrain });
  return cells;
}

function pt(x: number, y: number, terrain: string): TemplateCell {
  return { x, y, terrain };
}

export const MAP_TEMPLATES: Record<string, MapTemplate> = {
  tavern: {
    name: "tavern",
    label: "Tavern",
    description: "A common room with a bar, a few tables, and a door onto the road.",
    width: 12,
    height: 10,
    defaultTerrain: "floor",
    cells: [
      ...rectBorder(1, 1, 12, 9, "wall"),
      pt(6, 9, "door"),
      ...hLine(1, 12, 10, "road"),
      ...hLine(9, 11, 2, "wall"), // bar counter
      pt(3, 4, "wall"), // table
      pt(3, 6, "wall"), // table
      pt(8, 5, "wall"), // table
    ],
  },
  dungeon: {
    name: "dungeon",
    label: "Dungeon",
    description: "Two stone rooms joined by a corridor, a side passage, and a trapped closet.",
    width: 16,
    height: 10,
    defaultTerrain: "wall",
    cells: [
      ...rectFill(2, 2, 6, 6, "floor"), // room A
      ...hLine(7, 10, 4, "floor"), // corridor
      pt(7, 4, "door"),
      ...rectFill(11, 2, 15, 7, "floor"), // room B
      pt(11, 4, "door"),
      pt(13, 5, "trap"),
      ...vLine(7, 9, 3, "floor"), // side passage south from room A
      pt(3, 9, "door"),
      ...rectFill(2, 9, 4, 9, "floor"), // closet
    ],
  },
  forest_clearing: {
    name: "forest_clearing",
    label: "Forest Clearing",
    description: "A clearing with a pond, a sandy bank, and a path skirting the water.",
    width: 14,
    height: 12,
    defaultTerrain: "grass",
    cells: [
      ...rectBorder(1, 1, 14, 12, "forest"),
      ...rectFill(6, 5, 9, 8, "water"),
      ...hLine(1, 5, 6, "road"),
      ...hLine(10, 14, 6, "road"),
      ...rectFill(3, 9, 5, 10, "sand"),
    ],
  },
  graveyard: {
    name: "graveyard",
    label: "Graveyard",
    description: "A walled graveyard with a locked crypt, scattered headstones, and a gate.",
    width: 12,
    height: 10,
    defaultTerrain: "grass",
    cells: [
      ...rectBorder(1, 1, 12, 10, "wall"),
      pt(6, 10, "door"), // gate
      ...rectFill(8, 2, 11, 4, "floor"),
      ...rectBorder(8, 2, 11, 4, "wall"),
      pt(9, 4, "door"), // crypt door
      pt(3, 4, "wall"),
      pt(4, 6, "wall"),
      pt(2, 7, "wall"),
      pt(5, 8, "wall"),
      pt(7, 7, "wall"),
      ...vLine(2, 9, 6, "road"),
    ],
  },
  cave: {
    name: "cave",
    label: "Cave",
    description: "A rocky cavern system with a connecting tunnel, an underground pool, and a pitfall.",
    width: 14,
    height: 10,
    defaultTerrain: "wall",
    cells: [
      ...rectFill(3, 3, 6, 6, "floor"),
      ...rectFill(8, 4, 12, 8, "floor"),
      ...hLine(6, 8, 5, "floor"),
      ...rectFill(2, 8, 4, 9, "floor"),
      pt(4, 4, "trap"),
      pt(10, 6, "water"),
    ],
  },
  arena: {
    name: "arena",
    label: "Arena",
    description: "A sand-floored fighting ring with two gates and a hazard pit at center.",
    width: 12,
    height: 12,
    defaultTerrain: "sand",
    cells: [
      ...rectBorder(1, 1, 12, 12, "wall"),
      pt(6, 1, "door"),
      pt(6, 12, "door"),
      pt(6, 6, "void"),
      pt(7, 6, "void"),
      pt(6, 7, "void"),
      pt(7, 7, "void"),
    ],
  },
};

async function applyMapTemplate(
  broadcasterId: string,
  mapName: string,
  width: number,
  height: number,
  template: MapTemplate,
) {
  await fillMap(broadcasterId, mapName, template.defaultTerrain);
  for (const cell of template.cells) {
    if (cell.x < 1 || cell.x > width || cell.y < 1 || cell.y > height) continue;
    await setMapCell(broadcasterId, mapName, cell.x, cell.y, cell.terrain);
  }
}

export const TERRAINS: Record<string, { label: string; color: string; blocksMovement?: boolean }> = {
  grass: { label: "Grass", color: "#4a7c3c" },
  forest: { label: "Forest", color: "#22492b" },
  water: { label: "Water", color: "#2b6f97", blocksMovement: true },
  sand: { label: "Sand", color: "#c9a86a" },
  mountain: { label: "Mountain", color: "#7a7266", blocksMovement: true },
  road: { label: "Road", color: "#a08a68" },
  floor: { label: "Floor", color: "#3a352f" },
  wall: { label: "Wall", color: "#5c5347", blocksMovement: true },
  door: { label: "Door", color: "#b97545" },
  trap: { label: "Trap", color: "#8b2f2f" },
  lava: { label: "Lava", color: "#c1440e", blocksMovement: true },
  void: { label: "Void", color: "#0d0c0b", blocksMovement: true },
};

const MIN_SIZE = 3;
const MAX_SIZE = 20;
const DEFAULT_WIDTH = 10;
const DEFAULT_HEIGHT = 8;

// Deterministic per-user color so a token always looks the same across maps.
const TOKEN_PALETTE = [
  "#e6a56e", "#7ec9e0", "#c98be0", "#8be0a0", "#e0d18b",
  "#e08b8b", "#8ba9e0", "#d68be0", "#a0e08b", "#e0a08b",
];

export function tokenColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  return TOKEN_PALETTE[hash % TOKEN_PALETTE.length];
}

export function sanitizeMapName(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
}

export function terrainAt(cells: Record<string, string>, defaultTerrain: string, x: number, y: number): string {
  return cells[`${x},${y}`] ?? defaultTerrain;
}

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const m = raw.match(/^(\d+)x(\d+)$/i);
  if (!m) return null;
  const width = Number.parseInt(m[1], 10);
  const height = Number.parseInt(m[2], 10);
  if (width < MIN_SIZE || width > MAX_SIZE || height < MIN_SIZE || height > MAX_SIZE) return null;
  return { width, height };
}

async function firstFreeCell(broadcasterId: string, mapName: string, width: number, height: number) {
  const tokens = await getMapTokens(broadcasterId, mapName);
  const occupied = new Set(tokens.map((t) => `${t.x},${t.y}`));
  for (let y = 1; y <= height; y++) {
    for (let x = 1; x <= width; x++) {
      if (!occupied.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}

function usage(display: string) {
  return `@${display} Usage: !map create <name> [WxH] [template] (mod) | !map templates | !map list | !map view <name> | !map delete <name> / !map remove <name> (mod) | !map terrains | !map fill <name> <terrain> (mod) | !map paint <name> <x> <y> <terrain> (mod) | !map addchar <name> [x y] | !map move <name> <x> <y> | !map removechar <name>`;
}

export async function handleMapCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  if (!/^!map(?:\s|$)/i.test(chatMessage)) return false;
  const me = username.toLowerCase();
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "").toLowerCase();
  const mapUrl = (name: string) => `${baseUrl}/map?channel=${broadcasterId}&map=${encodeURIComponent(name)}`;

  if (action === "create") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can create a map.`, broadcasterId);
      return true;
    }
    const name = sanitizeMapName(parts[2] ?? "");
    if (!name) {
      await sendChatMessage(`@${display} usage: !map create <name> [WxH], e.g. !map create dungeon1 12x10`, broadcasterId);
      return true;
    }
    if (await getMap(broadcasterId, name)) {
      await sendChatMessage(`@${display} a map named "${name}" already exists. Try !map view ${name}.`, broadcasterId);
      return true;
    }

    // Remaining args can include a WxH size token and/or a template name, in
    // either order, e.g. "!map create dungeon1 12x10 tavern" or
    // "!map create dungeon1 tavern 12x10" or just "!map create dungeon1 tavern".
    let sizeToken: string | undefined;
    let templateToken: string | undefined;
    for (const tok of parts.slice(3)) {
      if (/^\d+x\d+$/i.test(tok)) sizeToken = tok;
      else if (!templateToken) templateToken = tok.toLowerCase();
    }

    let template: MapTemplate | undefined;
    if (templateToken) {
      template = MAP_TEMPLATES[templateToken];
      if (!template) {
        await sendChatMessage(`@${display} unknown template "${templateToken}". See !map templates for the list.`, broadcasterId);
        return true;
      }
    }

    const size = sizeToken
      ? parseSize(sizeToken)
      : template
      ? { width: template.width, height: template.height }
      : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    if (!size) {
      await sendChatMessage(`@${display} map size must be WxH between ${MIN_SIZE}x${MIN_SIZE} and ${MAX_SIZE}x${MAX_SIZE}, e.g. 12x10.`, broadcasterId);
      return true;
    }
    try {
      await createMap(broadcasterId, name, size.width, size.height, me);
    } catch (e) {
      await sendChatMessage(`@${display} ${String((e as Error).message ?? e)}`, broadcasterId);
      return true;
    }
    if (template) {
      await applyMapTemplate(broadcasterId, name, size.width, size.height, template);
    }
    await sendChatMessage(
      `@${display} map "${name}" created (${size.width}x${size.height}${template ? `, ${template.label} template` : " grass"}). ` +
        `${template ? "Adjust it further" : "Paint it"} with !map paint/!map fill, then view it: ${mapUrl(name)}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "templates" || action === "template") {
    const list = Object.values(MAP_TEMPLATES)
      .map((t) => `${t.name} (${t.label}, ${t.width}x${t.height})`)
      .join(", ");
    await sendChatMessage(
      `@${display} Map templates: ${list}. Use !map create <name> [WxH] <template>, e.g. !map create tav1 tavern.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "delete" || action === "remove") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can delete a map.`, broadcasterId);
      return true;
    }
    const name = sanitizeMapName(parts[2] ?? "");
    if (!name || !(await getMap(broadcasterId, name))) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found.`, broadcasterId);
      return true;
    }
    await deleteMap(broadcasterId, name);
    await sendChatMessage(`@${display} map "${name}" deleted, along with its terrain and character tokens.`, broadcasterId);
    return true;
  }

  if (action === "list" || action === "") {
    const maps = await listMaps(broadcasterId);
    await sendChatMessage(
      maps.length
        ? `@${display} Maps in this channel: ${maps.map((m) => `${m.map_name} (${m.width}x${m.height})`).join(", ")}. View one with !map view <name>.`
        : `@${display} no maps yet. A moderator can start one with !map create <name> [WxH].`,
      broadcasterId,
    );
    return true;
  }

  if (action === "view") {
    const name = sanitizeMapName(parts[2] ?? "");
    const map = name ? await getMap(broadcasterId, name) : null;
    if (!map) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found. Try !map list.`, broadcasterId);
      return true;
    }
    await sendChatMessage(`@${display} 🗺️ ${map.map_name}: ${mapUrl(map.map_name)}`, broadcasterId);
    return true;
  }

  if (action === "terrains") {
    await sendChatMessage(
      `@${display} Terrain types: ${Object.entries(TERRAINS).map(([k, v]) => `${k} (${v.label}${v.blocksMovement ? ", blocks tokens" : ""})`).join(", ")}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "fill") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can edit a map.`, broadcasterId);
      return true;
    }
    const name = sanitizeMapName(parts[2] ?? "");
    const terrain = (parts[3] ?? "").toLowerCase();
    const map = name ? await getMap(broadcasterId, name) : null;
    if (!map) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found.`, broadcasterId);
      return true;
    }
    if (!TERRAINS[terrain]) {
      await sendChatMessage(`@${display} unknown terrain "${terrain}". See !map terrains.`, broadcasterId);
      return true;
    }
    await fillMap(broadcasterId, name, terrain);
    await sendChatMessage(`@${display} map "${name}" filled with ${TERRAINS[terrain].label}. ${mapUrl(name)}`, broadcasterId);
    return true;
  }

  if (action === "paint") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can edit a map.`, broadcasterId);
      return true;
    }
    const name = sanitizeMapName(parts[2] ?? "");
    const x = Number.parseInt(parts[3] ?? "", 10);
    const y = Number.parseInt(parts[4] ?? "", 10);
    const terrain = (parts[5] ?? "").toLowerCase();
    const map = name ? await getMap(broadcasterId, name) : null;
    if (!map) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found.`, broadcasterId);
      return true;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > map.width || y < 1 || y > map.height) {
      await sendChatMessage(`@${display} coordinates must be within 1..${map.width} by 1..${map.height}. Usage: !map paint <name> <x> <y> <terrain>`, broadcasterId);
      return true;
    }
    if (!TERRAINS[terrain]) {
      await sendChatMessage(`@${display} unknown terrain "${terrain}". See !map terrains.`, broadcasterId);
      return true;
    }
    await setMapCell(broadcasterId, name, x, y, terrain);
    await sendChatMessage(`@${display} painted (${x},${y}) on "${name}" as ${TERRAINS[terrain].label}.`, broadcasterId);
    return true;
  }

  if (action === "addchar" || action === "place") {
    const name = sanitizeMapName(parts[2] ?? "");
    const map = name ? await getMap(broadcasterId, name) : null;
    if (!map) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found. Try !map list.`, broadcasterId);
      return true;
    }
    let rest = parts.slice(3);
    let targetUser = me;
    let targetDisplay = display;
    if (rest[0]?.startsWith("@")) {
      if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can place someone else's character.`, broadcasterId);
        return true;
      }
      targetDisplay = rest[0].slice(1);
      targetUser = targetDisplay.toLowerCase();
      rest = rest.slice(1);
    }
    const character = await getCharacter(targetUser, broadcasterId);
    if (!character) {
      await sendChatMessage(`@${display} ${targetUser === me ? "you don't" : `${targetDisplay} doesn't`} have a character yet — try !createchar first.`, broadcasterId);
      return true;
    }
    if (await getMapToken(broadcasterId, name, targetUser)) {
      await sendChatMessage(`@${display} ${targetUser === me ? "you're" : `${targetDisplay} is`} already on "${name}" — use !map move ${name} <x> <y>.`, broadcasterId);
      return true;
    }
    let x: number, y: number;
    if (rest.length >= 2 && Number.isInteger(Number(rest[0])) && Number.isInteger(Number(rest[1]))) {
      x = Number.parseInt(rest[0], 10);
      y = Number.parseInt(rest[1], 10);
      if (x < 1 || x > map.width || y < 1 || y > map.height) {
        await sendChatMessage(`@${display} coordinates must be within 1..${map.width} by 1..${map.height}.`, broadcasterId);
        return true;
      }
      const cells = await getMapCells(broadcasterId, name);
      const terrain = terrainAt(cells, map.default_terrain, x, y);
      if (TERRAINS[terrain]?.blocksMovement) {
        await sendChatMessage(`@${display} (${x},${y}) is ${TERRAINS[terrain].label} and blocks tokens.`, broadcasterId);
        return true;
      }
      if (await findTokenAt(broadcasterId, name, x, y)) {
        await sendChatMessage(`@${display} (${x},${y}) is already occupied.`, broadcasterId);
        return true;
      }
    } else {
      const free = await firstFreeCell(broadcasterId, name, map.width, map.height);
      if (!free) {
        await sendChatMessage(`@${display} map "${name}" has no free cells left.`, broadcasterId);
        return true;
      }
      x = free.x;
      y = free.y;
    }
    await upsertMapToken(broadcasterId, name, targetUser, targetDisplay, x, y);
    await sendChatMessage(`@${display} placed ${targetDisplay}'s character on "${name}" at (${x},${y}). ${mapUrl(name)}`, broadcasterId);
    return true;
  }

  if (action === "move") {
    const name = sanitizeMapName(parts[2] ?? "");
    const map = name ? await getMap(broadcasterId, name) : null;
    if (!map) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found.`, broadcasterId);
      return true;
    }
    let rest = parts.slice(3);
    let targetUser = me;
    let targetDisplay = display;
    if (rest[0]?.startsWith("@")) {
      if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can move someone else's token.`, broadcasterId);
        return true;
      }
      targetDisplay = rest[0].slice(1);
      targetUser = targetDisplay.toLowerCase();
      rest = rest.slice(1);
    }
    const x = Number.parseInt(rest[0] ?? "", 10);
    const y = Number.parseInt(rest[1] ?? "", 10);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > map.width || y < 1 || y > map.height) {
      await sendChatMessage(`@${display} usage: !map move <name> <x> <y>, within 1..${map.width} by 1..${map.height}.`, broadcasterId);
      return true;
    }
    const token = await getMapToken(broadcasterId, name, targetUser);
    if (!token) {
      await sendChatMessage(`@${display} ${targetUser === me ? "you're" : `${targetDisplay} is`} not on "${name}" yet — use !map addchar ${name}.`, broadcasterId);
      return true;
    }
    const cells = await getMapCells(broadcasterId, name);
    const terrain = terrainAt(cells, map.default_terrain, x, y);
    if (TERRAINS[terrain]?.blocksMovement) {
      await sendChatMessage(`@${display} (${x},${y}) is ${TERRAINS[terrain].label} and blocks tokens.`, broadcasterId);
      return true;
    }
    const occupant = await findTokenAt(broadcasterId, name, x, y);
    if (occupant && occupant.username !== targetUser) {
      await sendChatMessage(`@${display} (${x},${y}) is already occupied.`, broadcasterId);
      return true;
    }
    await upsertMapToken(broadcasterId, name, targetUser, targetDisplay, x, y);
    await sendChatMessage(`@${display} moved ${targetDisplay}'s character on "${name}" to (${x},${y}).`, broadcasterId);
    return true;
  }

  if (action === "removechar") {
    const name = sanitizeMapName(parts[2] ?? "");
    if (!name || !(await getMap(broadcasterId, name))) {
      await sendChatMessage(`@${display} map "${name || "?"}" was not found.`, broadcasterId);
      return true;
    }
    let targetUser = me;
    let targetDisplay = display;
    if (parts[3]?.startsWith("@")) {
      if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can remove someone else's token.`, broadcasterId);
        return true;
      }
      targetDisplay = parts[3].slice(1);
      targetUser = targetDisplay.toLowerCase();
    }
    if (!(await getMapToken(broadcasterId, name, targetUser))) {
      await sendChatMessage(`@${display} ${targetUser === me ? "you're" : `${targetDisplay} is`} not on "${name}".`, broadcasterId);
      return true;
    }
    await removeMapToken(broadcasterId, name, targetUser);
    await sendChatMessage(`@${display} removed ${targetDisplay}'s character from "${name}".`, broadcasterId);
    return true;
  }

  await sendChatMessage(usage(display), broadcasterId);
  return true;
}
