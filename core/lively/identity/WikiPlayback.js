/**
 * lively.identity.WikiPlayback
 *
 * BuildSpec morph — read-only history playback mode for wiki pages
 * (WikiEditor.js's "History" button). Plain post cards dropped their
 * playback entry point since they're single-author and never live-synced,
 * so there's rarely a meaningful history to scrub (PostcardDesignSpec-v2.md
 * §15, ConstellationDesignSpec.md §2.2/§3.1's wiki-playback carryover) —
 * this file used to be named PostCardPlayback.js from when both types
 * shared it. The mechanism itself stays generic over any envelope type —
 * `/versions` and `/at/:cid` are type-agnostic — in case a plain-card entry
 * point returns later.
 *
 * Architecture:
 *   - Opens a windowed morph that shows a timeline slider + snapshot viewer.
 *   - Fetches `GET /@:handle/:objId/versions` for the ordered version list
 *     (list of { cid, created, objId } records, newest last).
 *   - Timeline slider position → CID → fetch snapshot from
 *     `GET /@:handle/:objId/at/:cid` (returns the full envelope at that version).
 *   - Snapshot rendered as static ProseMirror HTML (no editor, no Y.Doc).
 *   - Entirely disconnected from the live sync provider — never touches
 *     WebsocketProvider or mutates the live Y.Doc.
 *   - "Live view" button returns the user to the live editor/view state,
 *     routed by the envelope type seen on the last version fetched
 *     (WikiEditor/WikiView today; PostCardEditor/PostCardView kept as the
 *     fallback branch).
 *
 * Version API shapes:
 *   GET /@:handle/:objId/versions
 *   → { versions: [{cid, created, objId, seq}], count: N }
 *
 *   GET /@:handle/:objId/at/:cid
 *   → { envelope } (full signed envelope at that version)
 *
 * Entry point:
 *   lively.identity.WikiPlayback.openPlayback(handle, objId, options)
 *
 * Dependencies:
 *   lively.identity.DID — baseUrl()
 */

