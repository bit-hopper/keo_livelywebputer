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
  .requires('lively.identity.DID')
  .toRun(function () {

    lively.morphic.Box.subclass('lively.identity.PostCardPlayback',

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — state is set by openPlayback before _setup().

      _setup: function () {
        this._versions = [];
        this._currentIndex = 0;
        this._loading = false;
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

        // Slider — rendered as an <input type="range"> via HtmlWrapperMorph
        var sliderWrap = new lively.morphic.HtmlWrapperMorph(lively.pt(520, 28));
        sliderWrap.setPosition(lively.pt(12, 8));
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
        versionInfo.setPosition(lively.pt(540, 14));
        versionInfo.setExtent(lively.pt(110, 20));
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
          self._setSnapHtml(titleHtml + _snapshotToHtml(snapshot));
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
        // Attempt to find an existing PostCardEditor for this card and bring it forward.
        // If none exists, open a new editor.
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

    // ─── ProseMirror snapshot → HTML ─────────────────────────────────────────────
    // (local copy; mirrors PostCardFeed / IdentityServer._pmNodeToHtml)

    function _snapshotToHtml(snapshot) {
      if (!snapshot || !snapshot.content) return '';
      return snapshot.content.map(_pmNodeToHtml).join('');
    }

    function _pmNodeToHtml(node) {
      if (!node) return '';
      switch (node.type) {
        case 'paragraph':
          return '<p>' + _inlineContent(node.content) + '</p>';
        case 'heading': {
          var level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) ? node.attrs.level : 1));
          return '<h' + level + '>' + _inlineContent(node.content) + '</h' + level + '>';
        }
        case 'bullet_list':
          return '<ul>' + (node.content || []).map(_pmNodeToHtml).join('') + '</ul>';
        case 'ordered_list':
          return '<ol>' + (node.content || []).map(_pmNodeToHtml).join('') + '</ol>';
        case 'list_item':
          return '<li>' + (node.content || []).map(_pmNodeToHtml).join('') + '</li>';
        case 'blockquote':
          return '<blockquote>' + (node.content || []).map(_pmNodeToHtml).join('') + '</blockquote>';
        case 'code_block':
          return '<pre><code>' + _escapeHtml(_inlineContent(node.content)) + '</code></pre>';
        case 'hard_break':
          return '<br>';
        case 'math_inline':
          return '<code class="math-inline">' + _escapeHtml((node.attrs && node.attrs.value) || '') + '</code>';
        case 'math_display':
          return '<pre class="math-display">' + _escapeHtml((node.attrs && node.attrs.value) || '') + '</pre>';
        case 'embeddedPart': {
          var partId = (node.attrs && node.attrs.objId) ? node.attrs.objId : '(embedded)';
          return '<div class="embedded-part-placeholder" data-obj-id="' + _escapeAttr(partId) + '">[Embedded Part: ' + _escapeHtml(partId) + ']</div>';
        }
        default:
          if (node.content) return (node.content || []).map(_pmNodeToHtml).join('');
          return '';
      }
    }

    function _inlineContent(content) {
      if (!content) return '';
      return content.map(function (node) {
        if (node.type === 'text') {
          var text = _escapeHtml(node.text || '');
          (node.marks || []).forEach(function (mark) {
            switch (mark.type) {
              case 'bold':   text = '<strong>' + text + '</strong>'; break;
              case 'italic': text = '<em>' + text + '</em>'; break;
              case 'code':   text = '<code>' + text + '</code>'; break;
              case 'link': {
                var href = mark.attrs && mark.attrs.href ? _escapeAttr(mark.attrs.href) : '#';
                text = '<a href="' + href + '">' + text + '</a>';
                break;
              }
            }
          });
          return text;
        }
        return _pmNodeToHtml(node);
      }).join('');
    }

    function _escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function _escapeAttr(str) {
      return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

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
