/**
 * lively.identity.LocalMap
 *
 * The "lofi social map" — a geographic map (OpenStreetMap tiles via
 * Leaflet) showing small postcard icons for public postcards near the
 * *viewer's own* location, requested at runtime via the browser Geolocation
 * API. A separate, additive section on the welcome page (see
 * IdentityServer.js's GET /welcome.html handler) — it does not replace or
 * touch ConstellationSpace.js's arbitrary x/y postcard-placement canvas.
 *
 * Privacy model: every postcard's `state.location` is already a floored
 * Plus Code (<=6 significant digits, ~5.5km x 5.5km cell — see
 * PostCardUtils.js's encodeLocation and the server-side enforcement in
 * PlusCode.js/IdentityServer.js's PUT handler) by the time it ever reaches
 * this module. Decoding it gives that cell's *center*, never a poster's
 * real position — every postcard sharing a cell decodes to the identical
 * point. That's the intended behavior, not a bug to work around.
 *
 * This module manages a plain `<div>` directly via DOM/Leaflet, mounted
 * outside the morph tree (see IdentityServer.js's onStartWorld hook) —
 * consistent with how PostCardEditor.js/PostCardView.js already mix
 * plain-DOM content (ProseMirror) alongside morphic structures.
 *
 * Entry point: lively.identity.LocalMap.open(containerEl)
 */

