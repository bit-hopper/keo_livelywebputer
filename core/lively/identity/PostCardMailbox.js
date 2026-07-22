/**
 * lively.identity.PostCardMailbox
 *
 * Tabbed morph showing the views of the user's postcard mailbox:
 *
 *   Received     — cards delivered to your inbox (GET /@:handle/inbox)
 *   Delivered    — cards you sent that were accepted (GET /@:handle/deliveries?status=delivered)
 *   Returned     — cards that got the postal rejection  (GET /@:handle/deliveries?status=returned)
 *   Blocked      — manage your block list (GET/PUT /@:handle/settings)
 *   My Postcards — your own authored drafts/standalone/constellation posts
 *                  (GET /@:handle/postcards) — the one tab whose rows are
 *                  cards *you wrote*, as opposed to references to a
 *                  delivery event. Each row has a ⋯ menu (currently just
 *                  Delete, §6.3's tombstone path — author-only, since this
 *                  codebase has no wiki-mode postcards yet).
 *   Aliases      — manage forwarding addresses (GET/POST /@:handle/aliases,
 *                  DELETE /@:handle/aliases/:alias) — rotatable, randomly
 *                  generated handles that resolve to the same DID as your
 *                  primary handle, independently revocable (§3.2).
 *
 * Entry point:
 *   lively.identity.PostCardMailbox.open(tab)
 *     tab: 'received' | 'delivered' | 'returned' | 'blocked' | 'own' | 'aliases'  (defaults to 'received')
 */

