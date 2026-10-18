// GuildScribe — Sery_Bot-style fun commands (dashboard group "funstuff"):
//   !coinflip                     heads or tails
//   !flip <text> / !angryflip <text> / !unflip   upside-down text and table flips
//   !jumble <text>                scrambles the letters of each word
//   !tempc <°F>  /  !tempf <°C>   temperature conversion
//   !dadjoke                      a dad joke (icanhazdadjoke.com)
//   !<animal>fact / !animalfact   a fact (built in — see FACTS)
//   !catpic !dogpic !foxpic !duckpic !capybarapic   a random picture link
//   "good bot" / "bad bot"        a short reply (plain chat, see maybeBotBanter)
// A channel's own custom command with the same name always wins.

import { getCustomCommand } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

const UPSIDE: Record<string, string> = {
  a: "ɐ", b: "q", c: "ɔ", d: "p", e: "ǝ", f: "ɟ", g: "ƃ", h: "ɥ", i: "ᴉ", j: "ɾ", k: "ʞ", l: "l", m: "ɯ", n: "u", o: "o", p: "d", q: "b", r: "ɹ",
  s: "s", t: "ʇ", u: "n", v: "ʌ", w: "ʍ", x: "x", y: "ʎ", z: "z", A: "∀", B: "ᗺ", C: "Ɔ", D: "ᗡ", E: "Ǝ", F: "Ⅎ", G: "⅁", H: "H", I: "I", J: "ſ",
  K: "ꓘ", L: "˥", M: "W", N: "N", O: "O", P: "Ԁ", Q: "Ό", R: "ᴚ", S: "S", T: "⊥", U: "∩", V: "Λ", W: "M", X: "X", Y: "⅄", Z: "Z",
  "1": "Ɩ", "2": "ᄅ", "3": "Ɛ", "4": "ㄣ", "5": "ϛ", "6": "9", "7": "ㄥ", "8": "8", "9": "6", "0": "0",
  ".": "˙", ",": "'", "'": ",", "\"": "„", "?": "¿", "!": "¡", "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "&": "⅋", "_": "‾",
};
export const flipText = (s: string) => [...s].reverse().map((c) => UPSIDE[c] ?? c).join("");

export function jumble(s: string): string {
  return s.split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w) || w.length < 2) return w;
    const cs = [...w];
    for (let tries = 0; tries < 5; tries++) {
      for (let i = cs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cs[i], cs[j]] = [cs[j], cs[i]];
      }
      if (cs.join("") !== w || new Set(cs).size === 1) break;
    }
    return cs.join("");
  }).join("");
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

