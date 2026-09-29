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
 * Content rendering has two paths, both landing in the same
 * lively.identity.postCardUtils.snapshotToHtml/hydrateEmbeddedParts
 * rendering — no Yjs/ProseMirror dependency either way:
 *   - Public envelopes: the plaintext ProseMirror-doc snapshot is already
 *     in the envelope, rendered directly.
 *   - Private/shared envelopes: there is no plaintext snapshot in an
 *     encrypted envelope (by design), so the front face first shows a
 *     "locked" placeholder; its "View content" action calls
 *     PostCardSerializer.deserializeEncryptedAuto (_decryptAndRenderContent)
 *     to decrypt in place — a legacy pre-plain/wiki-split ('wiki' mode)
 *     envelope's Y.Doc is turned into the same snapshot shape via
 *     PostCardSerializer._extractSnapshot first. Any attachment referenced
 *     only by objId (unresolved until decrypted) renders as a placeholder
 *     hydrateAttachments then resolves to a session-local blob: URL via
 *     FileCrypto.resolveAttachmentUrl. No separate editor window is
 *     involved at all — this used to open PostCardEditor in a forced-
 *     read-only mode purely as a decrypt engine, which pulled in the
 *     entire ProseMirror/Yjs/autosave/toolbar/send-flow editor just to
 *     show static content.
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
    "lively.identity.PostCardSerializer",
    "lively.identity.FileCrypto",
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
          "_moreBtn",
          "_moreMenuEl",
          "_moreMenuOutsideHandler",
          "_footerEl",
          "_tipJarChipEl",
          "_pillsWrapEl",
          "_contentLoadStarted",
          "_decryptInFlight",
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
          // embedded (ConstellationCanvas/ConstellationLounge/PostCardFeed manage its position
          // themselves) or windowed (openInWindow's title bar is the drag
          // handle) — either way, this morph's own body-dragging must not
          // fight with those.
          this.disableDragging();
          this.disableGrabbing();
          this._flipped = false;
          this._isOwner = false;
          this._verifyResult = null;
          this._buildChrome();

          // Guards against double-firing the content-load dispatch below —
          // same race as PostCardEditor.js's identical guard: open() calls
          // _setup() explicitly right after opening this morph in a window,
          // but attaching to that window's new render context *also*
          // triggers prepareForNewRenderContext below, which (by the time
          // _handle is set) calls _setup() again in the same turn. Without
          // this, _loadEnvelope() could fire twice (two redundant GETs,
          // each re-running _verify()/_loadReactions() on completion).
          // doNotSerialize'd so a genuine future restore still starts
          // falsy and loads normally.
          if (this._contentLoadStarted) return;
          this._contentLoadStarted = true;
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
        //
        // Also fires as an *immediate* same-turn duplicate of open()'s own
        // explicit _setup() call, when attaching this morph to its new
        // window triggers a render-context change — see _setup()'s own
        // _contentLoadStarted guard, which is what makes that safe. One
        // residual wrinkle in that race specifically: this._envelope = null
        // below still runs before the (now-guarded) _setup(), so an
        // options.envelope skip-the-fetch open() can still lose its
        // pre-supplied envelope and fall through to _loadEnvelope() instead
        // — a redundant fetch, not a correctness bug (the fetched envelope
        // is equivalent), and not addressed here.
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
            "bottom:32px", // leave room for the reactions footer below
            "padding:8px 14px 14px",
            "overflow-y:auto",
            "font-size:13px",
            "line-height:1.5",
            "color:#333",
            "box-sizing:border-box",
          ].join(";");
          // Click a photo to view it whole inside the card; the viewer's own
          // full-screen icon opens the full-screen one (PostCardUtils.openImageViewer).
          content.addEventListener("click", function (e) {
            var t = e.target;
            if (!t || t.tagName !== "IMG" || !/lively-postcard-image/.test(t.className) || !t.src) return;
            var imgs = Array.prototype.filter.call(
              content.querySelectorAll("img.lively-postcard-image"),
              function (i) { return !!i.src; });
            lively.identity.postCardUtils.openImageViewer(imgs, imgs.indexOf(t), { container: content.parentNode });
          });
          front.appendChild(content);
          this._contentEl = content;

          this._buildReactionsFooter(front);

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

          // "More" menu -- Edit (owner only) and Save to Collections (any
          // viewer). Edit used to be its own dedicated button in this same
          // top-right corner; folded into the menu so a non-owner viewer
          // also has somewhere to reach Save to Collections from (see
          // WikiView.js's identical Edit-button-to-menu migration).
          var moreBtn = document.createElement("button");
          moreBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;line-height:1;">more_vert</span>';
          moreBtn.title = "More";
          moreBtn.style.cssText = [
            "position:absolute",
            "top:8px",
            "right:8px",
            "width:24px",
            "height:24px",
            "padding:0",
            "cursor:pointer",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "border:1px solid #ccc",
            "border-radius:50%",
            "background:#fff",
            "color:#555",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            moreBtn.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t === "click") self._toggleMoreMenu(moreBtn);
            });
          });
          front.appendChild(moreBtn);
          this._moreBtn = moreBtn;
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
            "border:1px solid #e8497e",   // pink accent, same as the constellation page's buttons
            "background:#e8497e",
            "color:#fff",
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

        // Reactions footer (PostcardDesignSpec-v2.md §5.1) — a thin strip
        // along the bottom of the front face, below the content area. Built
        // empty here; populated/shown or hidden per-envelope in
        // _renderReactionsFooter, since state.reactionsEnabled isn't known
        // until the envelope loads.
        _buildReactionsFooter: function (front) {
          var self = this;
          var footer = document.createElement("div");
          footer.className = "lively-postcard-view-reactions-footer";
          footer.style.cssText = [
            "position:absolute",
            "left:0",
            "right:0",
            "bottom:0",
            "height:32px",
            "display:none",
            "align-items:center",
            "gap:4px",
            // Right padding clears the flip button (26px wide at right:10px)
            // that sits over the footer's bottom-right corner.
            "padding:0 46px 0 10px",
            "border-top:1px solid #eee",
            "overflow-x:auto",
            // overflow-x:auto alone makes overflow-y auto too, so the
            // reaction pop (a scaled, rotated emoji taller than the strip)
            // flashed a vertical scrollbar that shoved the pills left.
            "overflow-y:hidden",
            "white-space:nowrap",
            "box-sizing:border-box",
          ].join(";");
          front.appendChild(footer);
          this._footerEl = footer;

          // Two independent sub-areas so a tip-jar-only card (reactions
          // off) and a reactions-only card (no tip jar) both render
          // correctly — the tip chip is rebuilt once per envelope load, the
          // pills wrap is rebuilt on every reactions poll, and neither
          // clear should wipe out the other.
          var tipJarChip = document.createElement("span");
          tipJarChip.style.cssText = "flex:none;display:flex;align-items:center;gap:4px;";
          footer.appendChild(tipJarChip);
          this._tipJarChipEl = tipJarChip;

          // margin-left:auto pushes this (and only this) sub-area to the
          // footer's far right within the flex row, leaving the tip jar
          // chip in its left-hand slot.
          var pillsWrap = document.createElement("span");
          pillsWrap.style.cssText = "flex:none;display:flex;align-items:center;gap:4px;margin-left:auto;";
          footer.appendChild(pillsWrap);
          this._pillsWrapEl = pillsWrap;
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

      "sharing",
      {
        // Small dropdown anchored under the "more" button, appended to
        // document.body rather than nested inside this morph's own
        // shapeNode -- _buildChrome sets overflow:hidden on the card faces,
        // which would clip a menu popping out below the top bar. Toggle: a
        // second click on the same button (or any outside mousedown)
        // closes it. Mirrors WikiView.js's identical _toggleMoreMenu.
        _toggleMoreMenu: function (anchorBtn) {
          if (this._moreMenuEl) { this._closeMoreMenu(); return; }
          var self = this;
          var rect = anchorBtn.getBoundingClientRect();
          var menu = document.createElement("div");
          menu.style.cssText = [
            "position:fixed", "z-index:9999",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "left:" + Math.round(rect.right - 180) + "px",
            "width:180px", "background:#fff", "border:1px solid #ddd",
            "border-radius:8px", "box-shadow:0 4px 14px rgba(0,0,0,0.2)",
            "padding:4px", "font-family:sans-serif", "font-size:13px",
            "box-sizing:border-box",
          ].join(";");

          // `danger` mirrors PostCardMailbox.js's own ⋯-menu items (its
          // `.pcm-menu-item.danger` class) -- red text/icon for a
          // destructive action, same visual language across both postcard
          // surfaces. `iconColor` is a narrower tint for just the glyph
          // (text stays the normal color) -- used for the Save item's
          // already-saved state, same green as PostCardMailbox.js's own
          // --pcm-accent, so "saved" reads as a positive/active state
          // rather than a destructive one.
          var makeItem = function (label, iconName, onClick, danger, iconColor) {
            var item = document.createElement("div");
            var color = danger ? "#c0392b" : "#333";
            item.style.cssText = [
              "display:flex", "align-items:center", "gap:8px",
              "padding:7px 10px", "border-radius:5px", "cursor:pointer", "color:" + color,
            ].join(";");
            item.innerHTML =
              '<span class="material-symbols-rounded" style="font-size:16px;color:' + (danger ? color : (iconColor || "#666")) + ';">' + iconName + '</span>' +
              '<span>' + label + '</span>';
            item.addEventListener("mouseenter", function () { item.style.background = danger ? "#fdf0ee" : "#f2f2f2"; });
            item.addEventListener("mouseleave", function () { item.style.background = "transparent"; });
            ["mousedown", "click"].forEach(function (t) {
              item.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (t === "click") { self._closeMoreMenu(); onClick(); }
              });
            });
            return item;
          };

          if (this._isOwner) {
            menu.appendChild(makeItem("Edit", "edit", function () {
              lively.identity.PostCardEditor.openCard(self._handle, self._objId);
            }));
          }
          // Reflects whatever _checkCollectionsState last found (fetched in
          // _renderEnvelope) -- "Saved"/filled green icon when this viewer
          // already bookmarked the card, re-clickable to remove it again.
          menu.appendChild(makeItem(
            this._savedToCollections ? "Saved" : "Save",
            this._savedToCollections ? "bookmark" : "bookmark_add",
            function () {
              if (self._savedToCollections) self._removeFromCollections();
              else self._saveToCollections();
            },
            false,
            this._savedToCollections ? "#16a34a" : null
          ));
          menu.appendChild(makeItem("Share", "share", function () {
            self._shareLink();
          }));
          if (this._isOwner) {
            menu.appendChild(makeItem("Delete", "delete", function () {
              self._deleteCard();
            }, true));
          }

          document.body.appendChild(menu);
          this._moreMenuEl = menu;

          // Deferred registration: the same click that opened the menu is
          // still bubbling/capturing at this point, and would otherwise
          // immediately trigger this handler and close the menu it just
          // opened.
          this._moreMenuOutsideHandler = function (e) {
            if (menu.contains(e.target) || e.target === anchorBtn) return;
            self._closeMoreMenu();
          };
          setTimeout(function () {
            document.addEventListener("mousedown", self._moreMenuOutsideHandler, true);
          }, 0);
        },

        _closeMoreMenu: function () {
          if (!this._moreMenuEl) return;
          this._moreMenuEl.remove();
          this._moreMenuEl = null;
          if (this._moreMenuOutsideHandler) {
            document.removeEventListener("mousedown", this._moreMenuOutsideHandler, true);
            this._moreMenuOutsideHandler = null;
          }
        },

        // Fetches whether the current viewer already has this card bookmarked
        // (GET /@:handle/collections/:objId, mirroring GET .../stars and
        // .../reactions' own per-viewer "mine" flag) so the menu's Save item
        // can render already-toggled-on next time it's opened. Silent no-op
        // when logged out -- currentUser() is null and there's nothing to
        // check; the item just stays "Save" (clicking it would 401, same as
        // before this state existed).
        _checkCollectionsState: function () {
          var self = this;
          var user = lively.identity.did.currentUser();
          if (!user) return;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("GET", base + "/@" + user.handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
              self._savedToCollections = !!JSON.parse(xhr.responseText).saved;
            } catch (e) { /* leave state unknown -- item stays "Save" */ }
          };
          xhr.send();
        },

        // Bookmarks this card into the current user's own Collections tab
        // -- same idempotent PUT as PostCardMailbox.js's _saveToCollections
        // (§6.2), just reached from the single-card view instead of a
        // mailbox row menu. Unlike that mailbox call site (silent on
        // success), this one flashes a confirmation -- there's no
        // Collections list visible from here to show the save landed, so
        // the viewer needs explicit feedback rather than an absence of
        // error.
        _saveToCollections: function () {
          var self = this;
          var handle = lively.identity.did.currentUser().handle;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("PUT", base + "/@" + handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) {
              self._savedToCollections = true;
              self._flashNearMoreBtn("Saved to Collections");
            } else {
              self._flashNearMoreBtn("Could not save to Collections", true);
            }
          };
          xhr.onerror = function () {
            self._flashNearMoreBtn("Could not save to Collections", true);
          };
          xhr.send();
        },

        // Un-bookmarks -- the Save menu item's toggled-off counterpart,
        // reached only when _savedToCollections is already true.
        _removeFromCollections: function () {
          var self = this;
          var handle = lively.identity.did.currentUser().handle;
          var base = lively.identity.did.baseUrl();
          var xhr = new XMLHttpRequest();
          xhr.open("DELETE", base + "/@" + handle + "/collections/" + encodeURIComponent(this._objId));
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) {
              self._savedToCollections = false;
              self._flashNearMoreBtn("Removed from Collections");
            } else {
              self._flashNearMoreBtn("Could not remove from Collections", true);
            }
          };
          xhr.onerror = function () {
            self._flashNearMoreBtn("Could not remove from Collections", true);
          };
          xhr.send();
        },

        // Copies this card's canonical URL -- IdentityServer.js's
        // GET /@:handle/:objId content-negotiates a real standalone HTML
        // page for a postcard/wikipage envelope (buildPostCardPage), so
        // this is a genuinely shareable link, not just an API endpoint.
        // Same clipboard-with-prompt-fallback idiom as WikiView.js's
        // _copyShareLink.
        _shareLink: function () {
          var self = this;
          var url = lively.identity.did.baseUrl() + "/@" + encodeURIComponent(this._handle) +
            "/" + encodeURIComponent(this._objId);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
              .then(function () { self._flashNearMoreBtn("Link copied"); })
              .catch(function () { window.prompt("Copy this link:", url); });
          } else {
            window.prompt("Copy this link:", url);
          }
        },

        // Placeholder -- real delete needs to decide between "hide from my
        // mailbox" vs. a genuine tombstone PUT depending on whether the
        // card is already frozen (state.sentAt), same branching
        // PostCardMailbox.js's _deletePostcard/_hideFromMailbox already
        // handle for the mailbox list view. Not wired up here yet; this
        // just gives the menu item somewhere to go without silently doing
        // nothing on click.
        _deleteCard: function () {
          this._flashNearMoreBtn("Delete isn't wired up here yet", true);
        },

        // Small transient tooltip near the "more" button -- used for both
        // success (e.g. "Link copied") and failure feedback. Deliberately
        // NOT _showError (which replaces the whole rendered card with an
        // error message, appropriate only for an initial-load failure) --
        // a failed menu action shouldn't blank out content the viewer is
        // already looking at.
        _flashNearMoreBtn: function (msg, isError) {
          if (isError) console.error("[PostCardView]", msg);
          if (!this._moreBtn) return;
          var rect = this._moreBtn.getBoundingClientRect();
          var bubble = document.createElement("div");
          bubble.textContent = msg;
          var bg = isError ? "#fff5f5" : "#f0fdf4";
          var border = isError ? "#f3b4b4" : "#bbf7d0";
          var color = isError ? "#a33" : "#166534";
          bubble.style.cssText = [
            "position:fixed", "z-index:9999",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "left:" + Math.round(rect.right - 180) + "px",
            "width:180px", "background:" + bg, "border:1px solid " + border,
            "color:" + color, "border-radius:8px", "box-shadow:0 4px 14px rgba(0,0,0,0.2)",
            "padding:7px 10px", "font-family:sans-serif", "font-size:12px",
            "box-sizing:border-box",
          ].join(";");
          document.body.appendChild(bubble);
          setTimeout(function () { bubble.remove(); }, 2200);
        },
      },

      "rendering",
      {
        _renderEnvelope: function (envelope) {
          this._envelope = envelope;
          var user = lively.identity.did.currentUser();
          this._isOwner = !!(user && user.did === envelope.did);
          // Reset (not just left stale) so a reused view instance (e.g. the
          // reel paging to a new card) doesn't show the PREVIOUS card's
          // saved-state for a split second before _checkCollectionsState's
          // fetch for the new one resolves.
          this._savedToCollections = false;

          this._loadAvatar();
          this._titleEl.textContent =
            (envelope.state && envelope.state.title) || "(untitled)";
          // The "more" button itself stays visible for every viewer --
          // Save to Collections applies regardless of ownership. Edit is
          // gated inside the menu's own contents instead (_toggleMoreMenu).

          this._renderContentArea(envelope);
          this._renderMembershipActions(envelope);
          this._renderBackMeta(envelope);
          this._renderReactionsFooter(envelope);
          this._verify(envelope);
          this._checkCollectionsState();
        },

        // Approve/Decline for a constellation-join-request card
        // (ConstellationCanvas.js's / ConstellationLounge.js's _requestJoin) — the card itself is the
        // approval UI (owner decision: no separate pending-requests panel).
        // envelope.did is the requester (they authored+signed this card
        // themselves), matching PUT /c/:constellation/join-requests/:did's
        // expected param. Controller-gated via the same GET
        // /c/:constellation/space-token check WikiView.js's Edit button
        // already uses for its own owner-or-canWrite gate.
        _renderMembershipActions: function (envelope) {
          var self = this;
          var state = envelope.state || {};
          if (state.kind !== "constellation-join-request" || !envelope.constellation) return;

          var bar = document.createElement("div");
          bar.style.cssText = [
            "margin-bottom:8px", "padding:6px 8px",
            "background:#fff9e6", "border:1px solid #f0e0a0", "border-radius:6px",
            "font-size:11px", "color:#8a6d1f", "line-height:1.6",
          ].join(";");
          bar.textContent = "Checking access…";
          this._contentEl.insertBefore(bar, this._contentEl.firstChild);

          var base = lively.identity.did.baseUrl();
          var constellation = envelope.constellation;
          fetch(base + "/c/" + encodeURIComponent(constellation) + "/space-token", { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
              // Not a controller (or not signed in) — this card is still a
              // perfectly normal, readable postcard for everyone else; just
              // no action bar.
              if (!data || !data.isController) { bar.remove(); return; }

              // Check this specific request's resolution status before
              // showing anything — previously the Approve/Decline buttons
              // rendered unconditionally on every view, even long after any
              // controller had already resolved the request (the PUT itself
              // was guarded server-side, but the card kept inviting a
              // second click). A resolved request now shows a persistent
              // status line instead — the "no further action needed"
              // confirmation controllers asked for.
              fetch(base + "/c/" + encodeURIComponent(constellation) + "/join-requests/" +
                encodeURIComponent(envelope.did), { credentials: "include" })
                .then(function (res) { return res.ok ? res.json() : { status: null }; })
                .then(function (statusData) {
                  self._renderMembershipActionsBar(bar, envelope, constellation, statusData.status);
                })
                .catch(function () { bar.remove(); });
            })
            .catch(function () { bar.remove(); });
        },

        _renderMembershipActionsBar: function (bar, envelope, constellation, status) {
          var self = this;
          var base = lively.identity.did.baseUrl();

          if (status === "approved" || status === "declined") {
            bar.textContent = status === "approved"
              ? "✓ Approved — @" + self._handle + " is now a member of c/" + constellation + "."
              : "Declined @" + self._handle + "'s request.";
            return;
          }

          bar.innerHTML = "";
          var label = document.createElement("span");
          label.textContent = "Join request for c/" + constellation + ": ";
          bar.appendChild(label);

          function makeBtn(text, colorBorder, colorBg, colorText) {
            var btn = document.createElement("button");
            btn.textContent = text;
            btn.style.cssText = [
              "margin-right:6px", "font-size:11px", "padding:2px 8px", "cursor:pointer",
              "border:1px solid " + colorBorder, "border-radius:10px",
              "background:" + colorBg, "color:" + colorText,
            ].join(";");
            ["mousedown", "click"].forEach(function (t) {
              btn.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
              });
            });
            return btn;
          }
          var approveBtn = makeBtn("Approve", "#8fbf8f", "#eaf7ea", "#1e7a1e");
          var declineBtn = makeBtn("Decline", "#d9a0a0", "#fbeaea", "#a11e1e");

          function resolve(action) {
            approveBtn.disabled = true;
            declineBtn.disabled = true;
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", base + "/c/" + encodeURIComponent(constellation) +
              "/join-requests/" + encodeURIComponent(envelope.did), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              bar.innerHTML = "";
              if (xhr.status === 200) {
                bar.textContent = action === "approve"
                  ? "✓ Approved — @" + self._handle + " is now a member of c/" + constellation + "."
                  : "Declined @" + self._handle + "'s request.";
                if (action === "approve") self._sendWelcomeCard(constellation, self._handle);
              } else {
                var msg = "Failed (" + xhr.status + ")";
                try { var body = JSON.parse(xhr.responseText); if (body.error) msg = body.error; } catch (e) {}
                bar.textContent = msg;
              }
            };
            xhr.onerror = function () { bar.textContent = "Network error"; };
            xhr.send(JSON.stringify({ action: action }));
          }
          approveBtn.addEventListener("click", function () { resolve("approve"); });
          declineBtn.addEventListener("click", function () { resolve("decline"); });
          bar.appendChild(approveBtn);
          bar.appendChild(declineBtn);
        },

        // Approving controller's own device key signs a small "you're in"
        // postcard (never server-fabricated, same posture as every other
        // card in this system) and delivers it via the same generic postal
        // route regular postcard sends already use (POST /@handle/inbox) —
        // no join-request-specific delivery plumbing needed.
        _sendWelcomeCard: function (constellation, recipientHandle) {
          var user = lively.identity.did.currentUser();
          if (!user) return;
          var base = lively.identity.did.baseUrl();
          lively.require("lively.identity.PostCardSerializer").toRun(function () {
            var doc = {
              type: "doc",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "You are now a member of c/" + constellation + "." }],
              }],
            };
            lively.identity.postCardSerializer.serializePlainToEnvelope({
              doc: doc,
              title: "Welcome to c/" + constellation,
              titleExplicit: true,
              visibility: "public",
            }, function (err, envelope) {
              if (err) return console.error("[PostCardView] Could not create welcome card:", err.message);
              var putXhr = new XMLHttpRequest();
              putXhr.open("PUT", base + "/@" + encodeURIComponent(user.handle) + "/" + encodeURIComponent(envelope.objId), true);
              putXhr.withCredentials = true;
              putXhr.setRequestHeader("Content-Type", "application/json");
              putXhr.onload = function () {
                if (putXhr.status !== 200) return console.error("[PostCardView] Could not save welcome card:", putXhr.status);
                var deliverXhr = new XMLHttpRequest();
                deliverXhr.open("POST", base + "/@" + encodeURIComponent(recipientHandle) + "/inbox", true);
                deliverXhr.withCredentials = true;
                deliverXhr.setRequestHeader("Content-Type", "application/json");
                deliverXhr.send(JSON.stringify({ objId: envelope.objId }));
              };
              putXhr.send(JSON.stringify(envelope));
            });
          });
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

        // Builds this._contentEl's HTML from a ProseMirror snapshot. Default
        // (_previewMode false, every caller except ConstellationLounge's
        // reel): unchanged plain natural document order, same as always.
        // Opt-in (_previewMode true): reorders via
        // postCardUtils.buildPreviewSplit into the "Reddit-like" media-
        // forward shape (lead excerpt -> media -> rest) — falls back to the
        // exact same unsplit render if the doc has no media at all. Called
        // from both places that used to assign _contentEl.innerHTML
        // directly (the public branch below, and _decryptAndRenderContent's
        // post-decrypt render) so preview mode applies consistently to
        // public and decrypted-private content alike.
        _renderContentHtml: function (snapshot) {
          var U = lively.identity.postCardUtils;
          if (!snapshot) { this._contentEl.innerHTML = ""; return; }
          if (!this._previewMode) {
            this._contentEl.innerHTML = U.snapshotToHtml(snapshot);
            return;
          }
          var split = U.buildPreviewSplit(snapshot.content, {});
          if (!split.hasMedia) {
            this._contentEl.innerHTML = U.snapshotToHtml(snapshot);
            return;
          }
          var parts = [];
          if (split.leadExcerpt) {
            parts.push('<div class="lively-postcard-preview-lead">' + U.escapeHtml(split.leadExcerpt) + '</div>');
          }
          parts.push('<div class="lively-postcard-preview-media">' + split.mediaHtml + '</div>');
          if (split.restHtml) {
            // Unclamped here (no -rest-clamped modifier) — this card grows
            // to fit its content (ConstellationLounge's _fitCardToContent),
            // it doesn't need PostCardFeed's fixed-max-height fade-clip.
            parts.push('<div class="lively-postcard-preview-rest">' + split.restHtml + '</div>');
          }
          this._contentEl.innerHTML = parts.join('');
        },

        _renderContentArea: function (envelope) {
          var self = this;
          if (envelope.visibility === "public") {
            var payload = envelope.record && envelope.record.payload;
            // Plain postcards (§1.1/§2.3, PostcardDesignSpec-v2.md): `doc` IS
            // the snapshot — no separate extraction step, same ProseMirror
            // JSON shape `snapshotToHtml` already renders. Wiki-mode cards
            // (§1.2, format: "yjs-update-v1", or any pre-split legacy card
            // saved before this format existed) keep using `snapshot`.
            var snapshot = payload &&
              (payload.format === "prosemirror-doc-v1" ? payload.doc : payload.snapshot);
            this._renderContentHtml(snapshot);
            // BUG FIX: embedded Lively parts used to render as a permanent
            // "[Embedded Part: <objId>]" text stub here — nothing ever
            // turned the placeholder into the live morph it references.
            lively.identity.postCardUtils.hydrateEmbeddedParts(this._contentEl);
            return;
          }

          // Encrypted content — see file-level comment. Show a locked
          // placeholder; "View content" decrypts and renders in place
          // (_decryptAndRenderContent) rather than opening a separate
          // editor window.
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
              if (t === "click") self._decryptAndRenderContent(envelope, lock, viewBtn);
            });
          });
          lock.appendChild(viewBtn);
          this._contentEl.appendChild(lock);
        },

        // Decrypts envelope.record.payload in place and renders it into
        // this._contentEl, replacing the locked placeholder — the WebAuthn
        // ceremony (deriveKek for the owner, deriveX25519KeyPair for a
        // recipient) happens inside deserializeEncryptedAuto; this method
        // only handles the loading/success/error UI around that call and
        // the render step afterward. Re-entrant-safe: a second click while
        // a decrypt is already in flight for this same viewBtn is a no-op.
        _decryptAndRenderContent: function (envelope, lockEl, viewBtn) {
          var self = this;
          if (this._decryptInFlight) return;
          this._decryptInFlight = true;

          viewBtn.disabled = true;
          viewBtn.textContent = "Decrypting…";

          lively.identity.postCardSerializer.deserializeEncryptedAuto(envelope, function (err, mode, content, payload) {
            self._decryptInFlight = false;
            // Guard against a slow decrypt (WebAuthn prompt sat open a
            // while) resolving after this morph moved on to a different
            // card/objId — same pattern as _loadAvatar's handle check.
            if (self._envelope !== envelope) return;

            if (err) {
              self._renderDecryptError(err, lockEl, viewBtn);
              return;
            }

            var snapshot = mode === "wiki"
              ? lively.identity.postCardSerializer._extractSnapshot(content)
              : content;
            if (!snapshot) {
              self._renderDecryptError(new Error("Could not read decrypted content"), lockEl, viewBtn);
              return;
            }

            self._renderContentHtml(snapshot);
            lively.identity.postCardUtils.hydrateEmbeddedParts(self._contentEl);
            lively.identity.postCardUtils.hydrateAttachments(
              self._contentEl, self._handle, (payload && payload.attachments) || [],
            );
          });
        },

        // Inline error UI, not a whole-morph error — only the content area
        // failed, the rest of the card (avatar, title, back/verify badge)
        // already rendered fine.
        _renderDecryptError: function (err, lockEl, viewBtn) {
          console.error("[PostCardView] decrypt failed:", err && err.message);
          viewBtn.disabled = false;
          viewBtn.textContent = "Retry";
          var msgEl = lockEl.querySelector(".lively-postcard-view-decrypt-error");
          if (!msgEl) {
            msgEl = document.createElement("div");
            msgEl.className = "lively-postcard-view-decrypt-error";
            msgEl.style.cssText = "font-size:10px;color:#c33;max-width:180px;text-align:center;";
            lockEl.appendChild(msgEl);
          }
          msgEl.textContent = (err && err.message) || "Failed to decrypt";
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

      "reactions",
      {
        // Shows/hides and (re)populates the reactions footer for the given
        // envelope. reactionsEnabled and the tip jar are independent
        // opt-outs (§5.4) — the footer shows if either has something to
        // display, not only when reactions are on. reactionsEnabled
        // defaults to true ("each defaulting on"), so only an explicit
        // `false` turns reactions off; the tip jar's presence is gated
        // purely by whether tipJarAddress is set at all (§5.3). Delete
        // (§6.3) lives in PostCardMailbox's "My Postcards" tab instead of
        // here — this is a read-only reader, and the only place that
        // actually lists a user's own authored cards is that mailbox tab.
        _renderReactionsFooter: function (envelope) {
          var reactionsOn = !(envelope.state && envelope.state.reactionsEnabled === false);
          var tipJarAddress = (envelope.state && envelope.state.tipJarAddress) || null;

          if (!reactionsOn && !tipJarAddress) {
            this._footerEl.style.display = "none";
            this._tipJarChipEl.innerHTML = "";
            this._pillsWrapEl.innerHTML = "";
            return;
          }

          this._footerEl.style.display = "flex";

          this._tipJarChipEl.innerHTML = "";
          if (tipJarAddress) this._renderTipJarChip(tipJarAddress);

          if (reactionsOn) {
            this._pillsWrapEl.style.display = "";
            this._loadReactions();
          } else {
            this._pillsWrapEl.style.display = "none";
            this._pillsWrapEl.innerHTML = "";
          }
        },

        // Tip jar (§5.3) — display-and-copy only, no wallet integration.
        _renderTipJarChip: function (address) {
          var chip = document.createElement("button");
          chip.textContent = "💰 Tip";
          chip.title = address;
          chip.style.cssText = [
            "flex:none",
            "font-size:14px",
            "padding:2px 9px",
            "border-radius:13px",
            "cursor:pointer",
            "border:1px solid #ddd",
            "background:#fffaf0",
            "color:#333",
          ].join(";");
          ["mousedown", "click"].forEach(function (t) {
            chip.addEventListener(t, function (e) {
              e.preventDefault();
              e.stopPropagation();
              if (t !== "click") return;
              var restore = chip.textContent;
              function copied() {
                chip.textContent = "Copied!";
                setTimeout(function () { chip.textContent = restore; }, 1200);
              }
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(address).then(copied).catch(function () {});
              } else {
                // Fallback for contexts without the async Clipboard API.
                var ta = document.createElement("textarea");
                ta.value = address;
                ta.style.cssText = "position:fixed;opacity:0;";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); copied(); } catch (e2) {}
                document.body.removeChild(ta);
              }
            });
          });
          this._tipJarChipEl.appendChild(chip);
        },

        _loadReactions: function () {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions";
          fetch(url, { credentials: "include" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { if (data) self._renderReactionPills(data); })
            .catch(function () {}); // network error — leave the footer as-is
        },

        // The two fixed reactions, always shown (count appended once
        // non-zero). One reaction per user, so picking one replaces the
        // other; clicking your own again removes it. Signed-out viewers see
        // the counts but can't react.
        _renderReactionPills: function (data) {
          var self = this;
          this._pillsWrapEl.innerHTML = "";
          var counts = data.counts || {};
          var mine = data.mine || null;
          var currentUser = lively.identity.did.currentUser();
          var toAnimate = null;

          ["⭐", "🪿"].forEach(function (emoji) {
            var isMine = emoji === mine;
            var n = counts[emoji] || 0;
            var pill = document.createElement("button");
            // The emoji sits in its own inline-block span so the pop/spin
            // animation can transform it without moving the count.
            var em = document.createElement("span");
            em.textContent = emoji;
            em.style.cssText = "display:inline-block;";
            pill.appendChild(em);
            if (n) pill.appendChild(document.createTextNode(" " + self._abbreviateCount(n)));
            pill.title = (data.byEmoji && data.byEmoji[emoji] || []).join(", ");
            pill.style.cssText = [
              "flex:none",
              "font-size:14px",
              "padding:2px 9px",
              "border-radius:13px",
              "cursor:" + (currentUser ? "pointer" : "default"),
              "border:1px solid " + (isMine ? "#5566cc" : "#ddd"),
              "background:" + (isMine ? "#eef0fd" : "#fafafa"),
              "color:#333",
            ].join(";");
            ["mousedown", "click"].forEach(function (t) {
              pill.addEventListener(t, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (t !== "click" || !currentUser) return;
                if (isMine) self._deleteMyReaction();
                else {
                  // Played once the re-render after the PUT lands, since
                  // that rebuilds every pill (see below).
                  self._pendingReactionAnim = emoji;
                  self._putReaction(emoji);
                }
              });
            });
            self._pillsWrapEl.appendChild(pill);
            if (isMine && self._pendingReactionAnim === emoji) toAnimate = { pill: pill, em: em, emoji: emoji };
          });
          this._pendingReactionAnim = null;
          // Only once both pills are in place: the wrap is right-aligned, so
          // measuring right after the star alone is appended (before the
          // goose exists) puts the burst a whole pill's width too far right.
          if (toAnimate) this._playReactionAnim(toAnimate.pill, toAnimate.em, toAnimate.emoji);
        },

        // 999 -> "999", 1234 -> "1.2k", 12345 -> "12k", 1500000 -> "1.5M".
        // Floors (never rounds up) so 999999 reads "999k", not "1000k".
        _abbreviateCount: function (n) {
          var units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
          for (var i = 0; i < units.length; i++) {
            if (n >= units[i][0]) {
              var v = n / units[i][0];
              var txt = v < 10 ? (Math.floor(v * 10) / 10).toString() : Math.floor(v).toString();
              return txt + units[i][1];
            }
          }
          return String(n);
        },

        _ensureReactionAnimCss: function () {
          if (document.getElementById("lively-postcard-reaction-anim")) return;
          var st = document.createElement("style");
          st.id = "lively-postcard-reaction-anim";
          st.textContent = [
            "@keyframes lpc-star-pop{0%{transform:scale(.5) rotate(0)}55%{transform:scale(1.6) rotate(200deg)}100%{transform:scale(1) rotate(360deg)}}",
            "@keyframes lpc-goose-pop{0%{transform:scale(.5) rotate(0)}30%{transform:scale(1.5) rotate(-18deg)}60%{transform:scale(1.5) rotate(14deg)}100%{transform:scale(1) rotate(0)}}",
            "@keyframes lpc-burst{0%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(.2);opacity:0}}",
            "@keyframes lpc-ring{0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.5);opacity:0}}",
          ].join("");
          document.head.appendChild(st);
        },

        // Like-button style pop: the emoji springs (star spins, goose
        // wiggles) while a ring and a ring of dots burst out from it. The
        // burst is added to the card (not the pill or the front face): the
        // footer scrolls horizontally and the front face is overflow:hidden,
        // and the pills sit ~12px from the card's bottom edge, so either
        // would clip the lower half of the burst.
        _playReactionAnim: function (pill, emojiEl, emoji) {
          if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
          this._ensureReactionAnimCss();
          var isStar = emoji === "⭐";
          emojiEl.style.animation = (isStar ? "lpc-star-pop" : "lpc-goose-pop") + " 500ms cubic-bezier(.2,.8,.3,1)";

          var fr = this._cardEl.getBoundingClientRect();
          var er = emojiEl.getBoundingClientRect();
          var scale = (this._cardEl.offsetWidth && fr.width / this._cardEl.offsetWidth) || 1;
          var cx = (er.left + er.width / 2 - fr.left) / scale;
          var cy = (er.top + er.height / 2 - fr.top) / scale;

          var colors = isStar ? ["#f5b301", "#ffd54a", "#ff9f1c"] : ["#e8497e", "#ff8fb1", "#ffc2d6"];
          var burst = document.createElement("div");
          burst.style.cssText = "position:absolute;left:" + cx + "px;top:" + cy + "px;width:0;height:0;pointer-events:none;z-index:11;transform:translateZ(1px);";

          var ring = document.createElement("div");
          ring.style.cssText = [
            "position:absolute", "left:0", "top:0", "width:26px", "height:26px",
            "border-radius:50%", "box-sizing:border-box",
            "border:2px solid " + colors[0],
            "animation:lpc-ring 450ms ease-out forwards",
          ].join(";");
          burst.appendChild(ring);

          var N = 8;
          for (var i = 0; i < N; i++) {
            var ang = (i / N) * 2 * Math.PI;
            var dist = 22;
            var dot = document.createElement("div");
            dot.style.cssText = [
              "position:absolute", "left:0", "top:0", "width:5px", "height:5px",
              "border-radius:50%",
              "background:" + colors[i % colors.length],
              "--dx:" + Math.round(Math.cos(ang) * dist) + "px",
              "--dy:" + Math.round(Math.sin(ang) * dist) + "px",
              "animation:lpc-burst 500ms ease-out forwards",
            ].join(";");
            burst.appendChild(dot);
          }

          this._cardEl.appendChild(burst);
          setTimeout(function () {
            if (burst.parentNode) burst.parentNode.removeChild(burst);
          }, 650);
        },

        _putReaction: function (emoji) {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions";
          fetch(url, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emoji: emoji }),
          })
            .then(function () { self._loadReactions(); })
            .catch(function () {});
        },

        _deleteMyReaction: function () {
          var self = this;
          var base = lively.identity.did.baseUrl();
          var url =
            base + "/@" + encodeURIComponent(this._handle) + "/" +
            encodeURIComponent(this._objId) + "/reactions/self";
          fetch(url, { method: "DELETE", credentials: "include" })
            .then(function () { self._loadReactions(); })
            .catch(function () {});
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
        PostCardViewClass._disableWorldRename();
      },

      // A standalone PostCardView boots into its own ephemeral per-object
      // world (IdentityServer.js's buildPostCardPage), which — like any
      // Lively world — gets the generic WorldNameMenuBarEntry by default.
      // Its "rename this world" action serializes the *entire current
      // world* as a fresh type:"world" envelope and PUTs it to whatever
      // objId is in the current URL, with no idea a real postcard envelope
      // already lives there (confirmed live for the wikipage counterpart —
      // see WikiView.js's identical helper). IdentityServer.js's PUT
      // handler now rejects a type-mismatched overwrite server-side
      // regardless, but the action is also meaningless here (a single
      // postcard isn't "a world" to rename), so it's disabled at the
      // source too.
      _disableWorldRename: function () {
        var attempts = 0;
        (function tryDisable() {
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          var entry = menuBar &&
            (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          if (entry) {
            entry.renamePrompt = function () {
              $world.alert("This page is a single post card, not a renameable Lively world.");
            };
            return;
          }
          if (++attempts > 25) return;
          setTimeout(tryDisable, 200);
        })();
      },

      // options.target      -> embed via target.addMorph(view)
      // options.envelope    -> render immediately, skip the fetch
      // options.cid         -> view a specific historical version
      // options.bounds      -> override the default postcard-shaped extent
      // options.previewMode -> opt-in media-forward content reordering (see
      //   _renderContentHtml) — default false, so every existing caller
      //   keeps rendering in plain natural document order unchanged.
      //   ConstellationLounge.js's reel is the only caller that passes this.
      open: function (handle, objId, options) {
        var opts = options || {};
        var view = new lively.identity.PostCardView(
          opts.bounds || lively.rect(0, 0, 420, 300),
        );
        view._handle = handle;
        view._objId = objId;
        view._cid = opts.cid || null;
        view._envelope = opts.envelope || null;
        view._previewMode = !!opts.previewMode;
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
