/**
 * lively.identity.PostCardFeed
 *
 * BuildSpec morph — a scrollable, cursor-paginated list of post cards for a
 * given @handle. Renders card rows with title + excerpt; supports "flip"
 * interaction to preview the ProseMirror snapshot in-place without navigation.
 *
 * Entry point:
 *   lively.identity.PostCardFeed.open('@handle')  — opens in a new window
 *   lively.identity.PostCardFeed.open('@handle', { target: aMorph }) — embeds
 *
 * Feed shape from server (§7.1):
 *   GET /@:handle/postcards?after=<cursor>&limit=<n>
 *   → { postcards: [{objId, did, state:{title}, record:{cid}, created, constellation, replyTo}],
 *       cursor: <lastObjId | null> }
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.DID — baseUrl(), currentUser()
 */

module('lively.identity.PostCardFeed')
  .requires('lively.identity.DID', 'lively.identity.PostCardUtils')
  .toRun(function () {

    lively.morphic.Box.subclass('lively.identity.PostCardFeed',

    // ─── initialization ──────────────────────────────────────────────────────────

    'initialization', {

      // No initialize override — state is initialised in _start() after openInWorld.

      // Called by openFeed after the morph is in the world.
      _start: function () {
        this._cursor = null;
        this._handle = this.handle || '';
        this._cards = [];
        this._loading = false;
        this._flipObjId = null;
        this._buildLayout();
        this._fetchPage();
      },

      _buildLayout: function () {
        var self = this;
        this.setFill(Color.white);
        var sn = this.renderContext().shapeNode;
        sn.style.borderRadius = '8px';
        sn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.18)';

        // Header bar
        var header = lively.morphic.Text.makeLabel(
          this._handle || 'Feed',
          { fontSize: 16, fontWeight: 'bold' }
        );
        header.setExtent(lively.pt(480, 28));
        header.setPosition(lively.pt(20, 16));
        this.addMorph(header);
        this._headerLabel = header;

        // Scrollable list container — plain Box with overflow:auto via DOM
        var scroll = new lively.morphic.Box(lively.rect(0, 52, 520, 540));
        scroll.setFill(Color.transparent);
        this.addMorph(scroll);
        scroll.renderContext().shapeNode.style.overflowY = 'auto';
        this._scrollContainer = scroll;

        // "Load more" button — hidden until a next cursor exists
        var loadMore = new lively.morphic.Button(lively.rect(200, 598, 120, 30));
        loadMore.setLabel('Load more');
        loadMore.setVisible(false);
        loadMore.onMouseDown = function () { self._fetchPage(); };
        this.addMorph(loadMore);
        this._loadMoreBtn = loadMore;

        // Loading spinner label
        var spinner = lively.morphic.Text.makeLabel('Loading…');
        spinner.setPosition(lively.pt(200, 598));
        spinner.setVisible(false);
        this.addMorph(spinner);
        this._spinnerLabel = spinner;
      },

    },

    // ─── data loading ────────────────────────────────────────────────────────────

    'loading', {

      setHandle: function (handle) {
        this._handle = handle;
        this._headerLabel.textString = handle;
        this._cursor = null;
        this._cards = [];
        this._flipObjId = null;
        this._clearRows();
        this._fetchPage();
      },

      _fetchPage: function () {
        if (this._loading) return;
        this._loading = true;
        this._loadMoreBtn.setVisible(false);
        this._spinnerLabel.setVisible(true);

        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) + '/postcards?limit=20';
        if (this._cursor) url += '&after=' + encodeURIComponent(this._cursor);

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          self._loading = false;
          self._spinnerLabel.setVisible(false);
          if (xhr.status !== 200) {
            console.error('[PostCardFeed] fetch failed:', xhr.status, xhr.responseText);
            return;
          }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) {
            console.error('[PostCardFeed] JSON parse error:', e.message);
            return;
          }
          self._onPageLoaded(data);
        };
        xhr.onerror = function () {
          self._loading = false;
          self._spinnerLabel.setVisible(false);
          console.error('[PostCardFeed] network error fetching feed for', self._handle);
        };
        xhr.send();
      },

      _onPageLoaded: function (data) {
        var newCards = data.postcards || [];
        newCards.forEach(function (card) {
          this._cards.push(card);
          this._appendRow(card);
        }, this);

        this._cursor = data.cursor || null;
        if (this._cursor) {
          this._loadMoreBtn.setVisible(true);
        }
      },

    },

    // ─── row rendering ───────────────────────────────────────────────────────────

    'rendering', {

      _clearRows: function () {
        var container = this._scrollContainer;
        (container.submorphs || []).slice().forEach(function (m) { m.remove(); });
      },

      _appendRow: function (card) {
        var self = this;
        var container = this._scrollContainer;
        var existingRows = (container.submorphs || []).length;
        var y = existingRows * 72;

        var row = new lively.morphic.Box(lively.rect(0, y, 500, 68));
        row.setFill(Color.rgb(248, 248, 250));
        row.renderContext().shapeNode.style.borderRadius = '6px';
        row._cardMeta = card;

        // Title
        var title = card.state && card.state.title ? card.state.title : '(untitled)';
        var titleLabel = lively.morphic.Text.makeLabel(title, { fontSize: 13, fontWeight: 'bold' });
        titleLabel.setExtent(lively.pt(380, 20));
        titleLabel.setPosition(lively.pt(10, 8));
        row.addMorph(titleLabel);

        // Excerpt / timestamp
        var ts = card.created ? new Date(card.created).toLocaleDateString() : '';
        var constellation = card.constellation ? ' · ' + card.constellation : '';
        var excerpt = lively.morphic.Text.makeLabel(ts + constellation, { fontSize: 11, textColor: Color.gray });
        excerpt.setExtent(lively.pt(380, 18));
        excerpt.setPosition(lively.pt(10, 32));
        row.addMorph(excerpt);

        // Flip / read button
        var flipBtn = new lively.morphic.Button(lively.rect(428, 22, 60, 24));
        flipBtn.setLabel('Preview');
        flipBtn.onMouseDown = function () { self._flipRow(row, card); };
        row.addMorph(flipBtn);

        // Open-full button
        var openBtn = new lively.morphic.Button(lively.rect(364, 22, 50, 24));
        openBtn.setLabel('Open');
        openBtn.onMouseDown = function () { self._openCard(card); };
        row.addMorph(openBtn);

        container.addMorph(row);
        row._titleLabel = titleLabel;
        row._excerptLabel = excerpt;
        row._flipped = false;
      },

    },

    // ─── flip interaction ─────────────────────────────────────────────────────────

    'flip', {

      // "Flip" a row to show the ProseMirror snapshot HTML preview in-place.
      // Flipping a second card collapses the currently-flipped one first.
      _flipRow: function (row, card) {
        var self = this;

        // Collapse previously flipped row
        if (this._flipObjId && this._flipObjId !== card.objId) {
          this._collapseAllRows();
        }

        if (row._flipped) {
          this._collapseRow(row);
          return;
        }

        // Expand this row to show a preview
        row._flipped = true;
        this._flipObjId = card.objId;
        var previewHeight = 200;
        var originalExtent = row.getExtent();
        row.setExtent(lively.pt(originalExtent.x, originalExtent.y + previewHeight));

        // Show spinner while fetching envelope
        var loadingLabel = lively.morphic.Text.makeLabel('Loading preview…', { fontSize: 11, textColor: Color.gray });
        loadingLabel.setPosition(lively.pt(10, 76));
        row.addMorph(loadingLabel);
        row._previewLoadingLabel = loadingLabel;

        self._fetchEnvelopeSnapshot(card, function (err, snapshotHtml) {
          if (row._previewLoadingLabel) { row._previewLoadingLabel.remove(); row._previewLoadingLabel = null; }
          if (err || !snapshotHtml) {
            var errLabel = lively.morphic.Text.makeLabel('(preview unavailable)', { fontSize: 11, textColor: Color.gray });
            errLabel.setPosition(lively.pt(10, 76));
            row.addMorph(errLabel);
            row._previewErrorLabel = errLabel;
            return;
          }
          var htmlMorph = new lively.morphic.HtmlWrapperMorph(lively.pt(480, previewHeight - 8));
          htmlMorph.setPosition(lively.pt(10, 76));
          htmlMorph.setHTML(snapshotHtml);
          row.addMorph(htmlMorph);
          row._previewMorph = htmlMorph;
        });

        // Shift subsequent rows down
        this._reLayoutRows();
      },

      _collapseRow: function (row) {
        row._flipped = false;
        if (row._previewMorph) { row._previewMorph.remove(); row._previewMorph = null; }
        if (row._previewErrorLabel) { row._previewErrorLabel.remove(); row._previewErrorLabel = null; }
        if (row._previewLoadingLabel) { row._previewLoadingLabel.remove(); row._previewLoadingLabel = null; }
        row.setExtent(lively.pt(row.getExtent().x, 68));
        this._flipObjId = null;
        this._reLayoutRows();
      },

      _collapseAllRows: function () {
        var container = this._scrollContainer;
        (container.submorphs || []).forEach(function (row) {
          if (row._flipped) this._collapseRow(row);
        }, this);
      },

      // Re-stack rows vertically after a flip expand/collapse.
      _reLayoutRows: function () {
        var container = this._scrollContainer;
        var y = 0;
        (container.submorphs || []).forEach(function (row) {
          row.setPosition(lively.pt(0, y));
          y += row.getExtent().y + 4; // 4px gap
        });
        // Update scroll container content height
        if (container.setContentHeight) container.setContentHeight(y);
      },

      // Fetch the envelope from the server and build a snippet of HTML from
      // payload.snapshot (the ProseMirror JSON). Falls back to the snapshot
      // HTML already served by the identity server's /html route.
      _fetchEnvelopeSnapshot: function (card, callback) {
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(card.objId);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        // Accept JSON to get the raw envelope; we'll render snapshot ourselves.
        // The server returns 'postcard' type envelopes as JSON when Accept=application/json.
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return callback(new Error('fetch failed: ' + xhr.status));
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return callback(e); }
          var snapshot = envelope.record && envelope.record.payload && envelope.record.payload.snapshot;
          if (!snapshot) return callback(null, '(no preview)');
          callback(null, lively.identity.postCardUtils.snapshotToHtml(snapshot));
        };
        xhr.onerror = function () { callback(new Error('network error')); };
        xhr.send();
      },

    },

    // ─── navigation ──────────────────────────────────────────────────────────────

    'navigation', {

      _openCard: function (card) {
        // Delegate to PostCardEditor / reader (Phase 5b/c).
        // For now, open the server-rendered HTML page in a new window morph.
        var base = lively.identity.did.baseUrl();
        var url = base + '/' + encodeURIComponent(this._handle) + '/' + encodeURIComponent(card.objId);
        if (typeof lively.ide !== 'undefined' && lively.ide.openBrowser) {
          lively.ide.openBrowser(url);
        } else {
          window.open(url, '_blank');
        }
      },

    });

    Object.extend(lively.identity.PostCardFeed, {
      openFeed: function (handle, options) {
        var opts = options || {};
        var feed = new lively.identity.PostCardFeed(lively.rect(0, 0, 520, 640));
        feed.handle = handle;
        if (opts.target) {
          opts.target.addMorph(feed);
        } else {
          feed.openInWorldCenter();
          feed.bringToFront();
        }
        feed._start();
        return feed;
      },
    });

    // Singleton
    lively.identity.postCardFeed = lively.identity.PostCardFeed;

  }); // end module('lively.identity.PostCardFeed')