const FACTS: Record<string, string[]> = {
  cat: [
    "A group of cats is called a clowder.",
    "Cats can't taste sweetness — they're missing the receptor for it.",
    "Cats sleep for around 12 to 16 hours a day.",
    "A cat's whiskers are roughly as wide as its body, which helps it judge tight gaps.",
  ],
  dog: [
    "Every dog's nose print is unique, like a human fingerprint.",
    "Dogs sweat mainly through the pads of their paws.",
    "Basenjis don't bark — they make a yodel-like sound instead.",
    "Dogs can hear much higher-pitched sounds than people can.",
  ],
  otter: [
    "Sea otters hold paws while they sleep so they don't drift apart.",
    "Sea otters have the densest fur of any animal — up to about a million hairs per square inch.",
    "Sea otters use rocks as tools to crack open shellfish.",
    "A group of otters resting in the water is called a raft.",
  ],
  penguin: [
    "Emperor penguins can dive deeper than 500 metres.",
    "Male emperor penguins keep the egg warm on their feet for about two months.",
    "Penguins can drink seawater — a gland above their eyes filters out the salt.",
    "Gentoo penguins are the fastest-swimming birds, at up to about 35 km/h.",
  ],
  sloth: [
    "Sloths can hold their breath for up to 40 minutes.",
    "Sloths climb down from the trees only about once a week, to go to the bathroom.",
    "Algae grows in sloth fur, giving them a green tint that helps them hide.",
  ],
  owl: [
    "Owls can't move their eyes, so they turn their heads instead — up to about 270 degrees.",
    "A group of owls is called a parliament.",
    "Many owls have one ear higher than the other, which helps them pinpoint sounds.",
    "Soft, fringed feather edges make an owl's flight almost silent.",
  ],
  shark: [
    "Sharks have been around for more than 400 million years — longer than trees.",
    "Sharks have no bones; their skeletons are made of cartilage.",
    "Some sharks go through tens of thousands of teeth in a lifetime.",
    "Greenland sharks can live for several hundred years.",
  ],
  frog: [
    "Frogs absorb water through their skin instead of drinking it.",
    "Wood frogs can freeze solid in winter and thaw out alive in spring.",
    "Frogs pull their eyes down into their heads to help push food down when they swallow.",
  ],
  cow: [
    "A cow's stomach has four compartments.",
    "Cows spend around eight hours a day chewing their cud.",
    "Cows can see almost all the way around them — about 330 degrees.",
  ],
  duck: [
    "Ducks keep their feathers waterproof with oil from a gland near the tail.",
    "Ducklings imprint on the first moving thing they see.",
    "Ducks can sleep with one eye open, keeping half their brain awake to watch for danger.",
    "A duck's quack does echo — the old myth is wrong.",
  ],
  fox: [
    "Arctic foxes change coat colour with the seasons: white in winter, brown in summer.",
    "Baby foxes are called kits.",
    "A fox's bushy tail is called a brush.",
    "Red foxes seem to use Earth's magnetic field to aim pounces at prey hidden under snow.",
  ],
  panda: [
    "Giant pandas eat roughly 12 to 38 kg of bamboo a day.",
    "Pandas grip bamboo with a 'pseudo-thumb' — an enlarged wrist bone.",
    "A newborn panda is about 1/900th the weight of its mother.",
    "Pandas eat almost nothing but bamboo, yet have the digestive system of a carnivore.",
  ],
  capybara: [
    "Capybaras are the largest rodents in the world.",
    "Capybaras have partly webbed feet and are excellent swimmers.",
    "Capybaras can stay underwater for up to five minutes.",
  ],
  axolotl: [
    "Axolotls can regrow lost limbs and even parts of their heart and brain.",
    "Axolotls keep their feathery gills and other larval features their whole lives.",
    "Wild axolotls live only in the lakes and canals of Xochimilco, near Mexico City.",
  ],
  bee: [
    "Honeybees tell each other where flowers are with a 'waggle dance'.",
    "Honeybees have five eyes: two big compound eyes and three small ones on top of the head.",
    "A worker honeybee makes only about a twelfth of a teaspoon of honey in her life.",
  ],
  dolphin: [
    "Dolphins sleep with one half of their brain at a time.",
    "Bottlenose dolphins have signature whistles that work a lot like names.",
    "Dolphins find food by echolocation — clicking and listening for the echo.",
  ],
  wolf: [
    "A wolf pack is usually a family: a breeding pair and their offspring.",
    "Wolves can run at around 50 to 60 km/h in short bursts.",
    "A wolf's howl can carry for kilometres across open ground.",
  ],
  raccoon: [
    "Raccoons' front paws are packed with nerve endings, and wetting them makes them even more sensitive.",
    "Raccoons can remember how to solve a puzzle for up to three years.",
    "A group of raccoons is called a gaze.",
  ],
  octopus: [
    "An octopus has three hearts and blue blood.",
    "Most of an octopus's neurons are in its arms, not its brain.",
    "Octopuses can change colour and skin texture in a fraction of a second.",
  ],
};
const FACT_ALIASES: Record<string, string> = { kitty: "cat", puppy: "dog", doggo: "dog", seaotter: "otter", capy: "capybara", bees: "bee", honeybee: "bee", redfox: "fox" };

const PICS: Record<string, { url: string; get: (j: any) => string }> = {
  cat: { url: "https://api.thecatapi.com/v1/images/search", get: (j) => j?.[0]?.url },
  dog: { url: "https://dog.ceo/api/breeds/image/random", get: (j) => j?.message },
  fox: { url: "https://randomfox.ca/floof/", get: (j) => j?.image },
  duck: { url: "https://random-d.uk/api/v2/random", get: (j) => j?.url },
  capybara: { url: "https://api.capy.lol/v1/capybara?json=true", get: (j) => j?.data?.url },
};

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "GuildScribe (https://guildscribe.tavernworks.dev)", ...headers }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(String(res.status));
  return await res.json();
}

const COIN = ["🪙 Heads!", "🪙 Tails!"];

