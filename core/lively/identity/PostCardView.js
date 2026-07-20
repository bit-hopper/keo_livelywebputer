/**
 * lively.identity.PostCardView
 *
 * Read-only "physical postcard" morph — the counterpart to PostCardEditor
 * (which is now owner-only, editing-only). PostCardView is the single
 * rendering path for looking at a postcard you aren't actively editing:
 * a front side (avatar, title, content) and a back side (stamp, DID/CID,
 * signature-verification badge), joined by a CSS 3D flip triggered by a
 * dedicated flip-icon button.
 *
 * Content rendering has two paths:
 *   - Public envelopes: rendered directly via
 *     lively.identity.postCardUtils.snapshotToHtml — no Yjs/ProseMirror
 *     dependency, matching the read-only rendering PostCardFeed/
 *     PostCardPlayback/ConstellationSpace already used before this file
 *     existed.
 *   - Private/shared envelopes: there is no plaintext snapshot in an
 *     encrypted envelope (by design — that's what makes it encrypted), so
 *     content can only be recovered by actually decrypting via
 *     PostCardSerializer.deserializeEncrypted, which today only happens
 *     inside PostCardEditor's ProseMirror/Yjs pipeline. Rather than
 *     duplicate that pipeline here, PostCardView's front face shows a
 *     "locked" placeholder with a "View content" action that opens a
 *     PostCardEditor window in forced-read-only mode (see
 *     PostCardEditor.js's `forceReadOnly` option) — a separate window
 *     rather than an embedded morph, since nesting a live morph (with its
 *     own WebSocket sync / focus handling) inside this card's
 *     `transform: rotateY(...)` front face would be fragile.
 *
 * Entry point:
 *   lively.identity.PostCardView.open(handle, objId, options)
 *     options.target      -> embed via target.addMorph(view) instead of a window
 *     options.envelope    -> render immediately, skip the fetch
 *     options.cid         -> view a specific historical version
 *     options.bounds      -> override the default postcard-shaped extent
 *
 * doNotSerialize list: every raw DOM node this morph manages directly
 * (mirrors PostCardEditor.js's own doNotSerialize for the same reason —
 * DOM nodes aren't part of Lively's object graph and are rebuilt by
 * _setup() on next open).
 */

