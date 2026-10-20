// GuildScribe video overlay: a small pill on the right of the player (raid
// boss HP, the fight under way or The Endless Delve's floor at a glance) that
// opens a card with the live state, the viewer's own hero and the leaderboards. Follows Twitch's player
// controls: it fades out with them unless the card is open.
(function () {
  "use strict";
  var R = GS.R;
  var tab = "live";
  var last = null;
  var open = false;
  var controls = true;
  var $ = function (id) { return document.getElementById(id); };

  $("pill-icon").innerHTML = R.header(null).match(/<svg[\s\S]*?<\/svg>/)[0];

  function setOpen(v) {
    open = v;
    $("card").classList.toggle("hidden", !open);
    $("pill").setAttribute("aria-expanded", String(open));
    $("pill").classList.toggle("hidden", open);
    syncDock();
    if (open) render();
  }

  function syncDock() {
    $("dock").classList.toggle("away", !open && !controls);
  }

  function pill(s) {
    var sub = "Guild hall", hp = null;
    if (s && s.connected) {
      var fight = s.battle && s.battle[0];
      if (s.raid && !s.raid.slain) { sub = "Raid: " + s.raid.monster; hp = s.raid.hp / s.raid.hpMax; }
      else if (fight) {
        var foe = fight.sides[fight.sides.length - 1].combatants[0];
        sub = "⚔ " + fight.title;
        if (foe) hp = foe.hp / foe.hpMax;
      } else if (s.giveaway && s.giveaway.open) sub = "Giveaway: " + s.giveaway.prize;
      else if (s.delve && s.delve.running) { sub = "Delve: floor " + s.delve.floor; hp = s.delve.hp / s.delve.hpMax; }
      else if (s.viewer && s.viewer.character) sub = "Lv " + s.viewer.character.level + " " + GS.cap(s.viewer.character.cls);
    }
    $("pill-sub").textContent = sub;
    $("pill-bar").classList.toggle("hidden", hp == null);
    if (hp != null) $("pill-bar").firstChild.style.width = (Math.max(0, Math.min(1, hp)) * 100).toFixed(1) + "%";
  }

  function liveTab(s) {
    var out = R.raid(s.raid) + R.fights(s.battle) + R.delve(s.delve, s.viewer && s.viewer.name, true) + R.giveaway(s.giveaway) + R.recent(s.recent);
    return out || '<div class="cta muted">No raid or fight under way. Type <code>!hunt</code> in chat to start one.</div>';
  }
  function heroTab(s) {
    var v = s.viewer || {};
    if (!v.shared) return R.shareCta();
    if (!v.character) return R.noHero(v);
    return R.hero(v);
  }
  function boardTab(s) {
    return (R.gold(s.gold, s.viewer && s.viewer.name) + R.guild(s.guild)) || '<div class="cta muted">No leaderboards yet.</div>';
  }

  function render() {
    var s = last;
    pill(s);
    if (!open || !s) return;
    $("head").innerHTML = R.header(s.connected ? s : null);
    if (!s.connected) { $("body").innerHTML = R.notConnected(); return; }
    var scroll = $("body").scrollTop;
    $("body").innerHTML = tab === "live" ? liveTab(s) : tab === "hero" ? heroTab(s) : boardTab(s);
    $("body").scrollTop = scroll;
  }

  $("pill").addEventListener("click", function () { setOpen(true); });
  $("close").addEventListener("click", function () { setOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) setOpen(false); });
  document.querySelector(".card .tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".card .tabs button").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
    $("body").scrollTop = 0;
    render();
  });
  $("body").addEventListener("click", function (e) {
    if (e.target.closest("[data-action=share]")) GS.requestShare();
  });

  if (GS.twitch && !GS.demo) {
    GS.twitch.onContext(function (ctx, changed) {
      if (changed.indexOf("arePlayerControlsVisible") !== -1 || changed.length === 0) {
        controls = ctx.arePlayerControlsVisible !== false;
        syncDock();
      }
    });
  }

  GS.onState(function (s, err) {
    $("err").textContent = err || "";
    $("err").classList.toggle("hidden", !err);
    if (s) { last = s; render(); }
  });
  GS.start();
})();