module('lively.identity.PostCardMailbox')
  .requires(
    'lively.identity.DID',
    'lively.identity.PostCardView',
  )
  .toRun(function () {

    var MailboxClass = lively.morphic.Box.subclass('lively.identity.PostCardMailbox',

    'serialization', {
      doNotSerialize: [
        '_contentDiv', '_tabBtns', '_openMenuEl', '_openMenuAnchor', '_menuCloseHandler',
        '_searchBar', '_searchInput', '_contentLoadStarted',
      ],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._activeTab = 'received';
        this._contentDiv = null;
        this._tabBtns    = {};
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        this._menuCloseHandler = null;
        this._searchQuery = '';
        this._buildChrome();
        // Guards prepareForNewRenderContext below against redundantly
        // re-running _switchTab once this constructor returns and
        // open() attaches the new instance to the world — see that
        // method's own comment for the mechanism.
        this._contentLoadStarted = true;
        this._switchTab('received');
      },

      // $super(bounds) above (Morph.initialize) is what calls
      // prepareForNewRenderContext the first time, before _activeTab exists
      // yet — the guard there skips that call, leaving this constructor's
      // own _buildChrome()/_switchTab() as the only build on fresh
      // construction. On a world-reload restore, _activeTab already has its
      // serialized value (survives fine, it's a plain string) but none of
      // the DOM _buildChrome built does, so it re-runs here instead.
      //
      // It ALSO fires as an *immediate* same-turn duplicate of the
      // constructor's own explicit _buildChrome()/_switchTab() call above:
      // PostCardMailbox.open() attaches this freshly-constructed morph to
      // the world right after construction (openInWorldCenter ->
      // openInWorld -> world.addMorph -> Core.js's addMorph ->
      // renderAfterUsing/replaceRenderContextWith -> this method), and by
      // then _activeTab is already set, so the guard above doesn't skip
      // it — same mechanism as the identical fix in PostCardEditor.js/
      // PostCardView.js. _buildChrome() still runs every time (cheap,
      // idempotent, and needed for the genuine restore case); only the
      // _switchTab (network fetch + render) is guarded, via
      // _contentLoadStarted — doNotSerialize'd so a genuine future
      // restore still starts falsy and loads normally.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._activeTab) return;
        var tab = this._activeTab;
        this._tabBtns = {};
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        this._menuCloseHandler = null;
        this._buildChrome();
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        this._switchTab(tab);
      },

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ''; // idempotent: safe if this ever runs twice on one instance
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow    = '0 4px 16px rgba(0,0,0,0.18)';

        // ── title bar ──
        var titleBar = document.createElement('div');
        titleBar.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:36px',
          'background:#2c2c2e', 'border-radius:8px 8px 0 0',
          'display:flex', 'align-items:center', 'padding:0 12px',
          'box-sizing:border-box',
        ].join(';');
        var titleText = document.createElement('span');
        titleText.textContent = 'Mailbox';
        titleText.style.cssText = 'color:#fff;font-size:13px;font-weight:600;font-family:sans-serif;';
        titleBar.appendChild(titleText);
        shapeNode.appendChild(titleBar);

        // ── tab bar ──
        var tabBar = document.createElement('div');
        tabBar.style.cssText = [
          'position:absolute', 'top:36px', 'left:0', 'right:0', 'height:36px',
          'background:#f2f2f7', 'border-bottom:1px solid #d1d1d6',
          'display:flex', 'align-items:stretch', 'box-sizing:border-box',
        ].join(';');

        var tabs = [
          { id: 'received',  label: 'Received'  },
          { id: 'delivered', label: 'Delivered' },
          { id: 'returned',  label: 'Returned'  },
          { id: 'blocked',   label: 'Blocked'   },
          { id: 'own',       label: 'My Postcards' },
          { id: 'aliases',   label: 'Aliases' },
        ];
        tabs.forEach(function (t) {
          var btn = document.createElement('button');
          btn.textContent = t.label;
          btn.style.cssText = [
            'flex:1', 'border:none', 'background:transparent',
            'font-size:12px', 'font-family:sans-serif', 'cursor:pointer',
            'border-bottom:2px solid transparent', 'transition:all 0.15s',
            'color:#636366',
          ].join(';');
          btn.addEventListener('click', function () { self._switchTab(t.id); });
          tabBar.appendChild(btn);
          self._tabBtns[t.id] = btn;
        });
        shapeNode.appendChild(tabBar);

        // ── search bar (§8.1) — title-only metadata search, shown only for
        // tabs whose rows are actual postcards (Received/Delivered/
        // Returned/My Postcards); hidden for Blocked/Aliases, which have
        // no title to search. Lives outside _contentDiv deliberately —
        // every render function clears _contentDiv wholesale, which would
        // otherwise wipe this input (and drop focus/keystrokes) on every
        // reload a search itself triggers.
        var searchBar = document.createElement('div');
        searchBar.style.cssText = [
          'position:absolute', 'top:72px', 'left:0', 'right:0', 'height:32px',
          'background:#fff', 'border-bottom:1px solid #e5e5ea',
          'display:none', 'align-items:center', 'padding:0 12px', 'box-sizing:border-box',
        ].join(';');
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search by title…';
        searchInput.style.cssText = 'flex:1;font-size:12px;padding:5px 8px;border:1px solid #d1d1d6;border-radius:4px;box-sizing:border-box;';
        var searchDebounce = null;
        searchInput.addEventListener('input', function () {
          clearTimeout(searchDebounce);
          searchDebounce = setTimeout(function () {
            self._searchQuery = searchInput.value.trim();
            self._reloadCurrentTab();
          }, 300);
        });
        searchBar.appendChild(searchInput);
        shapeNode.appendChild(searchBar);
        this._searchBar = searchBar;
        this._searchInput = searchInput;

        // ── content area ──
        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:104px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:12px 16px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:13px',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
      },

      _switchTab: function (tab) {
        var self = this;
        this._activeTab = tab;
        this._closePostcardMenu();

        // Update tab button styles
        Object.keys(this._tabBtns).forEach(function (id) {
          var btn = self._tabBtns[id];
          var active = id === tab;
          btn.style.color           = active ? '#007aff' : '#636366';
          btn.style.borderBottom    = active ? '2px solid #007aff' : '2px solid transparent';
          btn.style.fontWeight      = active ? '600' : '400';
          btn.style.background      = active ? '#fff' : 'transparent';
        });

        // Each tab starts with a fresh (empty) search — a query typed into
        // one tab carrying silently into an unrelated one would be more
        // confusing than having to retype it.
        this._searchQuery = '';
        if (this._searchInput) this._searchInput.value = '';
        var searchable = tab === 'received' || tab === 'delivered' || tab === 'returned' || tab === 'own';
        if (this._searchBar) this._searchBar.style.display = searchable ? 'flex' : 'none';

        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';

        if (tab === 'received')  this._loadReceived();
        if (tab === 'delivered') this._loadDeliveries('delivered');
        if (tab === 'returned')  this._loadDeliveries('returned');
        if (tab === 'blocked')   this._loadBlocked();
        if (tab === 'own')       this._loadOwn();
        if (tab === 'aliases')   this._loadAliases();
      },

      // Re-runs whichever load function backs the active tab — used by the
      // search box (§8.1) after this._searchQuery changes, so it doesn't
      // need its own copy of the tab -> loader mapping.
      _reloadCurrentTab: function () {
        if (this._activeTab === 'received')  this._loadReceived();
        if (this._activeTab === 'delivered') this._loadDeliveries('delivered');
        if (this._activeTab === 'returned')  this._loadDeliveries('returned');
        if (this._activeTab === 'own')       this._loadOwn();
      },

      // ── data fetching ─────────────────────────────────────────────────────

      // '' when unset, else '&q=<encoded>' — appended to every searchable
      // tab's list URL (§8.1).
      _qParam: function () {
        return this._searchQuery ? '&q=' + encodeURIComponent(this._searchQuery) : '';
      },

      _loadReceived: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/inbox?limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load inbox (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderReceivedRecords(result.records || []);
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      _loadDeliveries: function (status) {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/deliveries?status=' + status + '&limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load deliveries (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderDeliveryRecords(result.records || [], status);
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      // The one tab whose rows are cards the current user actually
      // authored (drafts, standalone posts, constellation-feed posts) —
      // Received/Delivered/Returned are all references to delivery events,
      // not this. §6.3's Delete lives here for exactly that reason.
      _loadOwn: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/postcards?limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load your postcards (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderOwnRecords(result.postcards || []);
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      _loadBlocked: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/settings');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load settings (' + xhr.status + ')');
          var env;
          try { env = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._settingsEnvelope = env;
          self._renderBlockedList((env.state && env.state.blockedHandles) || []);
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      _loadAliases: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/aliases');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not load aliases (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderAliasesList(result.aliases || []);
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send();
      },

      // ── rendering ─────────────────────────────────────────────────────────

      _renderReceivedRecords: function (records) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!records.length) {
          content.innerHTML = '<div style="color:#999;padding:20px 0;text-align:center;">No received postcards yet.</div>';
          return;
        }

        records.forEach(function (rec) {
          var card = self._makeCard();

          var from = self._makeIdentityRow('From: ', rec.senderHandle, rec.senderDid);

          var id = document.createElement('div');
          id.style.cssText  = 'color:#636366;font-size:11px;margin-bottom:3px;';
          id.textContent    = 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:#8e8e93;font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          card.appendChild(from);
          card.appendChild(id);
          card.appendChild(when);

          var buttons = [];
          buttons.push(self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🗑 Delete', danger: true, onClick: function () {
                self._hideFromMailbox(rec.objId, function () { self._loadReceived(); });
              } },
            ]);
          }));
          // /@:handle/... routes resolve handles, not DIDs — without a
          // senderHandle there is no working link to open, so omit the
          // Open button rather than ship a 404 (audit F4); Delete has no
          // such dependency, so it's always offered.
          if (rec.senderHandle) {
            buttons.push(self._makeInlineOpenBtn(function () {
              // In-world, same as the Delivered tab's Open button — not
              // window.open() to the standalone page, which has no working
              // live-render path (audit F2, deliberately not fixed; see
              // postcard_audit.md). PostCardView shows an Edit button of its
              // own when the viewer turns out to be the card's owner.
              lively.identity.PostCardView.open(rec.senderHandle, rec.objId);
            }));
          }
          card.appendChild(self._makeActionsCluster(buttons));
          content.appendChild(card);
        });
      },

      _renderDeliveryRecords: function (records, status) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var emptyMsg = status === 'returned'
          ? 'No returned postcards.'
          : 'No delivered postcards yet.';

        if (!records.length) {
          content.innerHTML = '<div style="color:#999;padding:20px 0;text-align:center;">' + emptyMsg + '</div>';
          return;
        }

        records.forEach(function (rec) {
          var card = self._makeCard();

          if (rec.status === 'returned') {
            var badge = document.createElement('span');
            badge.style.cssText = [
              'display:inline-block', 'background:#ff3b30', 'color:#fff',
              'font-size:10px', 'font-weight:600', 'border-radius:3px',
              'padding:1px 5px', 'margin-bottom:6px',
            ].join(';');
            badge.textContent = '✉ Returned';
            card.appendChild(badge);
          }

          var to = self._makeIdentityRow('To: ', rec.recipientHandle, null);

          var id = document.createElement('div');
          id.style.cssText  = 'color:#636366;font-size:11px;margin-bottom:3px;';
          id.textContent    = 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:#8e8e93;font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          var openBtn = self._makeInlineOpenBtn(function () {
            var user = lively.identity.did.currentUser();
            // _handle is bare (no '@') — PostCardView prepends '/@' itself
            // when building its GET URL.
            lively.identity.PostCardView.open(user.handle, rec.objId);
          });
          var menuBtn = self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🗑 Delete', danger: true, onClick: function () {
                self._hideFromMailbox(rec.objId, function () { self._loadDeliveries(status); });
              } },
            ]);
          });

          card.appendChild(to);
          card.appendChild(id);
          card.appendChild(when);
          card.appendChild(self._makeActionsCluster([menuBtn, openBtn]));
          content.appendChild(card);
        });
      },

      _renderBlockedList: function (blockedHandles) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';

        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'handle to block (no @)';
        input.style.cssText = 'flex:1;font-size:12px;padding:6px 8px;border:1px solid #d1d1d6;border-radius:4px;box-sizing:border-box;';
        addRow.appendChild(input);

        var addBtn = document.createElement('button');
        addBtn.textContent = 'Block';
        addBtn.style.cssText = 'font-size:12px;padding:6px 12px;cursor:pointer;border:1px solid #ff3b30;color:#ff3b30;background:#fff;border-radius:4px;';
        function submitBlock() {
          var h = input.value.trim().replace(/^@/, '');
          if (!h) return;
          addBtn.disabled = true;
          self._blockHandle(h, function (err) {
            addBtn.disabled = false;
            if (err) return self._showError(err.message || 'Failed to block');
            input.value = '';
            self._loadBlocked();
          });
        }
        addBtn.addEventListener('click', submitBlock);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitBlock(); });
        addRow.appendChild(addBtn);
        content.appendChild(addRow);

        if (!blockedHandles.length) {
          var empty = document.createElement('div');
          empty.style.cssText = 'color:#999;padding:20px 0;text-align:center;';
          empty.textContent = 'No blocked handles.';
          content.appendChild(empty);
          return;
        }

        blockedHandles.forEach(function (h) {
          var card = self._makeCard();

          card.appendChild(self._makeIdentityRow('', h, null));

          var removeBtn = document.createElement('button');
          removeBtn.textContent = 'Unblock';
          removeBtn.style.cssText = [
            'position:absolute', 'top:10px', 'right:10px',
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #ff3b30', 'color:#ff3b30',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          removeBtn.addEventListener('click', function () {
            removeBtn.disabled = true;
            self._unblockHandle(h, function (err) {
              removeBtn.disabled = false;
              if (err) return self._showError(err.message || 'Failed to unblock');
              self._loadBlocked();
            });
          });
          card.appendChild(removeBtn);
          content.appendChild(card);
        });
      },

      // Forwarding aliases (§3.2) — a rotatable, randomly generated handle
      // is server-generated on demand (no text input like Block's, since
      // aliases are never user-chosen), listed with Copy + Revoke.
      _renderAliasesList: function (aliases) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var intro = document.createElement('div');
        intro.style.cssText = 'color:#8e8e93;font-size:11px;margin-bottom:10px;line-height:1.4;';
        intro.textContent = 'Give out an alias instead of your primary handle to reduce spam exposure. ' +
          'Mail sent to any alias lands in your normal inbox. Revoke one at any time without affecting the others.';
        content.appendChild(intro);

        var addRow = document.createElement('div');
        addRow.style.cssText = 'margin-bottom:12px;';
        var genBtn = document.createElement('button');
        genBtn.textContent = 'Generate new alias';
        genBtn.style.cssText = 'font-size:12px;padding:6px 12px;cursor:pointer;border:1px solid #007aff;color:#007aff;background:#fff;border-radius:4px;';
        genBtn.addEventListener('click', function () {
          genBtn.disabled = true;
          self._generateAlias(function (err) {
            genBtn.disabled = false;
            if (err) return self._showError(err.message || 'Failed to generate alias');
            self._loadAliases();
          });
        });
        addRow.appendChild(genBtn);
        content.appendChild(addRow);

        if (!aliases.length) {
          var empty = document.createElement('div');
          empty.style.cssText = 'color:#999;padding:20px 0;text-align:center;';
          empty.textContent = 'No active aliases.';
          content.appendChild(empty);
          return;
        }

        aliases.forEach(function (a) {
          var card = self._makeCard();

          var label = document.createElement('div');
          label.style.cssText = 'font-weight:600;color:#1c1c1e;font-family:monospace;margin-bottom:3px;padding-right:120px;';
          label.textContent = '@' + a.handle;
          card.appendChild(label);

          var when = document.createElement('div');
          when.style.cssText = 'color:#8e8e93;font-size:11px;';
          when.textContent = 'Created ' + self._formatDate(a.created_at);
          card.appendChild(when);

          var copyBtn = document.createElement('button');
          copyBtn.textContent = 'Copy';
          copyBtn.style.cssText = [
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #007aff', 'color:#007aff',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          copyBtn.addEventListener('click', function () {
            self._copyToClipboard('@' + a.handle, copyBtn);
          });

          var revokeBtn = document.createElement('button');
          revokeBtn.textContent = 'Revoke';
          revokeBtn.style.cssText = [
            'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
            'border:1px solid #ff3b30', 'color:#ff3b30',
            'background:#fff', 'border-radius:4px',
          ].join(';');
          revokeBtn.addEventListener('click', function () {
            self.world().confirm(
              'Revoke @' + a.handle + '? Anyone still using it will get the same "not deliverable" ' +
              'response as an unknown handle — this can\'t be undone.',
              function (answer) {
                if (!answer) return;
                revokeBtn.disabled = true;
                self._revokeAliasHandle(a.handle, function (err) {
                  revokeBtn.disabled = false;
                  if (err) return self._showError(err.message || 'Failed to revoke alias');
                  self._loadAliases();
                });
              }
            );
          });

          card.appendChild(self._makeActionsCluster([copyBtn, revokeBtn]));
          content.appendChild(card);
        });
      },

      _renderOwnRecords: function (postcards) {
        var self    = this;
        var content = this._contentDiv;
        var handle  = lively.identity.did.currentUser().handle;
        content.innerHTML = '';

        if (!postcards.length) {
          content.innerHTML = '<div style="color:#999;padding:20px 0;text-align:center;">No postcards yet.</div>';
          return;
        }

        postcards.forEach(function (pc) {
          var card = self._makeCard();

          var title = document.createElement('div');
          title.style.cssText = 'font-weight:600;color:#1c1c1e;margin-bottom:3px;padding-right:76px;';
          title.textContent   = (pc.state && pc.state.title) || '(untitled)';

          var meta = document.createElement('div');
          meta.style.cssText = 'color:#8e8e93;font-size:11px;';
          meta.textContent   = (pc.visibility || 'public') + ' · ' + self._formatDate(pc.created);

          card.appendChild(title);
          card.appendChild(meta);

          var menuBtn = self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🗑 Delete', danger: true, onClick: function () { self._deletePostcard(handle, pc); } },
            ]);
          });
          var openBtn = self._makeInlineOpenBtn(function () {
            lively.identity.PostCardView.open(handle, pc.objId);
          });

          card.appendChild(self._makeActionsCluster([menuBtn, openBtn]));
          content.appendChild(card);
        });
      },

      // ── shared row-action helpers ────────────────────────────────────────

      // A single top-right [⋯][Open]-shaped cluster — every row in this
      // file has more than one action now, hence a shared flex wrapper
      // rather than a single self-positioning button.
      _makeActionsCluster: function (buttons) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:absolute;top:10px;right:10px;display:flex;gap:6px;align-items:center;';
        buttons.forEach(function (b) { wrap.appendChild(b); });
        return wrap;
      },

      _makeMenuBtn: function (onClick) {
        var btn = document.createElement('button');
        btn.textContent = '⋯';
        btn.title = 'More actions';
        btn.style.cssText = [
          'font-size:13px', 'width:24px', 'height:24px', 'line-height:1', 'padding:0',
          'cursor:pointer', 'border:1px solid #d1d1d6', 'color:#3a3a3c',
          'background:#fff', 'border-radius:4px',
        ].join(';');
        btn.addEventListener('click', function (e) { e.stopPropagation(); onClick(btn); });
        return btn;
      },

      // "Open" styled to sit inside _makeActionsCluster's flex row (no
      // self-positioning, unlike a standalone action button would need).
      _makeInlineOpenBtn: function (onClick) {
        var btn = document.createElement('button');
        btn.textContent = 'Open';
        btn.style.cssText = [
          'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
          'border:1px solid #007aff', 'color:#007aff',
          'background:#fff', 'border-radius:4px',
        ].join(';');
        btn.addEventListener('click', onClick);
        return btn;
      },

      // ── ⋯ menu — items: [{ label, danger, onClick }] ────────────────────────

      _toggleRowMenu: function (anchorBtn, items) {
        var self = this;
        var reopening = this._openMenuAnchor === anchorBtn;
        this._closePostcardMenu();
        if (reopening) return; // second click on the same ⋯ just closes it

        var menu = document.createElement('div');
        menu.style.cssText = [
          'position:absolute', 'z-index:20',
          'background:#fff', 'border:1px solid #d1d1d6', 'border-radius:6px',
          'box-shadow:0 4px 12px rgba(0,0,0,0.15)', 'padding:4px', 'min-width:110px',
        ].join(';');

        // Positioned relative to _contentDiv (its nearest positioned
        // ancestor) using getBoundingClientRect math, accounting for
        // its current scroll offset, so the menu tracks the row it
        // belongs to rather than a fixed spot.
        var anchorRect  = anchorBtn.getBoundingClientRect();
        var contentRect = this._contentDiv.getBoundingClientRect();
        menu.style.top   = (anchorRect.bottom - contentRect.top + this._contentDiv.scrollTop + 4) + 'px';
        menu.style.right = (contentRect.right - anchorRect.right) + 'px';

        items.forEach(function (item) {
          var itemBtn = document.createElement('button');
          itemBtn.textContent = item.label;
          itemBtn.style.cssText = [
            'display:block', 'width:100%', 'text-align:left',
            'font-size:12px', 'padding:6px 10px', 'cursor:pointer',
            'border:none', 'background:none', 'border-radius:4px',
            'color:' + (item.danger ? '#ff3b30' : '#1c1c1e'),
          ].join(';');
          var hoverBg = item.danger ? '#fbe9e7' : '#f2f2f7';
          itemBtn.addEventListener('mouseenter', function () { itemBtn.style.background = hoverBg; });
          itemBtn.addEventListener('mouseleave', function () { itemBtn.style.background = 'none'; });
          itemBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            self._closePostcardMenu();
            item.onClick();
          });
          menu.appendChild(itemBtn);
        });

        this._contentDiv.appendChild(menu);
        this._openMenuEl = menu;
        this._openMenuAnchor = anchorBtn;

        // Deferred to the next tick so the same click that opened the menu
        // (bubbling to document) doesn't immediately close it.
        setTimeout(function () {
          self._menuCloseHandler = function () { self._closePostcardMenu(); };
          document.addEventListener('click', self._menuCloseHandler);
        }, 0);
      },

      _closePostcardMenu: function () {
        if (this._openMenuEl && this._openMenuEl.parentNode) {
          this._openMenuEl.parentNode.removeChild(this._openMenuEl);
        }
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        if (this._menuCloseHandler) {
          document.removeEventListener('click', this._menuCloseHandler);
          this._menuCloseHandler = null;
        }
      },

      // §6.3, tombstone path — this codebase has no wiki-mode postcards yet
      // (§1.2 is unbuilt; every card today is single-author), so this is
      // scoped to the one authorization rule that's actually real right
      // now: author-only (this tab only ever lists the current user's own
      // cards in the first place, so there's no separate ownership check
      // needed beyond that). The "has this ever been delivered, so use
      // per-mailbox-hide instead" branch isn't implemented either (§2.5's
      // send-freeze doesn't exist yet) — tombstone is unconditionally the
      // delete mechanism for now, matching reality since nothing else here
      // is built.
      //
      // The mailbox listing (`pc`) is metadata-only — no record.payload —
      // so a GET is needed first to get the full envelope before PUTting
      // it back with only state.deleted added; record.payload/cid stay
      // untouched, so ObjectRepository.put() takes its existing
      // metadata-only-update path (matching cid) rather than creating a
      // new version. `sig` is dropped rather than carried over stale —
      // PostCardView's integrity check treats a present-but-mismatched sig
      // as "tampered" and an absent one as neutrally "unsigned"; dropping
      // it is the less alarming of the two inaccurate options, and
      // re-signing here would need the owner's WebAuthn/KEK material this
      // mailbox was never given.
      _deletePostcard: function (handle, pc) {
        var self = this;
        this.world().confirm(
          "Delete this post card? It'll disappear from your postcards, " +
          "feeds, and mailboxes that reference it. Past versions in its " +
          "history aren't erased.",
          function (answer) {
            if (!answer) return;

            var base = lively.identity.did.baseUrl();
            var url  = base + '/@' + handle + '/' + pc.objId;

            var getXhr = new XMLHttpRequest();
            getXhr.open('GET', url, true);
            getXhr.setRequestHeader('Accept', 'application/json');
            getXhr.withCredentials = true;
            getXhr.onload = function () {
              if (getXhr.status !== 200) {
                return self.world().inform('Could not load this post card to delete it (' + getXhr.status + ').');
              }
              var envelope;
              try { envelope = JSON.parse(getXhr.responseText); } catch (e) {
                return self.world().inform('Could not delete this post card: bad response.');
              }

              var updated = Object.assign({}, envelope, {
                state: Object.assign({}, envelope.state || {}, { deleted: true }),
              });
              delete updated.sig;

              var putXhr = new XMLHttpRequest();
              putXhr.open('PUT', url, true);
              putXhr.setRequestHeader('Content-Type', 'application/json');
              putXhr.withCredentials = true;
              putXhr.onload = function () {
                if (putXhr.status !== 200) {
                  return self.world().inform('Could not delete this post card (' + putXhr.status + ').');
                }
                self._loadOwn();
              };
              putXhr.onerror = function () { self.world().inform('Network error deleting this post card.'); };
              putXhr.send(JSON.stringify(updated));
            };
            getXhr.onerror = function () { self.world().inform('Network error loading this post card.'); };
            getXhr.send();
          }
        );
      },

      // §6.3, Layer 1 — per-viewer hide, for any delivered card (Received/
      // Delivered/Returned rows are all delivery-event references; the
      // current user may be the sender, the recipient, or both — the
      // mechanism doesn't need to know which). Never mutates the shared
      // envelope, so it can't remove the card from anyone else's mailbox —
      // that's the whole reason this exists as a separate mechanism from
      // _deletePostcard's tombstone above, per the spec's own reasoning
      // ("deleting a sent card shouldn't delete it for the recipient").
      _hideFromMailbox: function (objId, onSuccess) {
        var self = this;
        this.world().confirm(
          "Delete this post card? It'll disappear from your postcards and " +
          "mailboxes. This doesn't affect the recipient's copy, or any " +
          "other recipient's — they keep exactly what was sent to them, " +
          "same as a mailed postcard.",
          function (answer) {
            if (!answer) return;
            var handle = lively.identity.did.currentUser().handle;
            var base   = lively.identity.did.baseUrl();
            var xhr    = new XMLHttpRequest();
            xhr.open('DELETE', base + '/@' + handle + '/mailbox/' + objId, true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) return self.world().inform('Could not delete this post card (' + xhr.status + ').');
              onSuccess();
            };
            xhr.onerror = function () { self.world().inform('Network error deleting this post card.'); };
            xhr.send();
          }
        );
      },

      // §3.2 — the server generates the alias string; this just asks for one.
      // Calls thenDo(err).
      _generateAlias: function (thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('POST', base + '/@' + handle + '/aliases', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Request failed (' + xhr.status + ')';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            return thenDo(new Error(msg));
          }
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // Calls thenDo(err).
      _revokeAliasHandle: function (alias, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/aliases/' + encodeURIComponent(alias), true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error('Request failed (' + xhr.status + ')'));
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // Same clipboard approach as PostCardView.js's tip-jar Copy button —
      // async Clipboard API with a textarea/execCommand fallback for
      // contexts where it's unavailable.
      _copyToClipboard: function (text, btn) {
        var restore = btn.textContent;
        function copied() {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = restore; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copied).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); copied(); } catch (e2) {}
          document.body.removeChild(ta);
        }
      },

      // Resolve to a DID too so both blockedDids and blockedHandles get
      // populated — the inbox check (IdentityServer.js) matches on either.
      _blockHandle: function (handle, thenDo) {
        var self = this;
        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          var did = (!err && info) ? info.did : null;
          self._patchBlockList(function (state) {
            if (state.blockedHandles.indexOf(handle) === -1) state.blockedHandles.push(handle);
            if (did && state.blockedDids.indexOf(did) === -1) state.blockedDids.push(did);
          }, thenDo);
        });
      },

      _unblockHandle: function (handle, thenDo) {
        this._patchBlockList(function (state) {
          state.blockedHandles = state.blockedHandles.filter(function (h) { return h !== handle; });
          // Any DID entry for this handle is left as-is here — a stale DID
          // left in blockedDids fails closed (over-blocks), not open, so
          // it's not a correctness risk, just a minor cleanup gap.
        }, thenDo);
      },

      // mutate(state) edits state.blockedDids/blockedHandles in place. The
      // settings payload never changes here (block list lives in state per
      // tranche 2's F18), but record.cid is still recomputed over it before
      // every PUT — same discipline as the rest of this codebase's
      // envelope writes, cheap and avoids ever landing a stale cid.
      _patchBlockList: function (mutate, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var env    = this._settingsEnvelope;
        if (!env) return thenDo(new Error('Settings not loaded yet'));

        env.state = env.state || {};
        env.state.blockedDids    = env.state.blockedDids    || [];
        env.state.blockedHandles = env.state.blockedHandles || [];
        mutate(env.state);

        var payload = (env.record && env.record.payload) || {};
        lively.identity.crypto.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);
          env.record.cid = cid;
          var xhr = new XMLHttpRequest();
          xhr.open('PUT', base + '/@' + handle + '/settings', true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) return thenDo(null);
            thenDo(new Error('PUT failed: ' + xhr.status));
          };
          xhr.onerror = function () { thenDo(new Error('Network error')); };
          xhr.send(JSON.stringify(env));
        });
      },

      // ── helpers ───────────────────────────────────────────────────────────

      _makeCard: function () {
        var card = document.createElement('div');
        card.style.cssText = [
          'background:#fff', 'border:1px solid #e5e5ea', 'border-radius:8px',
          'padding:10px 12px', 'margin-bottom:8px', 'position:relative',
        ].join(';');
        return card;
      },

      _formatDate: function (iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
      },

      // Avatar + handle row — identicon shown immediately (cheap, always
      // correct as a fallback), upgraded to the real avatar if that
      // handle's profile has one set, same two-step pattern
      // PostCardView.js's _loadAvatar already uses. `handle` may be
      // missing for a handful of legacy inbox records that predate
      // storing senderHandle (audit F4) — falls back to a truncated DID
      // with a DID-seeded identicon rather than no row at all.
      _makeIdentityRow: function (prefix, handle, didFallback) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';

        var img = document.createElement('img');
        img.style.cssText = 'width:22px;height:22px;border-radius:50%;flex:none;';
        img.src = lively.identity.postCardUtils.identiconDataUrl(handle || didFallback || '', 22);
        row.appendChild(img);

        var text = document.createElement('span');
        text.style.cssText = 'font-weight:600;color:#1c1c1e;';
        text.textContent = prefix + (handle ? '@' + handle : (didFallback ? didFallback.slice(0, 24) + '…' : '(unknown)'));
        row.appendChild(text);

        if (handle) {
          var base = lively.identity.did.baseUrl();
          fetch(base + '/@' + encodeURIComponent(handle) + '/profile', { credentials: 'include' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (avatarUrl) img.src = avatarUrl;
            })
            .catch(function () {}); // network error — keep the identicon fallback
        }

        return row;
      },

      _showError: function (msg) {
        this._contentDiv.innerHTML =
          '<div style="color:#ff3b30;padding:20px 0;">' + msg + '</div>';
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(MailboxClass, {
      open: function (tab) {
        var morph = new lively.identity.PostCardMailbox(lively.rect(0, 0, 560, 480));
        morph.openInWorldCenter();
        morph.bringToFront();
        if (tab && tab !== 'received') morph._switchTab(tab);
        return morph;
      },
    });

  }); // end module('lively.identity.PostCardMailbox')