module("lively.identity.LocalMap")
  .requires(
    "lively.identity.DID",
    "lively.identity.PostCardUtils",
    "lively.identity.PostCardView",
  )
  .toRun(function () {

    // Small deterministic ring offset (not random — must stay stable across
    // re-renders) for markers that share one coarse cell, so they don't
    // stack exactly on top of each other. ~60-70m at mid-latitudes, small
    // enough to stay well inside the ~5.5km cell it's disambiguating within.
    var SAME_CELL_OFFSET_DEG = 0.0006;

    var POSTCARD_MARKER_HTML =
      '<div style="width:24px;height:24px;display:flex;align-items:center;' +
      'justify-content:center;background:#fff;border:2px solid #d33;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);' +
      'font-size:12px;line-height:1;">✉️</div>';

    Object.subclass("lively.identity.LocalMapController",

    'initializing', {
      initialize: function () {
        this._containerEl = null;
        this._mapEl       = null;
        this._fallbackEl  = null;
        this._map         = null;     // Leaflet map instance, created once
        this._markers     = {};       // objId -> L.Marker
        this._viewerCode  = null;     // this device's floored Plus Code
      },
    },

    // ─── boot / chrome ──────────────────────────────────────────────────────────

    'boot', {

      buildInto: function (containerEl) {
        this._containerEl = containerEl;
        containerEl.className = 'lively-localmap';
        containerEl.style.cssText = [
          // width kept explicit (computed, not just dropped in favor of
          // margin-only auto-width) — this app's body sizing isn't
          // guaranteed to behave like a plain block context, so an
          // explicit calc() is safer than relying on auto-width-minus-margin.
          'position:relative', 'width:calc(100% - 48px)', 'margin:24px', 'height:360px',
          'border-radius:10px', 'overflow:hidden',
          'box-shadow:0 4px 14px rgba(0,0,0,0.15)',
          'background:#eef0f2', 'font-family:sans-serif', 'box-sizing:border-box',
        ].join(';');

        var mapEl = document.createElement('div');
        mapEl.style.cssText = 'position:absolute;inset:0;';
        containerEl.appendChild(mapEl);
        this._mapEl = mapEl;

        this._buildFallback(containerEl);
        this._start();
      },

      // Shown until a viewer location is available (or in place of the map
      // if geolocation is denied/unavailable/errors) — never a silently
      // empty map, since there is intentionally no "list all public
      // postcards globally" endpoint to fall back to without a location.
      _buildFallback: function (containerEl) {
        var self = this;
        var fallback = document.createElement('div');
        fallback.style.cssText = [
          'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
          'align-items:center', 'justify-content:center', 'gap:10px',
          'background:#eef0f2', 'color:#555', 'font-size:13px', 'text-align:center',
          'padding:16px', 'box-sizing:border-box',
        ].join(';');

        var msg = document.createElement('div');
        msg.textContent = 'Enable location to see postcards near you.';
        fallback.appendChild(msg);
        this._fallbackMsgEl = msg;

        var retryBtn = document.createElement('button');
        retryBtn.textContent = 'Enable location';
        retryBtn.style.cssText = 'font-size:12px;padding:6px 14px;cursor:pointer;' +
          'border:1px solid #ccc;border-radius:16px;background:#fff;';
        retryBtn.addEventListener('click', function () { self._start(); });
        fallback.appendChild(retryBtn);

        containerEl.appendChild(fallback);
        this._fallbackEl = fallback;
      },

      _showFallback: function (message) {
        if (this._fallbackMsgEl && message) this._fallbackMsgEl.textContent = message;
        if (this._fallbackEl) this._fallbackEl.style.display = 'flex';
      },

      _hideFallback: function () {
        if (this._fallbackEl) this._fallbackEl.style.display = 'none';
      },

    },

    // ─── geolocation ────────────────────────────────────────────────────────────

    'geolocation', {

      _start: function () {
        var self = this;
        if (!navigator.geolocation) {
          this._showFallback('Geolocation is not available in this browser.');
          return;
        }
        this._showFallback('Locating…');
        this._ensureGeoRuntime(function () {
          navigator.geolocation.getCurrentPosition(function (pos) {
            self._onLocated(pos.coords.latitude, pos.coords.longitude);
          }, function () {
            self._showFallback('Enable location to see postcards near you.');
          }, { timeout: 8000, maximumAge: 300000 });
        });
      },

      _onLocated: function (lat, lng) {
        this._hideFallback();
        this._viewerCode = lively.identity.postCardUtils.encodeLocation(lat, lng);
        if (!this._viewerCode) {
          this._showFallback('Could not determine your location.');
          return;
        }
        this._initMap(lat, lng);
        this._fetchNearby();
      },

      // Lazy-loads core/lib/geo/geo-runtime.js (window.L + window.OpenLocationCode).
      // Same guard/poll/CSS-link shape as PostCardEditor.js's _ensureRuntime —
      // intentionally duplicated rather than shared, matching this codebase's
      // existing tolerance for small per-module copies of this pattern.
      _ensureGeoRuntime: function (callback) {
        if (window.L && window.OpenLocationCode) return callback();
        var self = this;
        if (window._geoRuntimeLoading) {
          var poll = setInterval(function () {
            if (window.L && window.OpenLocationCode) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._geoRuntimeLoading = true;
        if (!document.getElementById('leaflet-css')) {
          var link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/geo/leaflet.css';
          document.head.appendChild(link);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/geo/geo-runtime.js';
        s.onload = function () { window._geoRuntimeLoading = false; callback(); };
        s.onerror = function () {
          window._geoRuntimeLoading = false;
          self._showFallback('Failed to load the map — try reloading.');
        };
        document.head.appendChild(s);
      },

    },

    // ─── map + markers ──────────────────────────────────────────────────────────

    'map', {

      _initMap: function (lat, lng) {
        if (this._map) return; // already built (e.g. a retry after locating once before)
        this._map = window.L.map(this._mapEl).setView([lat, lng], 13);
        window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(this._map);
      },

      _fetchNearby: function () {
        var self = this;
        if (!this._viewerCode) return;
        var base = lively.identity.did.baseUrl();
        var url = base + '/postcards/nearby?code=' + encodeURIComponent(this._viewerCode) + '&limit=100';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._placeMarkers(result.postcards || []);
        };
        xhr.send();
      },

      // Groups postcards by their (already-floored) location cell first, so
      // a cell with more than one postcard gets its markers spread on a
      // small deterministic ring instead of stacked exactly on top of each
      // other — deterministic (not random) so a marker doesn't jump between
      // re-renders/re-fetches. Skips vendoring leaflet.markercluster for
      // this: a same-cell group is small-N, not a general point-clustering
      // problem.
      _placeMarkers: function (postcards) {
        var self = this;
        if (!this._map || !window.OpenLocationCode) return;
        var olc = new window.OpenLocationCode();

        var groups = {};
        postcards.forEach(function (p) {
          var loc = p.state && p.state.location;
          if (!loc || !p.handle) return; // no location, or handle didn't resolve — nothing to show/open
          (groups[loc] = groups[loc] || []).push(p);
        });

        Object.keys(groups).forEach(function (loc) {
          var area;
          try { area = olc.decode(loc); } catch (e) { return; }
          var center = [area.latitudeCenter, area.longitudeCenter];
          var group = groups[loc];
          group.forEach(function (postcard, idx) {
            self._addMarker(self._offsetPosition(center, idx, group.length), postcard);
          });
        });
      },

      _offsetPosition: function (center, idx, groupSize) {
        if (groupSize <= 1) return center;
        var angle = (2 * Math.PI * idx) / groupSize;
        return [
          center[0] + SAME_CELL_OFFSET_DEG * Math.sin(angle),
          center[1] + SAME_CELL_OFFSET_DEG * Math.cos(angle),
        ];
      },

      _addMarker: function (latlng, postcard) {
        if (this._markers[postcard.objId]) return; // already placed this fetch cycle
        var icon = window.L.divIcon({
          className: 'lively-localmap-marker',
          html: POSTCARD_MARKER_HTML,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        var marker = window.L.marker(latlng, { icon: icon }).addTo(this._map);
        var title = (postcard.state && postcard.state.title) || '(untitled)';
        marker.bindTooltip('@' + postcard.handle + ' — ' + title);
        marker.on('click', function () {
          lively.identity.PostCardView.open(postcard.handle, postcard.objId, {});
        });
        this._markers[postcard.objId] = marker;
      },

    });

    // ─── class-side entry point ─────────────────────────────────────────────────

    lively.identity.LocalMap = {
      open: function (containerEl) {
        var controller = new lively.identity.LocalMapController();
        controller.buildInto(containerEl);
        return controller;
      },
    };

  }); // end module('lively.identity.LocalMap')
