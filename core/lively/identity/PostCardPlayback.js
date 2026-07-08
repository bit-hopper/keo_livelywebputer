/**
 * lively.identity.PostCardPlayback
 *
 * BuildSpec morph — read-only history playback mode for a post card.
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
 *   - "Live view" button returns the user to the live PostCardEditor state.
 *
 * Version API shapes:
 *   GET /@:handle/:objId/versions
 *   → { versions: [{cid, created, objId, seq}], count: N }
 *
 *   GET /@:handle/:objId/at/:cid
 *   → { envelope } (full signed envelope at that version)
 *
 * Entry point:
 *   lively.identity.PostCardPlayback.open(handle, objId, options)
 *
 * Dependencies:
 *   lively.identity.DID — baseUrl()
 */

module('lively.identity.PostCardPlayback')
  .requires('lively.identity.DID', 'lively.identity.PostCardUtils')
  .toRun(function () {

    lively.morphic.Box.subclass('lively.identity.PostCardPlayback',

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — state is set by openPlayback before _setup().

      _setup: function () {
        this._versions = [];
        this._currentIndex = 0;
        this._loading = false;
        this._playing = false;
        this._playTimer = null;
        this._playBtn = null;
        this._buildChrome();
        this._fetchVersions();
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

        // Slider — rendered as an <input type="range"> via HtmlWrapperMorph
        var sliderWrap = new lively.morphic.HtmlWrapperMorph(lively.pt(456, 28));
        sliderWrap.setPosition(lively.pt(52, 8));
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
        sliderWrap.rootElement.appendChild(sliderInput);
        timelinePanel.addMorph(sliderWrap);
        this._sliderInput = sliderInput;

        // Version info label (timestamp + seq)
        var versionInfo = lively.morphic.Text.makeLabel(
          'Loading versions…',
          { fontSize: 11, textColor: Color.gray }
        );
        versionInfo.setPosition(lively.pt(516, 14));
        versionInfo.setExtent(lively.pt(136, 20));
        versionInfo.setTextAlignment('right');
        timelinePanel.addMorph(versionInfo);
        this._versionInfo = versionInfo;

        // Snapshot viewer — a scrollable HTML area
        var snapViewer = new lively.morphic.HtmlWrapperMorph(lively.pt(660, 416));
        snapViewer.setPosition(lively.pt(0, 84));
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
        snapViewer.rootElement.appendChild(snapDiv);
        this.addMorph(snapViewer);
        this._snapViewer = snapViewer;
        this._snapDiv = snapDiv;
      },

    },

    // ─── version loading ─────────────────────────────────────────────────────────

    'versions', {

      _fetchVersions: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) +
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
            self._setSnapHtml('<p style="color:red">JSON parse error: ' + _escapeHtml(e.message) + '</p>');
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
        var url = base + '/' + encodeURIComponent(this._handle) +
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
            self._setSnapHtml('<p style="color:red">Parse error: ' + _escapeHtml(e.message) + '</p>');
            return;
          }
          var envelope = data.envelope || data;
          var snapshot = envelope.record && envelope.record.payload && envelope.record.payload.snapshot;
          if (!snapshot) {
            self._setSnapHtml('<p style="color:gray">(No snapshot available for this version)</p>');
            return;
          }
          var titleHtml = '';
          if (envelope.state && envelope.state.title) {
            titleHtml = '<h1 style="font-size:22px;margin:0 0 16px">' +
                        _escapeHtml(envelope.state.title) + '</h1>';
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

      _exitPlayback: function () {
        this._stopPlay();
        var self = this;
        var existing = null;
        (lively.morphic.World.current().submorphs || []).forEach(function (m) {
          if (m instanceof lively.identity.PostCardEditor &&
              m._handle === self._handle && m._objId === self._objId) {
            existing = m;
          }
        });
        if (existing) {
          existing.bringToFront();
        } else {
          lively.identity.PostCardEditor.openCard(this._handle, this._objId);
        }
        this.remove();
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      _setSnapHtml: function (html) {
        if (this._snapDiv) this._snapDiv.innerHTML = html;
      },

      _setVersionInfo: function (text) {
        if (this._versionInfo) this._versionInfo.textString = text;
      },

    });

    Object.extend(lively.identity.PostCardPlayback, {
      openPlayback: function (handle, objId, options) {
        var opts = options || {};
        var morph = new lively.identity.PostCardPlayback(lively.rect(0, 0, 660, 500));
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

  }); // end module('lively.identity.PostCardPlayback')
