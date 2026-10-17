// GuildScribe panel: "My Hero" (the viewer's own sheet, purse and party) and
// "The Guild" (raid boss, fights under way, giveaway, leaderboards).
(function () {
  "use strict";
  var R = GS.R;
  var tab = "hero";
  var last = null;
  var $ = function (id) { return document.getElementById(id); };

  function heroTab(s) {
    var v = s.viewer || {};
    if (!v.shared) return R.shareCta();
    if (!v.character) return R.noHero(v) + (v.party ? R.party(v.party) : "");
    return R.hero(v);
  }

  function guildTab(s) {
    var you = s.viewer && s.viewer.name;
    var out = R.raid(s.raid) + R.fights(s.battle) + R.giveaway(s.giveaway) + R.recent(s.recent) + R.gold(s.gold, you) + R.guild(s.guild);
    return out || '<div class="cta muted">The guild hall is quiet. Type <code>!hunt</code> in chat to stir things up.</div>';
  }

  function render() {
    var s = last;
    if (!s) return;
    $("head").innerHTML = R.header(s.connected ? s : null);
    if (!s.connected) { $("body").innerHTML = R.notConnected(); return; }
    var scroll = $("body").scrollTop;
    $("body").innerHTML = tab === "hero" ? heroTab(s) : guildTab(s);
    $("body").scrollTop = scroll;
  }

  document.querySelector(".tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
    $("body").scrollTop = 0;
    render();
  });
  $("body").addEventListener("click", function (e) {
    if (e.target.closest("[data-action=share]")) GS.requestShare();
  });

  $("head").innerHTML = R.header(null);
  GS.onState(function (s, err) {
    $("err").textContent = err || "";
    $("err").classList.toggle("hidden", !err);
    if (s) { last = s; render(); }
  });
  GS.start();
})();