module('lively.identity.WikiPlayback')
  // Deliberately does NOT declare lively.identity.WikiEditor/WikiView (or
  // the plain-card equivalents) as requires: WikiEditor.js requires
  // WikiPlayback, so either edge back here would be a module cycle.
  // _exitPlayback below loads whichever module it needs via lively.require
  // instead of assuming it's already loaded.
  .requires('lively.identity.DID', 'lively.identity.PostCardUtils')
  .toRun(function () {

    lively.morphic.Box.subclass('lively.identity.WikiPlayback',

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — state is set by openPlayback before _setup().

      // Also re-invoked by prepareForNewRenderContext below after a
      // world-reload restore. _buildChrome mixes real morphic submorphs
      // (header/timelinePanel/snapViewer) with raw DOM nested inside them
      // (playBtn, sliderInput, snapDiv) — clear old submorphs first so a
      // restore rebuild doesn't stack a second header/timeline on top.
      _setup: function () {
        // Not disabled by default (confirmed live: isGrabbable() === true
        // out of the box, same as any Morph) — without this, a mousedown on
        // the slider grabs and drags the whole panel around instead of
        // seeking, since the panel sits on top of the native <input
        // type=range> rather than the other way around. WikiView.js/
        // PostCardView.js disable both for the same reason.
        this.disableDragging();
        this.disableGrabbing();
        (this.submorphs || []).slice().forEach(function (m) { m.remove(); });
        this._versions = [];
        this._currentIndex = 0;
        this._loading = false;
        this._playing = false;
        this._playTimer = null;
        this._playBtn = null;
        this._buildChrome();
        this._fetchVersions();
      },

      // Fires once, harmlessly, during construction — before openPlayback
      // has set _handle, so the guard below skips it (openPlayback calls
      // _setup() itself once configured). Fires again, recursively, on
      // every submorph in the world whenever a saved world is reloaded (see
      // Rendering.js's prepareForNewRenderContext) or this morph is copied.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._handle) return;
        this._setup();
      },

    },

    // ─── chrome ──────────────────────────────────────────────────────────────────

    'chrome', {

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.rgb(245, 245, 250));
        var sn = this.renderContext().shapeNode;
        sn.style.borderRadius = '8px';
        sn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';

        // Header bar
        var header = new lively.morphic.Box(lively.rect(0, 0, 660, 36));
        header.setFill(Color.rgb(55, 55, 70));
        this.addMorph(header);

        var title = lively.morphic.Text.makeLabel(
          'Playback: ' + (this._objId || ''),
          { fontSize: 13, textColor: Color.white }
        );
        title.setPosition(lively.pt(12, 10));
        title.setExtent(lively.pt(400, 20));
        header.addMorph(title);
        this._headerTitle = title;

        // "Live view" button in header
        var liveBtn = new lively.morphic.Button(lively.rect(584, 6, 64, 24));
        liveBtn.setLabel('↩ Live');
        liveBtn.onMouseDown = function () { self._exitPlayback(); };
        header.addMorph(liveBtn);

        // Timeline area (slider + info row)
        var timelinePanel = new lively.morphic.Box(lively.rect(0, 36, 660, 48));
        timelinePanel.setFill(Color.rgb(235, 235, 245));
        this.addMorph(timelinePanel);
        this._timelinePanel = timelinePanel;

        // Play/pause button
        var playBtn = document.createElement('button');
        playBtn.textContent = '▶';
        playBtn.title = 'Play / pause auto-advance';
        playBtn.style.cssText = [
          'position:absolute', 'top:10px', 'left:12px',
          'width:32px', 'height:28px', 'font-size:14px',
          'cursor:pointer', 'border:1px solid #ccc',
          'border-radius:3px', 'background:#fff',
        ].join(';');
        playBtn.addEventListener('click', function () { self._togglePlay(); });
        timelinePanel.renderContext().shapeNode.appendChild(playBtn);
        this._playBtn = playBtn;

        // Slider — rendered as an <input type="range"> via HtmlWrapperMorph.
        // Content must go through the morph's own appendChild() (which
        // targets the live renderContext().shapeNode), not
        // wrap.rootElement.appendChild() directly — rootElement is the
        // constructor-time DOM node the External shape was built from, but
        // it never ends up attached to the actual render tree (confirmed
        // live: appending to it silently produces an empty, invisible
        // morph). Same fix applies to snapViewer below. Also: addMorph()
        // before appendChild(), so renderContext() resolves to the node
        // that's actually mounted.
        var sliderWrap = new lively.morphic.HtmlWrapperMorph(lively.pt(456, 28));
        sliderWrap.setPosition(lively.pt(52, 8));
        timelinePanel.addMorph(sliderWrap);
        var sliderInput = document.createElement('input');
        sliderInput.type = 'range';
        sliderInput.min = '0';
        sliderInput.max = '0';
        sliderInput.value = '0';
        sliderInput.style.cssText = 'width:100%;height:28px;cursor:pointer';
        sliderInput.addEventListener('input', function () {
          var idx = parseInt(sliderInput.value, 10);
          self._seekTo(idx);
        });
        sliderWrap.appendChild(sliderInput);
        this._sliderInput = sliderInput;

        // Version info label (timestamp + seq)
        var versionInfo = lively.morphic.Text.makeLabel(
          'Loading versions…',
          { fontSize: 11, textColor: Color.gray }
        );
        versionInfo.setPosition(lively.pt(516, 14));
        versionInfo.setExtent(lively.pt(136, 20));
        // Not setTextAlignment() — that method doesn't exist on a
        // makeLabel()'d Text morph (confirmed live: TypeError, and this was
        // the only call to it anywhere in the codebase, so it had never
        // actually run before this playback entry point became reachable).
        versionInfo.applyStyle({ textAlign: 'right' });
        timelinePanel.addMorph(versionInfo);
        this._versionInfo = versionInfo;

        // Snapshot viewer — a scrollable HTML area
        var snapViewer = new lively.morphic.HtmlWrapperMorph(lively.pt(660, 416));
        snapViewer.setPosition(lively.pt(0, 84));
        this.addMorph(snapViewer);
        var snapDiv = document.createElement('div');
        snapDiv.style.cssText = [
          'padding:20px 28px',
          'font-family:sans-serif',
          'font-size:14px',
          'line-height:1.7',
          'overflow-y:auto',
          'height:100%',
          'box-sizing:border-box',
          'background:#fff',
        ].join(';');
        snapViewer.appendChild(snapDiv);
        this._snapViewer = snapViewer;
        this._snapDiv = snapDiv;
      },

    },

    // ─── version loading ─────────────────────────────────────────────────────────

    'versions', {

      _fetchVersions: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) +
                  '/' + encodeURIComponent(this._objId) + '/versions';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) {
            self._setSnapHtml('<p style="color:red">Failed to load versions: ' + xhr.status + '</p>');
            return;
          }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) {
            self._setSnapHtml('<p style="color:red">JSON parse error: ' + lively.identity.postCardUtils.escapeHtml(e.message) + '</p>');
            return;
          }
          self._onVersionsLoaded(data.versions || []);
        };
        xhr.onerror = function () {
          self._setSnapHtml('<p style="color:red">Network error loading versions</p>');
        };
        xhr.send();
      },

      _onVersionsLoaded: function (versions) {
        // Versions from server may be newest-first; we want oldest→newest for
        // the slider (left = oldest, right = newest / live).
        // ObjectRepository.listVersions returns createdAt (not created) and no seq.
        // Normalize here: copy createdAt → created, add seq = index + 1.
        var normalized = versions.map(function (v, i) {
          return Object.assign({}, v, {
            created: v.created || v.createdAt || '',
            seq: i + 1,
          });
        });
        // Already ASC from the DB (ORDER BY id ASC) but sort defensively.
        this._versions = normalized.sort(function (a, b) {
          return (a.created || '').localeCompare(b.created || '');
        });

        var count = this._versions.length;
        this._sliderInput.max = String(Math.max(0, count - 1));
        this._sliderInput.value = String(count - 1); // start at latest

        if (count === 0) {
          this._setVersionInfo('No versions');
          this._setSnapHtml('<p style="color:gray">No version history available.</p>');
          return;
        }

        this._seekTo(count - 1);
      },

    },

    // ─── seeking / rendering ─────────────────────────────────────────────────────

    'playback', {

      _togglePlay: function () {
        if (this._playing) { this._stopPlay(); } else { this._startPlay(); }
      },

      _startPlay: function () {
        if (this._playing || !this._versions || !this._versions.length) return;
        this._playing = true;
        if (this._playBtn) this._playBtn.textContent = '⏸';
        var self = this;
        // Advance every 2 s; skip the tick if still loading the previous version.
        this._playTimer = setInterval(function () {
          if (self._loading) return;
          var next = self._currentIndex + 1;
          if (next >= self._versions.length) { self._stopPlay(); return; }
          self._seekTo(next);
        }, 2000);
      },

      _stopPlay: function () {
        this._playing = false;
        clearInterval(this._playTimer);
        this._playTimer = null;
        if (this._playBtn) this._playBtn.textContent = '▶';
      },

      _seekTo: function (index) {
        if (this._loading) return;
        var versions = this._versions;
        if (!versions || !versions.length) return;
        index = Math.max(0, Math.min(versions.length - 1, index));
        this._currentIndex = index;

        // Update slider position
        this._sliderInput.value = String(index);

        var version = versions[index];
        var ts = version.created ? new Date(version.created).toLocaleString() : '?';
        this._setVersionInfo('v' + (version.seq !== undefined ? version.seq : (index + 1)) + '  ' + ts);

        this._fetchVersionSnapshot(version.cid);
      },

      _fetchVersionSnapshot: function (cid) {
        var self = this;
        if (!cid) return this._setSnapHtml('<p style="color:gray">No CID for this version.</p>');

        this._loading = true;
        this._setSnapHtml('<p style="color:gray">Loading…</p>');

        var base = lively.identity.did.baseUrl();
        var url = base + '/@' + encodeURIComponent(this._handle) +
                  '/' + encodeURIComponent(this._objId) +
                  '/at/' + encodeURIComponent(cid);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          self._loading = false;
          if (xhr.status !== 200) {
            self._setSnapHtml('<p style="color:red">Failed to load version: ' + xhr.status + '</p>');
            return;
          }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) {
            self._setSnapHtml('<p style="color:red">Parse error: ' + lively.identity.postCardUtils.escapeHtml(e.message) + '</p>');
            return;
          }
          var envelope = data.envelope || data;
          self._objType = envelope.type || self._objType;
          var payload = envelope.record && envelope.record.payload;
          // Plain postcards (§1.1/§2.3): `doc` IS the snapshot, same
          // ProseMirror JSON shape `snapshotToHtml` renders either way —
          // see PostCardView.js's identical branch.
          var snapshot = payload &&
            (payload.format === 'prosemirror-doc-v1' ? payload.doc : payload.snapshot);
          if (!snapshot) {
            self._setSnapHtml('<p style="color:gray">(No snapshot available for this version)</p>');
            return;
          }
          var titleHtml = '';
          if (envelope.state && envelope.state.title) {
            titleHtml = '<h1 style="font-size:22px;margin:0 0 16px">' +
                        lively.identity.postCardUtils.escapeHtml(envelope.state.title) + '</h1>';
          }
          self._setSnapHtml(titleHtml + lively.identity.postCardUtils.snapshotToHtml(snapshot));
        };
        xhr.onerror = function () {
          self._loading = false;
          self._setSnapHtml('<p style="color:red">Network error loading version</p>');
        };
        xhr.send();
      },

    },

    // ─── navigation ──────────────────────────────────────────────────────────────

    'navigation', {

      // Only wiki pages open playback today (plain post cards dropped the
      // "History" entry point — PostcardDesignSpec-v2.md §15, they're
      // single-author/never live-synced so there's rarely anything to
      // scrub). this._objType is captured off the last version fetched
      // (envelope.type); default to 'wikipage' since that's the only
      // remaining caller (WikiEditor.js), but keep the branch generic in
      // case a plain-card entry point returns later.
      _exitPlayback: function () {
        this._stopPlay();
        var self = this;
        var isWiki = this._objType !== 'postcard';
        var editorModule = isWiki ? 'lively.identity.WikiEditor' : 'lively.identity.PostCardEditor';
        var viewModule = isWiki ? 'lively.identity.WikiView' : 'lively.identity.PostCardView';

        // this._handle is the page's owning handle (same assumption
        // WikiView.open callers make elsewhere) — only the owner should
        // land back in the editor; anyone else returns to the read-only view.
        var user = lively.identity.did.currentUser();
        var isOwner = !!(user && user.handle === this._handle);

        lively.require(isOwner ? editorModule : viewModule).toRun(function () {
          var Editor = lively.Class.forName(editorModule);
          if (isOwner) {
            var existing = null;
            // withAllSubmorphsDo, not world.submorphs — Editor.openCard opens
            // via editor.openInWindow(), so the editor instance is nested
            // inside a separately-created Window morph, not a direct world
            // child. Confirmed live: the shallow world.submorphs scan this
            // used to do never matched anything, so every "Live" click while
            // an editor was already open behind the playback panel opened a
            // second, duplicate editor window instead of resurfacing it.
            lively.morphic.World.current().withAllSubmorphsDo(function (m) {
              if (m instanceof Editor && m._handle === self._handle && m._objId === self._objId) {
                existing = m;
              }
            });
            if (existing) {
              existing.bringToFront();
            } else {
              Editor.openCard(self._handle, self._objId);
            }
          } else {
            lively.Class.forName(viewModule).open(self._handle, self._objId);
          }
        });
        this.remove();
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      _setSnapHtml: function (html) {
        if (!this._snapDiv) return;
        this._snapDiv.innerHTML = html;
        // BUG FIX: see PostCardView.js's _renderContentArea — same fix.
        lively.identity.postCardUtils.hydrateEmbeddedParts(this._snapDiv);
      },

      _setVersionInfo: function (text) {
        if (this._versionInfo) this._versionInfo.textString = text;
      },

    });

    Object.extend(lively.identity.WikiPlayback, {
      openPlayback: function (handle, objId, options) {
        var opts = options || {};
        var morph = new lively.identity.WikiPlayback(lively.rect(0, 0, 660, 500));
        morph._handle = handle;
        morph._objId = objId;
        if (opts.target) {
          opts.target.addMorph(morph);
        } else {
          morph.openInWorldCenter();
          morph.bringToFront();
        }
        morph._setup();
        return morph;
      },
    });

  }); // end module('lively.identity.WikiPlayback')
