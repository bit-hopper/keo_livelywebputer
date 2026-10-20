module('lively.ide.tools.Search').requires().toRun(function () {

// Candidate building for the search palette and the morph search command.
// No UI here: every function returns plain items of one shape,
//   {type, group, name, cls, text, world, path, meta, run, morph, url}
// where run() is the item's primary action.

Object.extend(lively.ide.tools.Search, {

  SNIPPET_LENGTH: 60,

  // `lively.morphic.Foo` / `lively.identity.Foo` -> `Foo`
  shortClassName: function (cls) {
    return String(cls || "morph").replace(/^lively\.(morphic|identity)\./, "");
  },

  // Result type (search.md §3.2) for a class name; drives icon and tint.
  typeOf: function (cls) {
    cls = lively.ide.tools.Search.shortClassName(cls);
    if (/Window/.test(cls)) return "window";
    if (/Image/.test(cls)) return "image";
    if (/Button/.test(cls)) return "button";
    if (/Text|Label/.test(cls)) return "text";
    return "box";
  },

  snippet: function (text) {
    var Search = lively.ide.tools.Search;
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text.length > Search.SNIPPET_LENGTH ? text.slice(0, Search.SNIPPET_LENGTH) + "…" : text;
  },

  // Bring a live morph into view and show its halo.
  showMorph: function (morph) {
    if (!morph || !morph.world()) return;
    var win = morph.getWindow && morph.getWindow();
    if (win) win.comeForward();
    else morph.bringToFront();
    morph.showHalos();
  },

  // Morphs in the current world that have a name or text.
  worldItems: function () {
    var Search = lively.ide.tools.Search;
    function textOf(ea) {
      return ea.isText && Object.isString(ea.textString) ? ea.textString.replace(/\s+/g, " ").trim() : "";
    }
    return $world
      .withAllSubmorphsSelect(function (ea) {
        return (
          ea !== $world &&
          ((Object.isString(ea.name) && ea.name !== "") || textOf(ea) !== "") &&
          !ea.isHalo &&
          !ea.isEpiMorph &&
          !/^NarrowList/.test(ea.name) &&
          !(ea.ownerChain && ea.ownerChain().some(function (o) { return o.isHalo || /^NarrowList/.test(o.name); }))
        );
      })
      .map(function (ea) {
        var cls = (ea.constructor.type || "morph").replace(/^lively\.morphic\./, "");
        return {
          type: Search.typeOf(cls),
          group: "world",
          name: ea.name || "",
          cls: cls,
          text: Search.snippet(textOf(ea)),
          world: null,
          path: null,
          meta: null,
          morph: ea,
          url: null,
          run: function () { Search.showMorph(ea); },
        };
      });
  },

  // "3 days ago" for an ISO date; "" when it can't be read.
  ago: function (iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return mins <= 1 ? "just now" : mins + " minutes ago";
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    var years = Math.round(months / 12);
    return years + (years === 1 ? " year ago" : " years ago");
  },

  // The signed-in user's saved worlds, from two requests made together:
  //  - GET /@handle: whole envelopes. Each public world's payload carries a
  //    registry, which gives the morphs inside it (and a morph count). Private
  //    (encrypted) worlds have no readable registry, so contribute no morphs.
  //  - GET /@handle/worlds: metadata only, every world the user may open,
  //    private ones included, with its plaintext name.
  // Calls thenDo({ morphs: [...], worlds: [...] }); both are [] when signed out,
  // and either half is [] if its request fails. opts.worlds === false skips the
  // /worlds request.
  fetchSaved: function (thenDo, opts) {
    var Search = lively.ide.tools.Search,
      did = lively.identity && lively.identity.did;
    if (!did || !did.isLoggedIn() || !window.fetch) return thenDo({ morphs: [], worlds: [] });
    var handle = did.currentUser().handle,
      base = "/@" + encodeURIComponent(handle),
      counts = {}, morphs = [], worldList = [],
      wantWorlds = !opts || opts.worlds !== false,
      pending = wantWorlds ? 2 : 1;

    function getJSON(url) {
      return fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .catch(function () { return {}; });
    }
    function done() {
      if (--pending) return;
      var worlds = worldList.map(function (w) {
        var url = "/@" + handle + "/" + w.objId,
          name = w.name || w.objId,
          n = counts[w.objId],
          bits = [];
        if (n != null) bits.push(n + (n === 1 ? " morph" : " morphs"));
        if (w.visibility && w.visibility !== "public") bits.push("private");
        var when = Search.ago(w.created);
        if (when) bits.push("created " + when);
        return {
          type: "world", group: "worlds", name: name, cls: "World", text: "", world: null,
          path: null, meta: bits.join("  ·  "), morph: null, url: url,
          run: function () { window.open(url, "_blank"); },
        };
      });
      thenDo({ morphs: morphs, worlds: worlds });
    }

    getJSON(base).then(function (body) {
      (body.objects || []).forEach(function (obj) {
        var registry = obj.type === "world" && obj.record && obj.record.payload && obj.record.payload.registry;
        if (!registry) return;
        var worldName = (obj.state && obj.state.name) || obj.objId,
          url = "/@" + handle + "/" + obj.objId,
          seen = {}, count = 0;
        Object.keys(registry).forEach(function (k) {
          var e = registry[k],
            cls = e && e.__LivelyClassName__;
          if (!cls || !/^lively\.(morphic|identity)\./.test(cls) || /Shape|Layout|StyleSheet|Hand|Trait|Connection/.test(cls)) return;
          if (!/\.World$/.test(cls)) count++;   // every morph counts toward the world's size; only named / text-bearing ones are searchable
          var name = Object.isString(e.name) ? e.name : "",
            text = Search.snippet(
              Object.isString(e.textString) ? e.textString : Object.isString(e.storedTextString) ? e.storedTextString : "",
            );
          if (!name && !text) return;
          var shortCls = Search.shortClassName(cls),
            key = name + "|" + shortCls + "|" + text;
          if (seen[key]) return;
          seen[key] = true;
          morphs.push({
            type: Search.typeOf(cls), group: "saved", name: name, cls: shortCls, text: text,
            world: worldName, path: null, meta: null, morph: null, url: url,
            run: function () { window.open(url, "_blank"); },
          });
        });
        counts[obj.objId] = count;
      });
      done();
    });
    if (wantWorlds) getJSON(base + "/worlds").then(function (body) {
      worldList = Array.isArray(body.worlds) ? body.worlds : [];
      done();
    });
  },

  // Just the morphs inside saved worlds (what the plain morph search lists).
  // Calls thenDo(items), with [] when signed out or on any failure.
  savedWorldItems: function (thenDo) {
    lively.ide.tools.Search.fetchSaved(function (saved) { thenDo(saved.morphs); }, { worlds: false });
  },

  // `name  <Class>  "text"  — in world "X"`: the line the plain list shows.
  listString: function (item) {
    if (item.type === "world") return item.name + "  <World>" + (item.meta ? "  " + item.meta : "");
    return (
      (item.name || "(unnamed)") + "  <" + item.cls + ">" +
      (item.text ? "  \"" + item.text + "\"" : "") +
      (item.world ? "  — in world \"" + item.world + "\"" : "")
    );
  },

});

});
