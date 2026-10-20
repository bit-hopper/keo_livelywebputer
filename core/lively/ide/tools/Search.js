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

  // Morphs inside the signed-in user's saved worlds. The /@handle listing
  // already carries each public object's payload, so one request covers every
  // world; private (encrypted) ones have no readable registry and are skipped.
  // Calls thenDo(items), with [] when signed out or on any failure.
  savedWorldItems: function (thenDo) {
    var Search = lively.ide.tools.Search,
      did = lively.identity && lively.identity.did;
    if (!did || !did.isLoggedIn() || !window.fetch) return thenDo([]);
    var handle = did.currentUser().handle;
    fetch("/@" + encodeURIComponent(handle), {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        var out = [];
        (body.objects || []).forEach(function (obj) {
          var registry = obj.type === "world" && obj.record && obj.record.payload && obj.record.payload.registry;
          if (!registry) return;
          var worldName = (obj.state && obj.state.name) || obj.objId,
            url = "/@" + handle + "/" + obj.objId,
            seen = {};
          Object.keys(registry).forEach(function (k) {
            var e = registry[k],
              cls = e && e.__LivelyClassName__;
            if (!cls || !/^lively\.(morphic|identity)\./.test(cls) || /Shape|Layout|StyleSheet|Hand|Trait|Connection/.test(cls)) return;
            var name = Object.isString(e.name) ? e.name : "",
              text = Search.snippet(
                Object.isString(e.textString) ? e.textString : Object.isString(e.storedTextString) ? e.storedTextString : "",
              );
            if (!name && !text) return;
            var shortCls = Search.shortClassName(cls),
              key = name + "|" + shortCls + "|" + text;
            if (seen[key]) return;
            seen[key] = true;
            out.push({
              type: Search.typeOf(cls),
              group: "saved",
              name: name,
              cls: shortCls,
              text: text,
              world: worldName,
              path: null,
              meta: null,
              morph: null,
              url: url,
              run: function () { window.open(url, "_blank"); },
            });
          });
        });
        thenDo(out);
      })
      .catch(function () { thenDo([]); });
  },

  // `name  <Class>  "text"  — in world "X"`: the line the plain list shows.
  listString: function (item) {
    return (
      (item.name || "(unnamed)") + "  <" + item.cls + ">" +
      (item.text ? "  \"" + item.text + "\"" : "") +
      (item.world ? "  — in world \"" + item.world + "\"" : "")
    );
  },

});

});
