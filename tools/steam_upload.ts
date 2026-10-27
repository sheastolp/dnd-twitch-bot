// GuildScribe — Steam uploader: sends the games installed on this PC to
// GuildScribe, so chat's !steam can pick one (steam.ts).
//
// Run it on the gaming PC (the dashboard's 🎮 Steam picker page gives the
// exact command, with the channel and uploader key filled in):
//
//   deno run --allow-read --allow-net https://<GuildScribe>/steam/uploader.ts --channel <id> --key <uploader key> [--every 30] [--steam "D:\Steam"]
//
//   --every <minutes>  keep running and re-send that often (otherwise send once)
//   --steam <folder>   where Steam is installed (default: the usual place on Windows, macOS or Linux)
//   --url <base>       the GuildScribe server (default: wherever this script was downloaded from)
//
// Steam keeps its library folders in steamapps/libraryfolders.vdf, and each
// library has one steamapps/appmanifest_<appid>.acf per installed app. Only
// each app's ID and name are sent; nothing else leaves this PC.

const DEFAULT_URL = new URL(import.meta.url).protocol.startsWith("http") ? new URL(import.meta.url).origin : "https://guildscribe.tavernworks.dev";

type Game = { appid: number; name: string };

function args(): { channel: string; key: string; every: number; steam: string; url: string } {
  const a = Deno.args;
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : "";
  };
  const channel = get("--channel");
  const key = get("--key");
  if (!channel || !key) {
    console.error("Usage: --channel <id> --key <uploader key> [--every <minutes>] [--steam <folder>] [--url <server>]\nCopy the full command from the dashboard's 🎮 Steam picker page.");
    Deno.exit(1);
  }
  return { channel, key, every: Number(get("--every")) || 0, steam: get("--steam") || defaultSteamDir(), url: (get("--url") || DEFAULT_URL).replace(/\/+$/, "") };
}

function defaultSteamDir(): string {
  if (Deno.build.os === "windows") return "C:\\Program Files (x86)\\Steam";
  const home = Deno.env.get("HOME") ?? "";
  return Deno.build.os === "darwin" ? `${home}/Library/Application Support/Steam` : `${home}/.steam/steam`;
}

/** Steam's KeyValues text format (.vdf/.acf) → nested objects. */
export function parseVdf(text: string): Record<string, unknown> {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}]/g) ?? [];
  let i = 0;
  const unquote = (t: string) => t.slice(1, -1).replace(/\\(.)/g, "$1");
  const block = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (i < tokens.length && tokens[i] !== "}") {
      const key = unquote(tokens[i++]);
      if (tokens[i] === "{") {
        i++;
        out[key] = block();
        i++; // the closing }
      } else if (i < tokens.length) {
        out[key] = unquote(tokens[i++]);
      }
    }
    return out;
  };
  return block();
}

const sep = Deno.build.os === "windows" ? "\\" : "/";
const join = (...parts: string[]) => parts.join(sep);

async function libraryFolders(steamDir: string): Promise<string[]> {
  const folders = new Set([steamDir]);
  try {
    const vdf = parseVdf(await Deno.readTextFile(join(steamDir, "steamapps", "libraryfolders.vdf")));
    const root = (vdf.libraryfolders ?? vdf.LibraryFolders ?? {}) as Record<string, any>;
    for (const v of Object.values(root)) {
      const path = typeof v === "object" ? v?.path : v; // older Steam stored bare paths
      if (typeof path === "string" && path) folders.add(path);
    }
  } catch (e) {
    console.warn(`Couldn't read libraryfolders.vdf (${(e as Error).message}); checking ${steamDir} only.`);
  }
  return [...folders];
}

async function installedGames(steamDir: string): Promise<Game[]> {
  const games = new Map<number, Game>();
  for (const folder of await libraryFolders(steamDir)) {
    const apps = join(folder, "steamapps");
    try {
      for await (const entry of Deno.readDir(apps)) {
        if (!entry.isFile || !/^appmanifest_\d+\.acf$/i.test(entry.name)) continue;
        try {
          const state = parseVdf(await Deno.readTextFile(join(apps, entry.name))).AppState as Record<string, string> | undefined;
          const appid = Number(state?.appid);
          // StateFlags bit 4 = fully installed (set even while an update is waiting)
          if (!state?.name || !appid || !(Number(state.StateFlags) & 4)) continue;
          games.set(appid, { appid, name: state.name });
        } catch (_) { /* a half-written manifest — skip it */ }
      }
    } catch (e) {
      console.warn(`Skipping library ${folder}: ${(e as Error).message}`);
    }
  }
  return [...games.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function sendOnce(o: ReturnType<typeof args>) {
  const games = await installedGames(o.steam);
  const res = await fetch(`${o.url}/steam/installed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: o.channel, key: o.key, games }),
  });
  const body = await res.json().catch(() => ({}));
  const when = new Date().toLocaleTimeString();
  if (res.ok && body.ok) console.log(`[${when}] Sent ${body.saved} installed game${body.saved === 1 ? "" : "s"} to GuildScribe.`);
  else console.error(`[${when}] GuildScribe refused the list: ${body.error ?? res.status}`);
  return res.status;
}

if (import.meta.main) {
  const o = args();
  const status = await sendOnce(o).catch((e) => (console.error(`Couldn't reach ${o.url}: ${e.message}`), 0));
  if (status === 403 || !o.every) Deno.exit(status === 200 ? 0 : 1);
  console.log(`Re-sending every ${o.every} min. Leave this window open (Ctrl+C to stop).`);
  setInterval(() => sendOnce(o).catch((e) => console.error(`Couldn't reach ${o.url}: ${e.message}`)), o.every * 60_000);
}
