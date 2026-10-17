// GuildScribe config view (broadcaster's Extensions → Configure): shows
// whether GuildScribe is connected to the channel. Nothing to save.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  $("head").innerHTML = GS.R.header(null);
  GS.onState(function (s, err) {
    if (err) { $("status").innerHTML = '<span class="bad">Couldn\'t reach GuildScribe:</span> ' + GS.esc(err); return; }
    if (!s) return;
    $("head").innerHTML = GS.R.header(s.connected ? s : null);
    $("status").innerHTML = s.connected
      ? '<span class="ok">✓ Connected.</span> GuildScribe is in ' + GS.esc(s.channel.name) + "'s chat; the panel and overlay are live."
      : '<span class="bad">Not connected yet.</span> Open <b>guildscribe.tavernworks.dev</b> and raise the guild banner, then reopen this page.';
  });
  GS.start();
})();
