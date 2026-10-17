// GuildScribe Twitch Extension — shared code for the panel, video overlay and
// config views: talks to the Twitch helper, polls the bot's /ext/state with the
// extension JWT, and renders the parchment sections each view stacks up.
//
// Open any view with ?demo=1 (or ?demo=noshare / ?demo=nohero / ?demo=off)
// outside Twitch to see it with sample data.
(function () {
  "use strict";

  /** The GuildScribe server (EBS). Must also be on the extension's
   *  "Allowlist for URL Fetching Domains" in the Twitch Developer Console. */
  var EBS = "https://guildscribe.tavernworks.dev";
  var POLL_MS = 20000;

  var params = new URLSearchParams(location.search);
  var demo = params.get("demo");
  var twitch = window.Twitch && window.Twitch.ext;
  // Opened straight in a browser (not framed by Twitch): show sample data.
  if (!demo && (!twitch || window.top === window)) demo = "1";

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(a, b) { return b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0; }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function sign(n) { return (n >= 0 ? "+" : "") + n; }
  function bar(cur, max, cls, label) {
    return '<div class="bar ' + (cls || "") + '"><i style="width:' + pct(cur, max).toFixed(1) + '%"></i><span>' +
      esc(label != null ? label : cur + " / " + max) + "</span></div>";
  }
  function sec(title, body, aside) {
    return '<section class="sec"><h2>' + esc(title) + (aside ? '<span class="aside">' + esc(aside) + "</span>" : "") + "</h2>" + body + "</section>";
  }

  var D20 =
    '<svg class="d20" viewBox="0 0 32 32" aria-hidden="true"><polygon points="16,1 30,9 30,23 16,31 2,23 2,9" fill="#8f4210" stroke="#f3dc8e" stroke-width="1.4"/>' +
    '<polygon points="16,7 25,22 7,22" fill="none" stroke="#f3dc8e" stroke-width="1"/><path d="M16 1 16 7M30 9 25 22M2 9 7 22M16 31 7 22M16 31 25 22M2 23 7 22M30 23 25 22M30 9 16 7M2 9 16 7" stroke="#f3dc8e" stroke-width=".7" opacity=".8"/>' +
    '<text x="16" y="19.5" text-anchor="middle" font-size="7" font-weight="700" fill="#fbe9c8" font-family="Georgia,serif">20</text></svg>';

  // ── Section renderers ─────────────────────────────────────────────

  var R = {};

  R.header = function (s) {
    var ch = s && s.channel;
    return '<header class="head">' + D20 + '<div class="grow"><h1>GuildScribe</h1><div class="chan">' +
      (ch ? '<span class="live' + (ch.live ? " on" : "") + '"></span>' + esc(ch.name) + (ch.live ? " · live" : " · offline") : "Guild hall in Twitch chat") +
      "</div></div></header>";
  };

  R.shareCta = function () {
    return '<div class="cta"><p><b>See your own hero here.</b></p>' +
      '<p class="muted small">GuildScribe needs your Twitch name to find your character, gold and party in this channel.</p>' +
      '<button class="btn" data-action="share">Share my Twitch name</button>' +
      '<p class="muted small">New here? Type <code>!createchar</code> in chat.</p></div>';
  };

  R.noHero = function (v) {
    return '<div class="cta"><p><b>' + esc(v.name || "Adventurer") + ", you have no hero yet.</b></p>" +
      '<p>Type <code>!createchar</code> in chat to join the guild.</p>' +
      '<p class="muted small">Then hunt with <code>!hunt</code>, join a party with <code>!party</code>, and check your sheet with <code>!char</code>.</p></div>';
  };

  R.hero = function (v) {
    var c = v.character;
    var xpLabel = c.xpNext ? c.xp + " / " + c.xpNext + " XP" : c.xp + " XP · max level";
    var scores = ["STR", "DEX", "CON", "INT", "WIS", "CHA"].map(function (k) {
      var s = c.scores[k] || { score: 10, mod: 0 };
      return '<div class="score"><div class="k">' + k + '</div><div class="m">' + sign(s.mod) + '</div><div class="v">' + s.score + "</div></div>";
    }).join("");
    var body = '<p class="hero-name">' + esc(v.name) + "</p>" +
      '<div class="hero-sub">Level ' + c.level + " " + esc(c.race) + " " + esc(cap(c.cls)) + "</div>" +
      bar(c.hp, c.hpMax, "", "HP " + c.hp + " / " + c.hpMax) +
      bar(c.xp - c.xpFloor, (c.xpNext || c.xp) - c.xpFloor || 1, "xp", xpLabel) +
      '<div class="chips"><span class="chip">AC <b>' + c.ac + '</b></span><span class="chip">Speed <b>' + c.speed + " ft</b></span>" +
      (v.gold ? '<span class="chip">Purse <b>' + esc(v.gold.text) + "</b>" + (v.gold.rank ? " · #" + v.gold.rank : "") + "</span>" : "") +
      "</div>" + '<div class="scores">' + scores + "</div>";
    var out = '<section class="sec">' + body + "</section>";
    if (v.party) out += R.party(v.party);
    var gear = (c.items || []).concat(c.spells || []);
    if (gear.length) {
      out += sec("Pack & spells", '<div class="chips">' + gear.map(function (g) { return '<span class="chip">' + esc(g) + "</span>"; }).join("") + "</div>");
    }
    return out;
  };

  R.party = function (p) {
    var rows = p.members.map(function (m) {
      return '<div class="member"><div><span class="' + (m.you ? "you" : "") + '">' + esc(m.name) + '</span><div class="meta">' +
        (m.level ? "Lv " + m.level + " " + esc(cap(m.cls)) : "no hero") + "</div></div>" +
        (m.hpMax ? bar(m.hp, m.hpMax, "", m.hp + "/" + m.hpMax) : "") + "</div>";
    }).join("");
    return sec("Party · " + p.name, rows, p.members.length + " strong");
  };

  R.raid = function (r) {
    if (!r) return "";
    var top = (r.contributors || []).slice(0, 3).map(function (c, i) {
      return '<li><span class="n">' + (i + 1) + '</span><span class="who">' + esc(c.name) + '</span><span class="val">' + c.damage + " dmg</span></li>";
    }).join("");
    return sec("Raid boss", '<b>' + esc(r.monster) + '</b> <span class="muted small">CR ' + esc(r.cr) + " · AC " + r.ac + "</span>" +
      bar(r.slain ? 0 : r.hp, r.hpMax, "", r.slain ? "Slain!" : r.hp + " / " + r.hpMax) +
      '<div class="small muted">' + esc(r.state) + "</div>" + (top ? '<ul class="rows">' + top + "</ul>" : ""), r.raids ? r.raids + " raids" : "");
  };

  R.fights = function (fights) {
    if (!fights || !fights.length) return "";
    return fights.map(function (f) {
      var sides = f.sides.map(function (side) {
        return '<div class="fight-side"><div class="lbl">' + esc(side.label) + "</div>" + side.combatants.map(function (c) {
          return '<div class="combatant' + (c.down ? " down" : "") + '"><span class="' + (c.turn ? "turn" : "") + '">' + esc(c.name) + "</span>" +
            bar(c.hp, c.hpMax, "", c.hp + "/" + c.hpMax) + "</div>";
        }).join("") + "</div>";
      }).join("");
      return sec(f.title, sides, f.kind);
    }).join("");
  };

  R.recent = function (list) {
    if (!list || !list.length) return "";
    return sec("Recent battles", '<ul class="rows">' + list.map(function (b) {
      var win = b.outcome === "win";
      return '<li><span class="who">' + esc(b.side) + ' <span class="muted">vs</span> ' + esc(b.foe) + '</span><span class="' + (win ? "outcome-win" : "outcome-loss") + '">' +
        esc(b.outcome === "win" ? "won" : b.outcome === "loss" ? "lost" : b.outcome) + "</span></li>";
    }).join("") + "</ul>");
  };

  R.giveaway = function (g) {
    if (!g) return "";
    if (!g.open && g.winners && g.winners.length) return sec("Giveaway", "<b>" + esc(g.prize) + "</b><div>Won by " + g.winners.map(esc).join(", ") + "</div>");
    if (!g.open) return "";
    return sec("Giveaway open", "<b>" + esc(g.prize) + '</b><div class="small muted">' + esc(g.cost) + " a ticket · " + g.entrants + " entrants · " +
      g.tickets + " tickets</div><div class=\"small\">Type <code>!giveaway enter</code> in chat.</div>");
  };

  R.gold = function (list, you) {
    if (!list || !list.length) return "";
    return sec("Richest adventurers", '<ul class="rows">' + list.map(function (r, i) {
      return '<li><span class="n">' + (i + 1) + '</span><span class="who' + (you && r.name.toLowerCase() === you.toLowerCase() ? " you" : "") + '">' +
        esc(r.name) + '</span><span class="val">' + esc(r.text) + "</span></li>";
    }).join("") + "</ul>");
  };

  R.guild = function (g) {
    if (!g) return "";
    var top = (g.top || []).map(function (h, i) {
      return '<li><span class="n">' + (i + 1) + '</span><span class="who">' + esc(h.name) + ' <span class="muted small">' + esc(h.race) + " " + esc(cap(h.cls)) +
        '</span></span><span class="val">Lv ' + h.level + "</span></li>";
    }).join("");
    return sec("Guild roll", top ? '<ul class="rows">' + top + "</ul>" : '<div class="empty">No heroes yet.</div>', g.characters + " heroes · " + g.parties + " parties");
  };

  R.notConnected = function () {
    return '<div class="cta"><p><b>GuildScribe isn\'t connected to this channel yet.</b></p>' +
      '<p class="muted small">The streamer can raise the guild banner at <b>guildscribe.tavernworks.dev</b>.</p></div>';
  };

  // ── Data: Twitch helper + polling ─────────────────────────────────

  var listeners = [];
  var state = null;
  var auth = null;
  var timer = null;
  var visible = true;

  function emit(err) { listeners.forEach(function (fn) { fn(state, err || null); }); }

  function poll() {
    clearTimeout(timer);
    if (!auth || !visible) return;
    fetch(EBS + "/ext/state", { headers: { Authorization: "Bearer " + auth.token } })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "Bad reply (" + r.status + ")." }; }); })
      .then(function (s) {
        if (s.ok) { state = s; emit(); } else emit(s.error || "GuildScribe is unreachable.");
      })
      .catch(function () { emit("GuildScribe is unreachable right now."); })
      .finally(function () { timer = setTimeout(poll, POLL_MS + Math.random() * 5000); });
  }

  var GS = {
    esc: esc,
    cap: cap,
    R: R,
    demo: demo,
    /** Calls fn(state, error) on every update. */
    onState: function (fn) { listeners.push(fn); if (state) fn(state, null); },
    /** Asks Twitch to share the viewer's identity (the "Share" button). */
    requestShare: function () {
      if (twitch && twitch.actions) twitch.actions.requestIdShare();
      else if (demo) { state = demoState("1"); emit(); }
    },
    refresh: poll,
    start: function () {
      if (demo) { state = demoState(demo); setTimeout(emit, 0); return; }
      twitch.onAuthorized(function (a) {
        var first = !auth;
        // A changed user id means the viewer just shared (or revoked) their identity.
        var changed = auth && auth.userId !== a.userId;
        auth = a;
        if (first || changed) poll();
      });
      if (twitch.onVisibilityChanged) {
        twitch.onVisibilityChanged(function (isVisible) {
          visible = isVisible;
          if (visible) poll(); else clearTimeout(timer);
        });
      }
    },
    twitch: twitch,
  };

  // ── Demo data (outside Twitch, ?demo=…) ──────────────────────────

  function demoState(kind) {
    if (kind === "off") return { ok: true, connected: false };
    var viewer = kind === "noshare" ? { shared: false } : kind === "nohero"
      ? { shared: true, name: "NewAdventurer", character: null, gold: { text: "4 cp", rank: 31 }, party: null }
      : {
        shared: true, name: "Mirelle",
        character: {
          level: 4, race: "Wood Elf", cls: "ranger", hp: 23, hpMax: 34, ac: 15, speed: 35, xp: 3410, xpFloor: 2700, xpNext: 6500,
          scores: { STR: { score: 12, mod: 1 }, DEX: { score: 17, mod: 3 }, CON: { score: 14, mod: 2 }, INT: { score: 10, mod: 0 }, WIS: { score: 15, mod: 2 }, CHA: { score: 8, mod: -1 } },
          items: ["Longbow", "Shortsword", "Potion of Healing"], spells: ["Hunter's Mark"],
        },
        gold: { text: "2 gp 7 sp", rank: 3 },
        party: { name: "the lantern bearers", members: [
          { name: "Mirelle", you: true, level: 4, cls: "ranger", hp: 23, hpMax: 34 },
          { name: "Brannoc", you: false, level: 5, cls: "fighter", hp: 41, hpMax: 44 },
          { name: "Sister_Ivy", you: false, level: 3, cls: "cleric", hp: 9, hpMax: 24 },
        ] },
      };
    return {
      ok: true, connected: true, role: "viewer",
      channel: { id: "1", name: "TavernKeeper", live: true },
      viewer: viewer,
      raid: { monster: "Young Green Dragon", cr: "8", ac: 18, hp: 61, hpMax: 136, raids: 2, slain: false, state: "Ready — type !rally in chat to sound the war horn.",
        contributors: [{ name: "Brannoc", damage: 38 }, { name: "Mirelle", damage: 22 }, { name: "Sister_Ivy", damage: 15 }] },
      battle: [{ kind: "party hunt", title: "The Lantern Bearers vs Owlbear", sides: [
        { label: "Party", combatants: [{ name: "Brannoc", hp: 41, hpMax: 44, turn: true, down: false }, { name: "Sister_Ivy", hp: 9, hpMax: 24, turn: false, down: false }] },
        { label: "Monster", combatants: [{ name: "Owlbear", hp: 30, hpMax: 59, turn: false, down: false }] },
      ] }],
      recent: [
        { kind: "hunt", side: "Mirelle", foe: "Goblin Boss", outcome: "win", note: "+200 XP" },
        { kind: "duel", side: "Brannoc", foe: "Quillon", outcome: "win" },
        { kind: "hunt", side: "Quillon", foe: "Ogre", outcome: "loss" },
      ],
      giveaway: { prize: "Steam key: Baldur's Gate 3", cost: "5 sp", maxTickets: 10, open: true, entrants: 14, tickets: 52, winners: [] },
      gold: [{ name: "Brannoc", text: "9 gp 2 sp" }, { name: "Quillon", text: "6 gp" }, { name: "Mirelle", text: "2 gp 7 sp" }, { name: "Sister_Ivy", text: "1 gp 1 sp" }, { name: "Pipkin", text: "8 sp" }],
      guild: { characters: 42, parties: 6, top: [
        { name: "Brannoc", level: 5, race: "Mountain Dwarf", cls: "fighter" },
        { name: "Mirelle", level: 4, race: "Wood Elf", cls: "ranger" },
        { name: "Quillon", level: 4, race: "Tiefling", cls: "warlock" },
      ] },
    };
  }

  window.GS = GS;
})();
