/**
 * lively.identity.WikiView
 *
 * Read-only wiki-page morph — the counterpart to WikiEditor (editing-only).
 * Split out of lively.identity.PostCardView when wiki pages became their
 * own envelope type (type: 'wikipage') instead of a type:'postcard' +
 * state.wikiName combination. Simpler than PostCardView in two ways that
 * both follow from wiki pages' own design (WikiSerializer.js):
 *
 *   - No flip/verification-badge back face content changes — same
 *     stamp/DID/CID/date/visibility back face, still useful for a wiki page.
 *   - No reactions/tip-jar footer, no encrypted-content lock placeholder —
 *     wiki pages are always public/unencrypted, and reactions/tip-jar are
 *     postcard-only social features that never applied to wiki pages.
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
          "_cardEl",
          "_frontEl",
          "_backEl",
          "_avatarImgEl",
          "_handleEl",
          "_titleEl",
          "_contentEl",
          "_stampEl",
          "_didEl",
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
          this._flipped = false;
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
          shapeNode.style.overflow = "visible"; // perspective needs room, not clipping

          var wrapper = document.createElement("div");
          wrapper.className = "lively-postcard-view-wrapper";
          wrapper.style.cssText =
            "position:absolute;inset:0;perspective:1200px;";
          shapeNode.appendChild(wrapper);
          this._wrapperEl = wrapper;

          var card = document.createElement("div");
          card.className = "lively-postcard-view-card";
          card.style.cssText = [
            "position:relative",
            "width:100%",
            "height:100%",
            "transform-style:preserve-3d",
            "transition:transform 500ms ease",
            "transform:rotateY(0deg)",
          ].join(";");
          wrapper.appendChild(card);
          this._cardEl = card;

          this._frontEl = this._buildFace(card, false);
          this._backEl = this._buildFace(card, true);

          this._buildFrontContents(this._frontEl);
          this._buildBackContents(this._backEl);

          ["mousedown", "click", "dblclick"].forEach(function (t) {
            wrapper.addEventListener(t, function (e) {
              if (e.target === wrapper || e.target === card) return;
            });
          });
        },

        _buildFace: function (card, isBack) {
          var face = document.createElement("div");
          face.className =
            "lively-postcard-view-face " + (isBack ? "back" : "front");
          face.style.cssText = [
            "position:absolute",
            "inset:0",
            "backface-visibility:hidden",
            "border-radius:10px",
            "overflow:hidden",
            "box-sizing:border-box",
            "font-family:sans-serif",
            "background:#fff",
            isBack ? "transform:rotateY(180deg)" : "",
          ].join(";");
          card.appendChild(face);
          return face;
        },

        _buildFrontContents: function (front) {
          var self = this;

          var avatar = document.createElement("img");
          avatar.className = "lively-postcard-view-avatar";
          avatar.style.cssText = [
            "position:absolute",
            "top:10px",
            "left:10px",
            "width:32px",
            "height:32px",
            "border-radius:50%",
            "box-shadow:0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.3)",
          ].join(";");
          front.appendChild(avatar);
          this._avatarImgEl = avatar;

          var handleEl = document.createElement("div");
          handleEl.className = "lively-postcard-view-handle";
          handleEl.style.cssText = [
            "position:absolute",
            "top:10px",
            "left:52px",
            "right:40px",
            "height:32px",
            "display:flex",
            "align-items:center",
            "font-size:11px",
            "color:#888",
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis",
          ].join(";");
          handleEl.textContent = "@" + this._handle;
          front.appendChild(handleEl);
          this._handleEl = handleEl;

          var title = document.createElement("div");
          title.className = "lively-postcard-view-title";
          title.style.cssText = [
            "position:absolute",
            "top:48px",
            "left:14px",
            "right:14px",
            "font-size:15px",
            "font-weight:600",
            "color:#222",
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis",
          ].join(";");
          front.appendChild(title);
          this._titleEl = title;

          var content = document.createElement("div");
          content.className = "lively-postcard-view-content selectable";
          content.style.cssText = [
            "position:absolute",
            "top:76px",
            "left:0",
            "right:0",
            "bottom:0",
            "padding:8px 14px 14px",
            "overflow-y:auto",
            "font-size:13px",
            "line-height:1.5",
            "color:#333",
            "box-sizing:border-box",
          ].join(";");
          front.appendChild(content);
          this._contentEl = content;

          var flipBtn = this._buildIconButton(
            "front",
            "⟳",
            "Flip to see verification info",
            function () {
              self._toggleFlip();
            },
          );
          flipBtn.style.right = "10px";
          flipBtn.style.bottom = "10px";
          front.appendChild(flipBtn);

          var editBtn = document.createElement("button");
          editBtn.textContent = "Edit";
          editBtn.title = "Open in the editor";
          editBtn.style.cssText = [
            "position:absolute",
            "top:8px",
            "right:8px",
            "display:none",
            "font-size:11px",
            "padding:3px 9px",
            "cursor:pointer",
            "border:1px solid #ccc",
            "border-radius:12px",
            "background:#fff",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            editBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click")
                lively.identity.WikiEditor.openCard(
                  self._handle,
                  self._objId,
                );
            });
          });
          front.appendChild(editBtn);
          this._editBtn = editBtn;
        },

        _buildBackContents: function (back) {
          var self = this;

          var stamp = document.createElement("div");
          stamp.className = "lively-postcard-view-stamp";
          stamp.style.cssText = [
            "position:absolute",
            "top:10px",
            "right:10px",
            "width:44px",
            "height:52px",
            "border:2px dashed currentColor",
            "border-radius:3px",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-size:18px",
            "color:#888",
          ].join(";");
          stamp.textContent = "📖";
          back.appendChild(stamp);
          this._stampEl = stamp;

          var meta = document.createElement("div");
          meta.className = "lively-postcard-view-meta";
          meta.style.cssText = [
            "position:absolute",
            "top:16px",
            "left:14px",
            "right:68px",
            "bottom:14px",
            "font-size:11px",
            "color:#555",
            "line-height:1.9",
          ].join(";");
          back.appendChild(meta);

          function row(label) {
            var r = document.createElement("div");
            var l = document.createElement("span");
            l.textContent = label + ": ";
            l.style.color = "#999";
            var v = document.createElement("span");
            r.appendChild(l);
            r.appendChild(v);
            meta.appendChild(r);
            return v;
          }

          this._didEl = row("Author");
          this._cidEl = row("CID");
          this._dateEl = row("Updated");
          this._visibilityEl = row("Constellation");

          var badge = document.createElement("div");
          badge.className = "lively-postcard-view-verify-badge";
          badge.style.cssText = [
            "position:absolute",
            "left:14px",
            "bottom:38px",
            "font-size:12px",
            "font-weight:600",
          ].join(";");
          badge.textContent = "Checking…";
          back.appendChild(badge);
          this._verifyBadgeEl = badge;

          var flipBackBtn = this._buildIconButton(
            "back",
            "⟲",
            "Flip back",
            function () {
              self._toggleFlip();
            },
          );
          flipBackBtn.style.right = "10px";
          flipBackBtn.style.bottom = "10px";
          back.appendChild(flipBackBtn);
        },

        _buildIconButton: function (side, glyph, title, onClick) {
          var btn = document.createElement("button");
          btn.textContent = glyph;
          btn.title = title;
          btn.style.cssText = [
            "position:absolute",
            "width:26px",
            "height:26px",
            "border-radius:50%",
            "border:1px solid #ccc",
            "background:#fff",
            "cursor:pointer",
            "font-size:13px",
            "line-height:1",
            "padding:0",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            btn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") onClick();
            });
          });
          return btn;
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

          this._loadAvatar();
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";

          this._renderContentArea(envelope);
          this._renderBackMeta(envelope);
          this._verify(envelope);
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

        _loadAvatar: function () {
          var self = this;
          var handle = this._handle;
          var fallbackSeed = handle || (this._envelope && this._envelope.did) || "";
          this._avatarImgEl.src = lively.identity.postCardUtils.identiconDataUrl(fallbackSeed, 32);
          if (!handle) return;

          var base = lively.identity.did.baseUrl();
          fetch(base + "/@" + encodeURIComponent(handle) + "/profile", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (avatarUrl && self._handle === handle) self._avatarImgEl.src = avatarUrl;
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
        },

        _renderBackMeta: function (envelope) {
          this._didEl.textContent = lively.identity.postCardUtils.truncateDid(
            envelope.did,
          );
          this._cidEl.textContent =
            envelope.record && envelope.record.cid
              ? lively.identity.postCardUtils.truncateDid(envelope.record.cid)
              : "—";
          this._dateEl.textContent = this._formatDate(envelope.created);
          this._visibilityEl.textContent = envelope.constellation || "—";
          this._stampEl.style.color = "#5566cc";
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

        _toggleFlip: function () {
          this._flipped = !this._flipped;
          this._cardEl.style.transform = this._flipped
            ? "rotateY(180deg)"
            : "rotateY(0deg)";
        },
      },

      "verification",
      {
        // Best-effort, display-only integrity check — identical to
        // PostCardView.js's, generic over any envelope shape.
        _verify: function (envelope) {
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
            this._handle,
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