export async function handleFunCommand(chatMessage: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!([a-z0-9]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  const factKey = word.endsWith("fact") ? (FACT_ALIASES[word.slice(0, -4)] ?? word.slice(0, -4)) : "";
  const picKey = word.endsWith("pic") ? (FACT_ALIASES[word.slice(0, -3)] ?? word.slice(0, -3)) : "";
  const known = ["coinflip", "flip", "angryflip", "unflip", "jumble", "tempc", "tempf", "dadjoke", "animalfact"].includes(word) ||
    (factKey && FACTS[factKey]) || (picKey && PICS[picKey]);
  if (!known) return false;
  if (await getCustomCommand(broadcasterId, word)) return false; // the channel's own command wins
  const say = (text: string) => sendChatMessage(text, broadcasterId);

  switch (word) {
    case "coinflip":
      await say(`@${display} ${pick(COIN)}`);
      return true;
    case "flip":
      await say(rest ? flipText(rest.slice(0, 200)) : `@${display} (╯°□°)╯︵ ┻━┻`);
      return true;
    case "angryflip":
      await say(`(ノಠ益ಠ)ノ彡 ${rest ? flipText(rest.slice(0, 200)) : "┻━┻"}`);
      return true;
    case "unflip":
      await say("┬─┬ノ( º _ ºノ)");
      return true;
    case "jumble":
      await say(rest ? jumble(rest.slice(0, 200)) : `@${display} give me something to jumble: !jumble <text>`);
      return true;
    case "tempc":
    case "tempf": {
      const n = Number(rest.replace(/°?\s*[cf]$/i, "").replace(",", "."));
      if (!rest || !Number.isFinite(n)) {
        await say(`@${display} use ${word === "tempc" ? "!tempc 72 (°F → °C)" : "!tempf 22 (°C → °F)"}`);
        return true;
      }
      await say(word === "tempc" ? `@${display} ${fmt(n)}°F is ${fmt((n - 32) * 5 / 9)}°C` : `@${display} ${fmt(n)}°C is ${fmt(n * 9 / 5 + 32)}°F`);
      return true;
    }
    case "dadjoke": {
      try {
        const j = await getJson("https://icanhazdadjoke.com/");
        await say(`@${display} ${String(j?.joke ?? "").slice(0, 400) || "I'm all out of dad jokes. That's the joke."}`);
      } catch (_) {
        await say(`@${display} the dad joke server is napping in its recliner. Try again in a bit.`);
      }
      return true;
    }
  }
  if (word === "animalfact" || (factKey && FACTS[factKey])) {
    const key = word === "animalfact" ? pick(Object.keys(FACTS)) : factKey;
    await say(`@${display} ${word === "animalfact" ? `${key[0].toUpperCase()}${key.slice(1)} fact: ` : ""}${pick(FACTS[key])}`);
    return true;
  }
  const pic = PICS[picKey];
  try {
    const url = String(pic.get(await getJson(pic.url)) ?? "").replace(/^http:\/\//, "https://");
    await say(url ? `@${display} ${url}` : `@${display} couldn't find a ${picKey} picture right now.`);
  } catch (_) {
    await say(`@${display} couldn't find a ${picKey} picture right now — try again in a bit.`);
  }
  return true;
}

const banterCooldown = new Map<string, number>();
const GOOD = ["Thank you! 💜", "*happy bot noises*", "Aw, shucks. Beep boop.", "I'll tell the other bots you said that."];
const BAD = ["😢 I'm trying my best.", "*sad beep*", "I'll do better, I promise.", "Noted. Filed under 'feedback'."];

/** "good bot" / "bad bot" (optionally with the bot's name). True when it replied. */
export async function maybeBotBanter(chatMessage: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().toLowerCase().match(/^(?:@?guildscribe(?:bot)?[,!]?\s+)?(good|bad) bot[.!]*(?:\s+@?guildscribe(?:bot)?)?$/);
  if (!m) return false;
  const now = Date.now();
  if (now - (banterCooldown.get(broadcasterId) ?? 0) < 30_000) return false;
  banterCooldown.set(broadcasterId, now);
  await sendChatMessage(pick(m[1] === "good" ? GOOD : BAD), broadcasterId);
  return true;
}

/** Command words for the dashboard group. */
export const FUN_WORDS = [
  "coinflip", "flip", "angryflip", "unflip", "jumble", "tempc", "tempf", "dadjoke", "animalfact",
  ...Object.keys(FACTS).map((k) => `${k}fact`), ...Object.keys(FACT_ALIASES).filter((a) => FACTS[FACT_ALIASES[a]]).map((a) => `${a}fact`),
  ...Object.keys(PICS).map((k) => `${k}pic`), ...Object.keys(FACT_ALIASES).filter((a) => PICS[FACT_ALIASES[a]]).map((a) => `${a}pic`),
];
