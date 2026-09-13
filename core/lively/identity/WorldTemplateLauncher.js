/**
 * lively.identity.WorldTemplateLauncher
 *
 * Runs once per fresh world-page load (hooked from MenuBarEntry.js, the
 * established "run once identity/menu infrastructure is up" point in this
 * codebase — see AmbientPresencePanel.init()/UploadMigration in that file).
 * Checks the URL for a `?template=` param left behind by WorldsBrowser.js's
 * create-world flow (Create -> Template -> Shop) and, if present, auto-opens
 * the matching preset into the now-current $world, then strips the param via
 * history.replaceState so a plain reload of the same URL never re-triggers it.
 *
 * "shop" and "inventory" are implemented — WorldsBrowser.js's template
 * picker never sends any other key (gallery/movie/books/game are rendered
 * as inert placeholders there), so no other case is needed yet.
 */

module("lively.identity.WorldTemplateLauncher")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.SignedSerializer",
  )
  .toRun(function () {

    Object.extend(lively.identity.WorldTemplateLauncher, {

      runIfRequested: function runIfRequested() {
        if (this._launched) return;
        var params = new URLSearchParams(location.search);
        var template = params.get("template");
        if (!template) return;
        this._launched = true;

        // Strip immediately so a later plain reload of this world's URL
        // never re-triggers this (idempotency), regardless of when the
        // actual launch below finishes. Built via URLSearchParams + manual
        // path reassembly, NOT `new URL(...).searchParams` -- confirmed
        // live that in this environment a real URL instance has no
        // searchParams accessor at all ('searchParams' in new URL(...) is
        // false), even though standalone URLSearchParams works fine.
        params.delete("template");
        var qs = params.toString();
        var newUrl = location.pathname + (qs ? "?" + qs : "") + location.hash;
        window.history.replaceState(null, "", newUrl);

        lively.identity.WorldTemplateLauncher._launchTemplate(template);
      },

      _launchTemplate: function _launchTemplate(template) {
        if (template === "shop") {
          lively.require("lively.commerce.Shop").toRun(function () {
            lively.commerce.Shop.open();
            lively.identity.WorldTemplateLauncher._saveCurrentWorld();
          });
        } else if (template === "inventory") {
          // Just opens the browsing tool -- no _saveCurrentWorld() here,
          // unlike "shop": nothing permanent has been added to the world
          // yet at this point, only a floating tool window the user still
          // has to actually drag a part out of. That drag (or a later
          // explicit "Save world") is what makes anything worth persisting.
          lively.require("lively.identity.Inventory").toRun(function () {
            lively.identity.Inventory.open();
          });
        }
      },

      // Persists $world right after a template adds real content to it.
      // Without this, the template morph (e.g. Shop) only exists in memory
      // for this one page view and silently disappears on the next plain
      // reload -- confirmed live -- since nothing else re-saves the world
      // after WorldsBrowser.js's own create-world PUT (which only wrote the
      // pre-template blank JSO). Mirrors Widgets.js's "Save world" menu
      // action: fetch the existing envelope for the prevCid chain, sign,
      // PUT in place.
      _saveCurrentWorld: function _saveCurrentWorld() {
        var parsed = lively.identity.webKey.parseObjectUrl(window.location.href);
        if (!parsed || !parsed.objId) return;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var handle = parsed.handle;
        var objId = parsed.objId;
        fetch("/@" + handle + "/" + objId, { credentials: "include", headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (prevEnvelope) {
            var ss = lively.identity.signedSerializer;
            var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
            // $world.name is a plain Morph property (defaults to "world"),
            // NOT kept in sync with the display name stored in
            // envelope.state.name on load -- confirmed live, a save that
            // used $world.name here silently reverted a freshly created
            // world's real name back to "world". Preserve the name already
            // on record instead, same defensive "keep it from prevEnvelope"
            // idiom SignedSerializer.js itself already uses for `created`.
            var existingName = prevEnvelope && prevEnvelope.state && prevEnvelope.state.name;
            ss.serializeToEnvelope({
              obj: $world,
              type: "world",
              objId: objId,
              publicKeyJwk: method ? method.publicKeyJwk : null,
              prevEnvelope: prevEnvelope && prevEnvelope.record ? prevEnvelope : null,
              stateMeta: { name: existingName || $world.name || "world" },
            }, function (err, envelope) {
              if (err) {
                console.warn("[WorldTemplateLauncher] Could not save template world:", err.message);
                return;
              }
              fetch("/@" + handle + "/" + objId, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(envelope),
              }).catch(function (e) {
                console.warn("[WorldTemplateLauncher] Save failed:", e.message);
              });
            });
          });
      },

    });

  }); // end module('lively.identity.WorldTemplateLauncher')
