/**
 * lively.identity.PostCardMailbox
 *
 * Tabbed morph showing the three views of the user's postcard mailbox:
 *
 *   Received  — cards delivered to your inbox (GET /@:handle/inbox)
 *   Delivered — cards you sent that were accepted (GET /@:handle/deliveries?status=delivered)
 *   Returned  — cards that got the postal rejection  (GET /@:handle/deliveries?status=returned)
 *
 * Entry point:
 *   lively.identity.PostCardMailbox.open(tab)
 *     tab: 'received' | 'delivered' | 'returned'  (defaults to 'received')
 */

module('lively.identity.PostCardMailbox')
  .requires(
    'lively.identity.DID',
    'lively.identity.PostCardEditor',
  )
  .toRun(function () {

    var MailboxClass = lively.morphic.Box.subclass('lively.identity.PostCardMailbox',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_tabBtns'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._activeTab = 'received';
        this._contentDiv = null;
        this._tabBtns    = {};
        this._buildChrome();
        this._switchTab('received');
      },

      _buildChrome: function () {
        var self = this;
        this.setFill(Color.white);
        var shapeNode = this.renderContext().shapeNode;
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

        // ── content area ──
        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:72px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:12px 16px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:13px',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
      },

      _switchTab: function (tab) {
        var self = this;
        this._activeTab = tab;

        // Update tab button styles
        Object.keys(this._tabBtns).forEach(function (id) {
          var btn = self._tabBtns[id];
          var active = id === tab;
          btn.style.color           = active ? '#007aff' : '#636366';
          btn.style.borderBottom    = active ? '2px solid #007aff' : '2px solid transparent';
          btn.style.fontWeight      = active ? '600' : '400';
          btn.style.background      = active ? '#fff' : 'transparent';
        });

        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';

        if (tab === 'received')  this._loadReceived();
        if (tab === 'delivered') this._loadDeliveries('delivered');
        if (tab === 'returned')  this._loadDeliveries('returned');
      },

      // ── data fetching ─────────────────────────────────────────────────────

      _loadReceived: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/inbox?limit=30');
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
        xhr.open('GET', base + '/@' + handle + '/deliveries?status=' + status + '&limit=30');
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

          var from = document.createElement('div');
          from.style.cssText = 'font-weight:600;color:#1c1c1e;margin-bottom:3px;';
          from.textContent   = 'From: ' + (rec.senderDid ? rec.senderDid.slice(0, 32) + '…' : '(unknown)');

          var id = document.createElement('div');
          id.style.cssText  = 'color:#636366;font-size:11px;margin-bottom:3px;';
          id.textContent    = 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:#8e8e93;font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          card.appendChild(from);
          card.appendChild(id);
          card.appendChild(when);
          // /@:handle/... routes resolve handles, not DIDs — without a
          // senderHandle there is no working link to open, so omit the
          // button rather than ship a 404 (audit F4).
          if (rec.senderHandle) {
            var openBtn = self._makeOpenBtn(function () {
              window.open('/@' + rec.senderHandle + '/' + rec.objId, '_blank');
            });
            card.appendChild(openBtn);
          }
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

          var to = document.createElement('div');
          to.style.cssText  = 'font-weight:600;color:#1c1c1e;margin-bottom:3px;';
          to.textContent    = 'To: @' + (rec.recipientHandle || '(unknown)');

          var id = document.createElement('div');
          id.style.cssText  = 'color:#636366;font-size:11px;margin-bottom:3px;';
          id.textContent    = 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:#8e8e93;font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          var openBtn = self._makeOpenBtn(function () {
            var user = lively.identity.did.currentUser();
            lively.identity.PostCardEditor.openCard('@' + user.handle, rec.objId);
          });

          card.appendChild(to);
          card.appendChild(id);
          card.appendChild(when);
          card.appendChild(openBtn);
          content.appendChild(card);
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

      _makeOpenBtn: function (onClick) {
        var btn = document.createElement('button');
        btn.textContent    = 'Open';
        btn.style.cssText  = [
          'position:absolute', 'top:10px', 'right:10px',
          'font-size:11px', 'padding:3px 8px', 'cursor:pointer',
          'border:1px solid #007aff', 'color:#007aff',
          'background:#fff', 'border-radius:4px',
        ].join(';');
        btn.addEventListener('click', onClick);
        return btn;
      },

      _formatDate: function (iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
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
