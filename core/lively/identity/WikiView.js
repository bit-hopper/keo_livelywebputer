/**
 * lively.identity.WikiView
 *
 * Read-only wiki-page morph — the counterpart to WikiEditor (editing-only).
 * Split out of lively.identity.PostCardView when wiki pages became their
 * own envelope type (type: 'wikipage') instead of a type:'postcard' +
 * state.wikiName combination. Simpler than PostCardView in two ways that
 * both follow from wiki pages' own design (WikiSerializer.js):
 *
 *   - No flip/back-face card mechanic. A wiki page isn't a postcard you
 *     flip over — its crypto/meta details live in an in-page collapsible
 *     header instead (open by default), below the title: an Author row
 *     (the genesis creator, per WikiSerializer.js's "did stays fixed at
 *     genesis"), a Contributors row (other constellation members who have
 *     saved the page, avatars stacked horizontally), then CID/Updated/
 *     Constellation rows and the verify badge. See _buildDetails.
 *   - No reactions/tip-jar footer, no encrypted-content lock placeholder —
 *     wiki pages are always public/unencrypted, and reactions/tip-jar are
 *     postcard-only social features that never applied to wiki pages.
 *
 * Contributors/last-editor data: envelope.did never changes from the
 * genesis author (WikiSerializer.js), so per-save attribution can't come
 * from that field. IdentityServer.js's PUT /@:handle/:objId now maintains
 * state.contributors (every DID that has ever saved this page besides the
 * genesis author) and state.lastEditedBy (who saved THIS version) — both
 * server-trusted (derived from the authenticated session, not the client's
 * envelope.state), applied in _applyWikiContributorTracking there. DIDs are
 * resolved to handles via GET /dids/handles (see _resolveHandles below) —
 * can't fold that resolution into the envelope response itself, since the
 * envelope round-trips through verifyEnvelopeIntegrity's canonicalJson
 * comparison and extra fields would break that.
 *
 * The one piece of real logic this file owns that PostCardView.js's
 * counterpart didn't need: the Edit button is owner-OR-constellation-
 * canWrite, not owner-only — a wiki page can legitimately be edited by any
 * constellation member with write access (ConstellationRegistry.canWrite),
 * so gating the button on ownership alone would hide a working edit path
 * from a legitimate co-editor. Resolved via the same GET .../space-token
 * check WikiEditor.js already performs when a non-owner opens the editor
 * directly.
 *
 * Entry point:
 *   lively.identity.WikiView.open(handle, objId, options)
 *     options.target      -> embed via target.addMorph(view) instead of a window
 *     options.envelope    -> render immediately, skip the fetch
 *     options.cid         -> view a specific historical version
 *     options.bounds      -> override the default card-shaped extent
 */