module("lively.identity.PostCardView")
  .requires(
    "lively.identity.PostCardUtils",
    "lively.identity.DID",
    "lively.identity.Crypto",
    "lively.identity.PostCardEditor",
  )
  .toRun(function () {
    var PostCardViewClass = lively.morphic.Box.subclass(
      "lively.identity.PostCardView",

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
        ],
      },

      "initialization",
      {
        // Callable more than once on the same instance — see
        // prepareForNewRenderContext below, which re-runs this after a saved
        // world is reloaded (or the morph is copied), since none of the DOM
        // this builds survives serialization (see doNotSerialize). Does NOT
        // reset this._envelope: open() may have already set it from
        // options.envelope (skip-the-fetch case), and that must survive this
        // running as part of the normal open() call sequence.
        _setup: function () {
          // Same rationale as PostCardEditor._setup: this morph is either
          // embedded (ConstellationSpace/PostCardFeed manage its position
          // themselves) or windowed (openInWindow's title bar is the drag
          // handle) — either way, this morph's own body-dragging must not
          // fight with those.
          this.disableDragging();
          this.disableGrabbing();
          this._flipped = false;
          this._isOwner = false;
          this._verifyResult = null;
          this._buildChrome();
          if (this._envelope) this._renderEnvelope(this._envelope);
          else this._loadEnvelope();
        },

        // Fires once at construction (before open() has set _handle — the
        // guard below skips that no-op call, open() runs _setup() itself once
        // configured) and again, recursively, on every submorph whenever a
        // saved world is reloaded or this morph is copied (see
        // Rendering.js's prepareForNewRenderContext, which is exactly the
        // "lively.morphic.Text re-populates its content here after restore"
        // hook, applied to this morph's own hand-built DOM). _handle/_objId
        // survive serialization fine (plain fields); the DOM in _wrapperEl
        // etc. does not, hence rebuilding chrome here. _envelope is cleared
        // first so a restore always re-fetches current content and a fresh
        // verification result, rather than showing a save-time snapshot.
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
              // Let the click through to real content (links, the flip/edit
              // buttons below, which stop propagation themselves) but keep it
              // from reaching Lively's own drag/selection handling — same
              // rationale as PostCardEditor.js's pmDiv listeners.
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

          // Handle sits beside the avatar, vertically centered on it (same
          // top/height band as the avatar, flex-centered so it doesn't depend
          // on guessing the text's line-height) — known immediately from
          // this._handle, so it doesn't have to wait on _renderEnvelope like
          // the title below it does.
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

          // Title falls below the avatar/handle row rather than beside it.
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
                lively.identity.PostCardEditor.openCard(
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
          stamp.textContent = "✉";
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

          this._didEl = row("From");
          this._cidEl = row("CID");
          this._dateEl = row("Sent");
          this._visibilityEl = row("Visibility");

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
              return self._showError("Failed to load postcard: " + xhr.status);
            var envelope;
            try {
              envelope = JSON.parse(xhr.responseText);
            } catch (e) {
              return self._showError("Invalid envelope JSON: " + e.message);
            }
            self._renderEnvelope(envelope);
          };
          xhr.onerror = function () {
            self._showError("Network error loading postcard");
          };
          xhr.send();
        },

        _showError: function (msg) {
          console.error("[PostCardView]", msg);
          if (this._titleEl) this._titleEl.textContent = "Error";
          if (this._contentEl) this._contentEl.textContent = msg;
        },
      },

      "rendering",
      {
        _renderEnvelope: function (envelope) {
          this._envelope = envelope;
          var user = lively.identity.did.currentUser();
          this._isOwner = !!(user && user.did === envelope.did);

          this._loadAvatar();
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";
          if (this._editBtn)
            this._editBtn.style.display = this._isOwner ? "" : "none";

          this._renderContentArea(envelope);
          this._renderBackMeta(envelope);
          this._verify(envelope);
        },

        // Show the identicon immediately (cheap, synchronous, always
        // correct as a fallback), then swap in the author's real avatar if
        // their profile has one set — this previously never happened at
        // all, so every postcard showed the blockie identicon regardless of
        // whether the author had set a real avatar (ProfileCard.js has the
        // same avatarUrl-else-identicon fallback; this mirrors it).
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
              // Guard against a slow profile fetch resolving after the user
              // has already navigated this same morph to a different card.
              if (avatarUrl && self._handle === handle) self._avatarImgEl.src = avatarUrl;
            })
            .catch(function () {}); // network error — keep the identicon fallback
        },

        _renderContentArea: function (envelope) {
          var self = this;
          if (envelope.visibility === "public") {
            var snapshot =
              envelope.record &&
              envelope.record.payload &&
              envelope.record.payload.snapshot;
            this._contentEl.innerHTML = snapshot
              ? lively.identity.postCardUtils.snapshotToHtml(snapshot)
              : "";
            return;
          }

          // Encrypted content — see file-level comment. Show a locked
          // placeholder rather than attempting to decrypt inline.
          this._contentEl.innerHTML = "";
          var lock = document.createElement("div");
          lock.style.cssText =
            "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
            "height:100%;color:#999;gap:8px;";
          var icon = document.createElement("div");
          icon.textContent = "🔒";
          icon.style.fontSize = "22px";
          lock.appendChild(icon);
          var label = document.createElement("div");
          label.textContent = "Encrypted";
          label.style.fontSize = "11px";
          lock.appendChild(label);
          var viewBtn = document.createElement("button");
          viewBtn.textContent = "View content";
          viewBtn.style.cssText =
            "font-size:11px;padding:4px 10px;cursor:pointer;" +
            "border:1px solid #ccc;border-radius:12px;background:#fff;";
          ["mousedown", "click"].forEach(function (t) {
            viewBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              // forceReadOnly: this is a viewer, never an editor — even for
              // the card's own owner (see PostCardEditor.js's forceReadOnly).
              if (t === "click") {
                lively.identity.PostCardEditor.openCard(
                  self._handle,
                  self._objId,
                  { forceReadOnly: true },
                );
              }
            });
          });
          lock.appendChild(viewBtn);
          this._contentEl.appendChild(lock);
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
          this._visibilityEl.textContent = envelope.visibility || "public";
          var stampColor =
            envelope.visibility === "public" ? "#888" : "#5566cc";
          this._stampEl.style.color = stampColor;
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
        // Best-effort, display-only integrity check — see Crypto.js's
        // verifyEnvelopeIntegrity doc comment. Not a security gate.
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

    Object.extend(PostCardViewClass, {
      _openInCenteredWindow: function (view, title) {
        var win = view.openInWindow({ title: title });
        if (win) {
          // Window corner radius comes from the global `.Window` CSS class
          // (base_theme.css), not an inline style: TitleBar/Window both run
          // with BorderStylingMode on, which makes StyleSheetsHTML.js's
          // setBorderRadiusHTML override discard any inline borderRadius in
          // favor of the stylesheet. The TitleBar itself is transparent
          // (`.Window .TitleBar { background: none }`) — what you see behind
          // it is the Window shape's own rounded background — so matching
          // the card's 10px radius (_buildChrome) means widening the Window
          // shape's own radius via a scoped class, not the titleBar.
          if (!document.getElementById("lively-postcard-view-window-style")) {
            var styleEl = document.createElement("style");
            styleEl.id = "lively-postcard-view-window-style";
            styleEl.textContent =
              ".Window.postcard-view-window { border-radius: 10px; }";
            document.head.appendChild(styleEl);
          }
          win.addStyleClassName("postcard-view-window");

          // Postcard-view windows don't need the generic target-morph "Menu"
          // button — removed on just this window instance (not TitleBar's
          // shared button set), then reflow the remaining close/collapse
          // buttons into the freed space.
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
      // options.bounds      -> override the default postcard-shaped extent
      open: function (handle, objId, options) {
        var opts = options || {};
        var view = new lively.identity.PostCardView(
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
          this._openInCenteredWindow(view, "Post Card from @" + handle);
          view._setup();
        }
        return view;
      },
    });
  }); // end module('lively.identity.PostCardView')
