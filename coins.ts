// Coin math shared by points.ts (balances, giveaways) and haggle.ts (prices).
//
// Every balance and price is stored and computed as a single integer number
// of COPPER. Gold and silver are purely a display/input convenience, using
// the D&D 5e exchange rates: 10 cp = 1 sp, 10 sp = 1 gp (so 100 cp = 1 gp).

export const COPPER_PER_SILVER = 10;
export const COPPER_PER_GOLD = 100;

/** Largest amount accepted anywhere (copper): keeps arithmetic far from
 * Number's unsafe-integer range. 10,000,000 gp. */
export const MAX_COPPER = 1_000_000_000;

/** 123 -> "1 gp 2 sp 3 cp"; 0 -> "0 cp"; 100 -> "1 gp". */
export function formatCoins(copper: number): string {
  const total = Math.max(0, Math.floor(copper));
  const gp = Math.floor(total / COPPER_PER_GOLD);
  const sp = Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER);
  const cp = total % COPPER_PER_SILVER;
  const parts: string[] = [];
  if (gp) parts.push(`${gp.toLocaleString("en-US")} gp`);
  if (sp) parts.push(`${sp} sp`);
  if (cp || !parts.length) parts.push(`${cp} cp`);
  return parts.join(" ");
}

const UNIT_VALUE: Record<string, number> = {
  gp: COPPER_PER_GOLD, g: COPPER_PER_GOLD, gold: COPPER_PER_GOLD,
  sp: COPPER_PER_SILVER, s: COPPER_PER_SILVER, silver: COPPER_PER_SILVER,
  cp: 1, c: 1, copper: 1, coppers: 1,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
};

// "<number> <unit>" where the number is digits or a number word, and the unit
// may be followed by "piece(s)"/"coin(s)" ("five copper pieces").
const AMOUNT_RE = new RegExp(
  `\\b(\\d{1,10}|${Object.keys(NUMBER_WORDS).join("|")})\\s*(gold|gp|g|silver|sp|s|copper|coppers|cp|c)\\b(?:\\s+(?:pieces?|coins?))?`,
  "gi",
);

function amountOf(numberToken: string, unitToken: string): number {
  const n = /^\d+$/.test(numberToken) ? Number(numberToken) : (NUMBER_WORDS[numberToken.toLowerCase()] ?? 0);
  return n * (UNIT_VALUE[unitToken.toLowerCase()] ?? 0);
}

/**
 * Strict parser for typed amounts: "50" (bare = copper), "5sp", "1gp",
 * "1 gp 2 sp 3 cp", "1g2s3c". Returns copper, or null if anything in the
 * string isn't a recognized amount. Zero is allowed here; callers decide
 * whether a zero is meaningful.
 */
export function parseCoins(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/^\d{1,10}$/.test(text)) {
    const n = Number(text);
    return n <= MAX_COPPER ? n : null;
  }
  // Every character must belong to a "<digits><unit>" group.
  const strict = /(\d{1,10})\s*(gp|g|sp|s|cp|c)(?![a-z])/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = strict.exec(text)) !== null) {
    if (text.slice(consumed, m.index).trim() !== "") return null;
    total += Number(m[1]) * UNIT_VALUE[m[2]];
    consumed = m.index + m[0].length;
  }
  if (consumed === 0 || text.slice(consumed).trim() !== "") return null;
  return total <= MAX_COPPER ? total : null;
}

/**
 * Finds the first price in free text and returns it in copper: handles
 * "5 copper", "five copper", "2 silver", "1 silver 2 copper", "1 gold and 5
 * silver", "3cp". Used for both the peddler's listed price ("1 silver 2
 * copper") and the offer buried in a viewer's haggle pitch. Null if the text
 * names no amount.
 */
export function parseFirstPrice(text: string): number | null {
  AMOUNT_RE.lastIndex = 0;
  let total = 0;
  let found = false;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    // Stop once a later amount is separated from the group by real words.
    if (found && !/^\s*(?:,|and|&|\+)?\s*$/i.test(text.slice(lastEnd, m.index))) break;
    total += amountOf(m[1], m[2]);
    lastEnd = m.index + m[0].length;
    found = true;
  }
  return found && total > 0 && total <= MAX_COPPER ? total : null;
}