module("lively.identity.WikiView")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.identity.DID",
    "lively.identity.Crypto",
    "lively.identity.WikiEditor",
  )
  .toRun(function () {
    var WikiViewClass = lively.morphic.Box.subclass(
      "lively.identity.WikiView",

      "serialization",
      {
        doNotSerialize: [
          "_wrapperEl",
          "_topBarEl",
          "_avatarImgEl",
          "_handleEl",
          "_titleEl",
          "_contentEl",
          "_detailsPanelEl",
          "_detailsToggleEl",
          "_detailsChevronEl",
          "_authorRowEl",
          "_contributorsRowEl",
          "_cidEl",
          "_dateEl",
          "_visibilityEl",
          "_verifyBadgeEl",
          "_editBtn",
          "_contentLoadStarted",
        ],
      },

      "initialization",
      {
        _setup: function () {
          this.disableDragging();
          this.disableGrabbing();
          this._detailsOpen = true;
          this._isOwner = false;
          this._canEdit = false;
          this._verifyResult = null;
          this._buildChrome();

          // See PostCardView.js's identical guard for the full race
          // explanation (open() calling _setup() vs. prepareForNewRenderContext
          // firing again when this morph attaches to its new window).
          if (this._contentLoadStarted) return;
          this._contentLoadStarted = true;
          if (this._envelope) this._renderEnvelope(this._envelope);
          else this._loadEnvelope();
        },

        prepareForNewRenderContext: function ($super, renderCtx) {
          $super(renderCtx);
          if (!this._handle) return;
          this._envelope = null;
          this._setup();
        },
      },

      "chrome",
      {
        _buildChrome: function () {
          var self = this;
          this.setFill(Color.white);

          var shapeNode = this.renderContext().shapeNode;
          shapeNode.innerHTML = ""; // idempotent: safe if _setup() ever runs twice on one instance
          shapeNode.style.borderRadius = "10px";
          shapeNode.style.boxShadow = "0 4px 14px rgba(0,0,0,0.2)";
          shapeNode.style.overflow = "hidden";

          var wrapper = document.createElement("div");
          wrapper.className = "lively-wiki-view-wrapper";
          wrapper.style.cssText = [
            "position:absolute", "inset:0",
            "display:flex", "flex-direction:column",
            "font-family:sans-serif", "background:#fff",
            "box-sizing:border-box",
          ].join(";");
          shapeNode.appendChild(wrapper);
          this._wrapperEl = wrapper;

          this._buildTopBar(wrapper);
          this._buildTitle(wrapper);
          this._buildDetails(wrapper);
          this._buildContentArea(wrapper);
        },

        _buildTopBar: function (wrapper) {
          var self = this;
          var topBar = document.createElement("div");
          topBar.style.cssText = [
            "position:relative", "flex:0 0 auto",
            "height:44px", "padding:0 44px 0 10px",
            "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(topBar);
          this._topBarEl = topBar;

          var avatar = document.createElement("img");
          avatar.className = "lively-wiki-view-avatar";
          avatar.style.cssText = [
            "position:absolute", "top:10px", "left:10px",
            "width:28px", "height:28px", "border-radius:50%",
            "box-shadow:0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.3)",
          ].join(";");
          topBar.appendChild(avatar);
          this._avatarImgEl = avatar;

          var handleEl = document.createElement("div");
          handleEl.style.cssText = [
            "position:absolute", "top:10px", "left:46px", "right:0",
            "height:28px", "display:flex", "align-items:center",
            "font-size:11px", "color:#888", "white-space:nowrap",
            "overflow:hidden", "text-overflow:ellipsis",
          ].join(";");
          handleEl.textContent = "@" + this._handle;
          topBar.appendChild(handleEl);
          this._handleEl = handleEl;

          var editBtn = document.createElement("button");
          editBtn.textContent = "Edit";
          editBtn.title = "Open in the editor";
          editBtn.style.cssText = [
            "position:absolute", "top:8px", "right:8px", "display:none",
            "font-size:11px", "padding:3px 9px", "cursor:pointer",
            "border:1px solid #ccc", "border-radius:12px", "background:#fff",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            editBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click")
                lively.identity.WikiEditor.openCard(self._handle, self._objId);
            });
          });
          topBar.appendChild(editBtn);
          this._editBtn = editBtn;
        },

        _buildTitle: function (wrapper) {
          var title = document.createElement("div");
          title.style.cssText = [
            "flex:0 0 auto", "padding:2px 14px 8px",
            "font-size:15px", "font-weight:600", "color:#222",
            "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
            "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(title);
          this._titleEl = title;
        },

        // Collapsible-open-by-default meta header: Author (genesis creator +
        // avatar), Contributors (other saving members, avatars stacked
        // horizontally), then CID/Updated/Constellation + verify badge. See
        // file header for why this replaced the old flip-card back face.
        _buildDetails: function (wrapper) {
          var self = this;

          var toggle = document.createElement("div");
          toggle.style.cssText = [
            "flex:0 0 auto", "display:flex", "align-items:center", "gap:5px",
            "padding:2px 14px", "font-size:11px", "color:#999",
            "cursor:pointer", "user-select:none", "border-top:1px solid #f0f0f0",
            "border-bottom:1px solid #f0f0f0", "background:#fafafa",
          ].join(";");
          var chevron = document.createElement("span");
          chevron.textContent = "▾"; // ▾
          chevron.style.cssText = "display:inline-block;transition:transform 150ms ease;font-size:9px;";
          var label = document.createElement("span");
          label.textContent = "Details";
          toggle.appendChild(chevron);
          toggle.appendChild(label);
          toggle.addEventListener("click", function () { self._toggleDetails(); });
          wrapper.appendChild(toggle);
          this._detailsToggleEl = toggle;
          this._detailsChevronEl = chevron;

          var panel = document.createElement("div");
          panel.style.cssText = [
            "flex:0 0 auto", "padding:8px 14px", "font-size:11px",
            "color:#555", "line-height:1.7", "background:#fafafa",
            "border-bottom:1px solid #eee", "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(panel);
          this._detailsPanelEl = panel;

          var authorRow = document.createElement("div");
          authorRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
          panel.appendChild(authorRow);
          this._authorRowEl = authorRow;

          var contributorsRow = document.createElement("div");
          contributorsRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
          panel.appendChild(contributorsRow);
          this._contributorsRowEl = contributorsRow;

          function metaRow(label) {
            var r = document.createElement("div");
            var l = document.createElement("span");
            l.textContent = label + ": ";
            l.style.color = "#999";
            var v = document.createElement("span");
            r.appendChild(l);
            r.appendChild(v);
            panel.appendChild(r);
            return v;
          }
          this._cidEl = metaRow("CID");
          this._dateEl = metaRow("Updated");
          this._visibilityEl = metaRow("Constellation");

          var badge = document.createElement("div");
          badge.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;";
          badge.textContent = "Checking…";
          panel.appendChild(badge);
          this._verifyBadgeEl = badge;
        },

        _buildContentArea: function (wrapper) {
          var content = document.createElement("div");
          content.className = "lively-wiki-view-content selectable";
          content.style.cssText = [
            "flex:1 1 auto", "min-height:0", "overflow-y:auto",
            "padding:10px 14px 14px", "font-size:13px", "line-height:1.5",
            "color:#333", "box-sizing:border-box",
          ].join(";");
          wrapper.appendChild(content);
          this._contentEl = content;
        },

        _toggleDetails: function () {
          this._detailsOpen = !this._detailsOpen;
          this._detailsPanelEl.style.display = this._detailsOpen ? "" : "none";
          this._detailsChevronEl.style.transform = this._detailsOpen ? "rotate(0deg)" : "rotate(-90deg)";
        },

        // Renders a small avatar+handle pair for the Author row / each
        // Contributors entry. Falls back to an identicon immediately, then
        // swaps in the real avatar if the handle's profile has one —
        // mirrors _loadAvatarInto's own fallback-then-upgrade pattern.
        _buildPersonChip: function (handle, size) {
          var chip = document.createElement("span");
          chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;";
          var img = document.createElement("img");
          img.style.cssText = "width:" + size + "px;height:" + size + "px;border-radius:50%;box-shadow:0 0 0 1px #fff,0 1px 2px rgba(0,0,0,0.25);";
          img.title = "@" + handle;
          chip.appendChild(img);
          this._loadAvatarInto(img, handle);
          return { el: chip, imgEl: img };
        },
      },

      "data loading",
      {
        _loadEnvelope: function () {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base +
            "/@" +
            encodeURIComponent(this._handle) +
            "/" +
            encodeURIComponent(this._objId) +
            (this._cid ? "/at/" + encodeURIComponent(this._cid) : "");
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200)
              return self._showError("Failed to load wiki page: " + xhr.status);
            var envelope;
            try {
              envelope = JSON.parse(xhr.responseText);
            } catch (e) {
              return self._showError("Invalid envelope JSON: " + e.message);
            }
            self._renderEnvelope(envelope);
          };
          xhr.onerror = function () {
            self._showError("Network error loading wiki page");
          };
          xhr.send();
        },

        // Batch-resolves DIDs to handles via GET /dids/handles (see
        // IdentityServer.js's file header on why this can't just be embedded
        // in the envelope response). Calls thenDo({ [did]: handle|null }).
        _resolveHandles: function (dids, thenDo) {
          var unique = (dids || []).filter(function (d, i, a) { return d && a.indexOf(d) === i; });
          if (!unique.length) return thenDo({});
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(unique.join(",")), true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return thenDo({});
            try { thenDo(JSON.parse(xhr.responseText).handles || {}); }
            catch (e) { thenDo({}); }
          };
          xhr.onerror = function () { thenDo({}); };
          xhr.send();
        },

        _showError: function (msg) {
          console.error("[WikiView]", msg);
          if (this._titleEl) this._titleEl.textContent = "Error";
          if (this._contentEl) this._contentEl.textContent = msg;
        },
      },

      "rendering",
      {
        _renderEnvelope: function (envelope) {
          this._envelope = envelope;
          this._constellation = envelope.constellation || null;
          var user = lively.identity.did.currentUser();
          this._isOwner = !!(user && user.did === envelope.did);

          this._loadAvatarInto(this._avatarImgEl, this._handle);
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";

          this._renderContentArea(envelope);
          this._renderDetails(envelope);
          this._resolveEditAccess();
        },

        // Owner-OR-constellation-canWrite (see file header) — resolves the
        // Edit button's visibility, unlike PostCardView.js's owner-only
        // gate, since a wiki page can legitimately be edited by any
        // constellation member with write access.
        _resolveEditAccess: function () {
          var self = this;
          if (!this._editBtn) return;
          if (this._isOwner) {
            this._canEdit = true;
            this._editBtn.style.display = "";
            return;
          }
          this._editBtn.style.display = "none";
          if (!this._constellation) return;
          var base = lively.identity.did.baseUrl();
          var url = base + "/c/" + encodeURIComponent(this._constellation) + "/space-token";
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
              if (JSON.parse(xhr.responseText).canWrite) {
                self._canEdit = true;
                self._editBtn.style.display = "";
              }
            } catch (e) {}
          };
          xhr.send();
        },

        // Shared by the top-bar avatar and each Author/Contributors chip.
        // Identicon fallback first (instant, no network dependency), then
        // upgraded to the handle's real avatar if their profile has one.
        _loadAvatarInto: function (imgEl, handle) {
          var fallbackSeed = handle || (this._envelope && this._envelope.did) || "";
          imgEl.src = lively.identity.postCardUtils.identiconDataUrl(fallbackSeed, 32);
          if (!handle) return;

          var base = lively.identity.did.baseUrl();
          fetch(base + "/@" + encodeURIComponent(handle) + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (avatarUrl) imgEl.src = avatarUrl;
            })
            .catch(function () {});
        },

        // Wiki pages are always public/unencrypted (WikiSerializer.js) —
        // no locked-content placeholder branch needed, unlike
        // PostCardView.js's counterpart.
        _renderContentArea: function (envelope) {
          var payload = envelope.record && envelope.record.payload;
          var snapshot = payload && payload.snapshot;
          this._contentEl.innerHTML = snapshot
            ? lively.identity.postCardUtils.snapshotToHtml(snapshot)
            : "";
          // BUG FIX: see PostCardView.js's _renderContentArea — same fix.
          lively.identity.postCardUtils.hydrateEmbeddedParts(this._contentEl);
        },

        _renderDetails: function (envelope) {
          var self = this;
          this._cidEl.textContent =
            envelope.record && envelope.record.cid
              ? lively.identity.postCardUtils.truncateDid(envelope.record.cid)
              : "—";
          this._dateEl.textContent = this._formatDate(envelope.created);
          this._visibilityEl.textContent = envelope.constellation || "—";

          var state = envelope.state || {};
          var contributorDids = Array.isArray(state.contributors) ? state.contributors : [];
          var lastEditedBy = state.lastEditedBy || null;
          var allDids = [envelope.did].concat(contributorDids);
          if (lastEditedBy) allDids.push(lastEditedBy);

          this._resolveHandles(allDids, function (didToHandle) {
            self._renderAuthorRow(envelope.did, didToHandle[envelope.did] || self._handle);
            self._renderContributorsRow(contributorDids, didToHandle);
            self._verify(envelope, lastEditedBy ? (didToHandle[lastEditedBy] || null) : null);
          });
        },

        _renderAuthorRow: function (did, handle) {
          this._authorRowEl.innerHTML = "";
          var label = document.createElement("span");
          label.textContent = "Author:";
          label.style.color = "#999";
          this._authorRowEl.appendChild(label);
          if (!handle) {
            var unknown = document.createElement("span");
            unknown.textContent = lively.identity.postCardUtils.truncateDid(did);
            this._authorRowEl.appendChild(unknown);
            return;
          }
          var chip = this._buildPersonChip(handle, 18);
          var handleText = document.createElement("span");
          handleText.textContent = "@" + handle;
          chip.el.appendChild(handleText);
          this._authorRowEl.appendChild(chip.el);
        },

        _renderContributorsRow: function (contributorDids, didToHandle) {
          this._contributorsRowEl.innerHTML = "";
          if (!contributorDids.length) return;
          var label = document.createElement("span");
          label.textContent = "Contributors:";
          label.style.color = "#999";
          this._contributorsRowEl.appendChild(label);

          var stack = document.createElement("span");
          stack.style.cssText = "display:inline-flex;align-items:center;";
          contributorDids.forEach(function (did, i) {
            var handle = didToHandle[did];
            if (!handle) return;
            var chip = this._buildPersonChip(handle, 18);
            chip.imgEl.style.marginLeft = i === 0 ? "0" : "-6px";
            stack.appendChild(chip.el);
          }, this);
          this._contributorsRowEl.appendChild(stack);
        },

        _formatDate: function (iso) {
          if (!iso) return "—";
          var d = new Date(iso);
          if (isNaN(d.getTime())) return iso;
          return (
            d.toLocaleDateString() +
            " " +
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          );
        },
      },

      "verification",
      {
        // Best-effort, display-only integrity check. lastEditedByHandle (the
        // resolved handle for envelope.state.lastEditedBy, IdentityServer.js's
        // _applyWikiContributorTracking) is who actually signed THIS version
        // — resolve their delegation cert instead of always this._handle's
        // (the genesis author's), which would be the wrong key for any
        // version saved by a co-editor. Falls back to this._handle when
        // lastEditedBy is unresolved/absent (pages with no co-editor saves
        // yet), matching PostCardView.js's identical single-author check.
        _verify: function (envelope, lastEditedByHandle) {
          var self = this;
          this._verifyBadgeEl.textContent = "Checking…";
          this._verifyBadgeEl.style.color = "#999";

          function finish(signerJwk) {
            lively.identity.crypto.verifyEnvelopeIntegrity(
              envelope,
              signerJwk || null,
              function (err, result) {
                self._verifyResult = result;
                self._renderVerifyBadge(
                  result || { cidValid: false, sigStatus: "unresolved" },
                );
              },
            );
          }

          if (!envelope.sig) return finish(null);
          lively.identity.did.resolveEnvelopeSignerJwk(
            lastEditedByHandle || this._handle,
            function (err, jwk) {
              finish(err ? null : jwk);
            },
          );
        },

        _renderVerifyBadge: function (result) {
          var label, color;
          if (!result.cidValid) {
            label = "⚠ Content tampered";
            color = "#c33";
          } else if (result.sigStatus === "verified") {
            label = "✓ Verified";
            color = "#2a7";
          } else if (result.sigStatus === "unsigned") {
            label = "Unsigned";
            color = "#999";
          } else if (result.sigStatus === "unresolved") {
            label = "Unable to verify";
            color = "#d5d52c";
          } else {
            label = "✕ Signature invalid";
            color = "#c33";
          }
          this._verifyBadgeEl.textContent = label;
          this._verifyBadgeEl.style.color = color;
        },
      },
    );

    // ─── class-side entry points ─────────────────────────────────────────────────

    Object.extend(WikiViewClass, {
      _openInCenteredWindow: function (view, title) {
        var win = view.openInWindow({ title: title });
        if (win) {
          if (!document.getElementById("lively-postcard-view-window-style")) {
            var styleEl = document.createElement("style");
            styleEl.id = "lively-postcard-view-window-style";
            styleEl.textContent =
              ".Window.postcard-view-window { border-radius: 10px; }";
            document.head.appendChild(styleEl);
          }
          win.addStyleClassName("postcard-view-window");

          if (win.menuButton) {
            win.menuButton.remove();
            win.titleBar.buttons = win.titleBar.buttons.without(win.menuButton);
            win.menuButton = null;
            win.titleBar.adjustElementPositions();
          }

          win.align(
            win.bounds().center(),
            lively.morphic.World.current().visibleBounds().center(),
          );
          win.bringToFront();
        }
      },

      // options.target      -> embed via target.addMorph(view)
      // options.envelope    -> render immediately, skip the fetch
      // options.cid         -> view a specific historical version
      // options.bounds      -> override the default card-shaped extent
      open: function (handle, objId, options) {
        var opts = options || {};
        var view = new lively.identity.WikiView(
          opts.bounds || lively.rect(0, 0, 420, 300),
        );
        view._handle = handle;
        view._objId = objId;
        view._cid = opts.cid || null;
        view._envelope = opts.envelope || null;
        if (opts.target) {
          opts.target.addMorph(view);
          view._setup();
        } else {
          this._openInCenteredWindow(view, "Wiki page from @" + handle);
          view._setup();
        }
        return view;
      },
    });
  }); // end module('lively.identity.WikiView')
