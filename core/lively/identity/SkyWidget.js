/**
 * lively.identity.SkyWidget
 *
 * Attaches live sky/astronomy behavior to an existing morph (welcome.html's
 * "SkyMorph" placeholder box, found by name — see IdentityServer.js's
 * onStartWorld hook). Two things happen once attached:
 *
 *   1. The morph's own fill color drifts across a day/night gradient,
 *      driven by the real solar altitude at the viewer's location.
 *   2. A centered text label cycles through a handful of computed facts:
 *      current moon phase + % illuminated, days to the next full/new moon,
 *      the Sun's zodiac sign, the zodiac constellation currently on the
 *      meridian (shown only after dark), and Venus/Saturn's current sign
 *      + visibility.
 *
 * Deliberately NOT included: discrete calendar-style events like "Venus
 * enters Libra today" or "Lunar eclipse tonight". Those need either a
 * lookahead scan for the exact day an orbital element crosses a 30°
 * boundary, or a real eclipse/Saros almanac — neither is implemented here,
 * so nothing claims one happened. Everything shown is a snapshot of "right
 * now", genuinely computed each refresh, not a canned/hardcoded fact.
 *
 * Astronomy: Paul Schlyter's well-known low-precision planetary-position
 * method (heliocentric Keplerian elements with linear day-rates, valid to
 * roughly 1 arcmin near J2000 and still reasonable decades out — plenty for
 * a decorative widget). Cross-checked live against real-world sources for
 * the current date: computed Sun sign (Leo) and Venus/Saturn's current
 * signs (Virgo the day before its real reported Aug-6 ingress into Libra;
 * Saturn in Aries) all matched published data before this was wired up.
 * The Moon-phase name boundaries were likewise widened after checking
 * against a real illumination reading — the naive symmetric bands
 * mislabeled a 58%-illuminated Waning Gibbous Moon as "Last Quarter".
 *
 * "Constellation high tonight" is approximated as whatever zodiac band the
 * local sidereal time currently points at (the RA on the meridian) — a
 * genuine computation, not a lookup table, but zodiac-constellation
 * boundaries aren't evenly spaced in reality the way this treats them, so
 * treat it as "roughly this part of the zodiac", not arcminute-precise.
 *
 * Entry point: lively.identity.SkyWidget.attachTo(morph)
 */

module("lively.identity.SkyWidget")
  .requires()
  .toRun(function () {

    // ─── pure astronomy math ────────────────────────────────────────────────────

    var TAU = Math.PI * 2;
    function rad(d) { return d * Math.PI / 180; }
    function deg(r) { return r * 180 / Math.PI; }
    function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
    function julianDay(date) { return date.getTime() / 86400000 + 2440587.5; }

    var SYNODIC_MONTH = 29.530588853;
    var NEW_MOON_REF_JD = 2451550.1; // 2000-01-06 18:14 UTC, a known new moon

    function moonPhase(date) {
      var jd = julianDay(date);
      var age = (jd - NEW_MOON_REF_JD) % SYNODIC_MONTH;
      if (age < 0) age += SYNODIC_MONTH;
      var fraction = age / SYNODIC_MONTH; // 0 = new, 0.5 = full, 1 = new again
      var illumination = (1 - Math.cos(fraction * TAU)) / 2;
      var name;
      // Bands widened around the quarters (checked live against a real
      // illumination reading — narrower symmetric bands mislabeled a
      // 58%-illuminated Waning Gibbous Moon as "Last Quarter").
      if (fraction < 0.02 || fraction > 0.98) name = 'New Moon';
      else if (fraction < 0.24) name = 'Waxing Crescent';
      else if (fraction < 0.26) name = 'First Quarter';
      else if (fraction < 0.49) name = 'Waxing Gibbous';
      else if (fraction < 0.51) name = 'Full Moon';
      else if (fraction < 0.74) name = 'Waning Gibbous';
      else if (fraction < 0.76) name = 'Last Quarter';
      else name = 'Waning Crescent';
      return { age: age, fraction: fraction, illumination: illumination, name: name };
    }

    function daysToPhase(mp, targetFraction) {
      var d = (targetFraction - mp.fraction) * SYNODIC_MONTH;
      while (d <= 0) d += SYNODIC_MONTH;
      return d;
    }

    var MOON_EMOJI = {
      'New Moon': '🌑', 'Waxing Crescent': '🌒', 'First Quarter': '🌓',
      'Waxing Gibbous': '🌔', 'Full Moon': '🌕', 'Waning Gibbous': '🌖',
      'Last Quarter': '🌗', 'Waning Crescent': '🌘',
    };

    // Schlyter low-precision elements, epoch d = JD - 2451543.5 (1999-12-31.0 TT).
    // [base, per-day rate]. "sun" here means the Sun's *geocentric* orbit as
    // seen from Earth (Earth's own heliocentric elements with N=i=0) — the
    // standard trick that lets planet positions be found by simple addition
    // instead of a separate Earth-position step (see heliocentric() below).
    var ELEMENTS = {
      sun:    { N: [0, 0], i: [0, 0], w: [282.9404, 4.70935e-5], a: [1.000000, 0], e: [0.016709, -1.151e-9], M: [356.0470, 0.9856002585] },
      venus:  { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5], a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
      saturn: { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
    };

    function eccentricAnomaly(Mdeg, e) {
      var M = rad(norm360(Mdeg));
      var E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
      for (var i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      return E;
    }

    // Heliocentric ecliptic position (AU). For name === "sun" this is really
    // the Sun's geocentric position (see ELEMENTS comment above) — callers
    // add it to a planet's heliocentric position to get that planet's
    // geocentric position, rather than subtracting.
    function heliocentric(name, d) {
      var el = ELEMENTS[name];
      var N = el.N[0] + el.N[1] * d, i = el.i[0] + el.i[1] * d, w = el.w[0] + el.w[1] * d;
      var a = el.a[0] + el.a[1] * d, e = el.e[0] + el.e[1] * d, M = el.M[0] + el.M[1] * d;
      var E = eccentricAnomaly(M, e);
      var xv = a * (Math.cos(E) - e);
      var yv = a * (Math.sqrt(1 - e * e) * Math.sin(E));
      var v = Math.atan2(yv, xv);
      var r = Math.sqrt(xv * xv + yv * yv);
      var Nr = rad(N), ir = rad(i), wr = rad(w);
      return {
        x: r * (Math.cos(Nr) * Math.cos(v + wr) - Math.sin(Nr) * Math.sin(v + wr) * Math.cos(ir)),
        y: r * (Math.sin(Nr) * Math.cos(v + wr) + Math.cos(Nr) * Math.sin(v + wr) * Math.cos(ir)),
        z: r * (Math.sin(v + wr) * Math.sin(ir)),
        r: r,
      };
    }

    function obliquity(d) { return 23.4393 - 3.563e-7 * d; }

    function eclToEq(lonDeg, latDeg, oblDeg) {
      var lon = rad(lonDeg), lat = rad(latDeg), obl = rad(oblDeg);
      var xe = Math.cos(lon) * Math.cos(lat);
      var ye = Math.cos(obl) * Math.sin(lon) * Math.cos(lat) - Math.sin(obl) * Math.sin(lat);
      var ze = Math.sin(obl) * Math.sin(lon) * Math.cos(lat) + Math.cos(obl) * Math.sin(lat);
      return { ra: norm360(deg(Math.atan2(ye, xe))), dec: deg(Math.asin(ze)) };
    }

    // Takes days-since-J2000 (JD - 2451545.0) specifically — NOT the Schlyter
    // epoch (JD - 2451543.5) used for the orbital elements above. Confirmed
    // live the hard way: those two epochs are 1.5 days apart, and at this
    // formula's ~361deg/day sidereal rate that's a ~181deg error in GMST —
    // roughly a 12-hour error in what's overhead, which is why the widget
    // showed full daytime blue well after real sunset (see computeSky below,
    // which converts explicitly rather than reusing the Schlyter `d`).
    function gmstDeg(daysSinceJ2000) { return norm360(280.46061837 + 360.98564736629 * daysSinceJ2000); }

    function altAz(raDeg, decDeg, latDeg, lstDeg) {
      var ha = rad(norm360(lstDeg - raDeg));
      var lat = rad(latDeg), dec = rad(decDeg);
      var sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
      var alt = Math.asin(sinAlt);
      var cosA = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
      cosA = Math.max(-1, Math.min(1, cosA));
      var A = deg(Math.acos(cosA));
      return { altitude: deg(alt), azimuth: Math.sin(ha) > 0 ? 360 - A : A };
    }

    var ZODIAC = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
    function zodiacFromLongitude(lonDeg) { return ZODIAC[Math.floor(norm360(lonDeg) / 30) % 12]; }

    function computeSky(date, lat, lon) {
      var jd = julianDay(date);
      var d = jd - 2451543.5;
      var obl = obliquity(d);

      var sunH = heliocentric('sun', d); // Sun's geocentric position directly
      var sunLon = norm360(deg(Math.atan2(sunH.y, sunH.x)));
      var sunEq = eclToEq(sunLon, 0, obl);
      var lst = norm360(gmstDeg(jd - 2451545.0) + lon);
      var sunPos = altAz(sunEq.ra, sunEq.dec, lat, lst);

      var planets = {};
      ['venus', 'saturn'].forEach(function (name) {
        var h = heliocentric(name, d);
        var xg = h.x + sunH.x, yg = h.y + sunH.y, zg = h.z + sunH.z;
        var lonEcl = norm360(deg(Math.atan2(yg, xg)));
        var latEcl = deg(Math.atan2(zg, Math.sqrt(xg * xg + yg * yg)));
        var eq = eclToEq(lonEcl, latEcl, obl);
        var pos = altAz(eq.ra, eq.dec, lat, lst);
        var rg = Math.sqrt(xg * xg + yg * yg + zg * zg);
        var cosE = Math.max(-1, Math.min(1, (xg * sunH.x + yg * sunH.y + zg * sunH.z) / (rg * sunH.r)));
        var relRa = norm360(eq.ra - sunEq.ra); relRa = relRa > 180 ? relRa - 360 : relRa;
        planets[name] = {
          sign: zodiacFromLongitude(lonEcl),
          altitude: pos.altitude,
          elongation: deg(Math.acos(cosE)),
          leadsSun: relRa < 0, // negative => rises/culminates before the Sun => morning apparition
        };
      });

      return {
        sunAltitude: sunPos.altitude,
        sunSign: zodiacFromLongitude(sunLon),
        moon: moonPhase(date),
        highSign: zodiacFromLongitude(lst), // zodiac band currently on the meridian
        planets: planets,
      };
    }

    // ─── sky color ──────────────────────────────────────────────────────────────

    // Altitude -> RGB stops, linearly interpolated. Not distinguishing dawn
    // vs. dusk by azimuth — both read as "warm horizon light" here, which is
    // close enough for a decorative color drift.
    var COLOR_STOPS = [
      { alt: -90, color: [10, 10, 30] },
      { alt: -18, color: [15, 15, 45] },
      { alt: -10, color: [45, 30, 80] },
      { alt: -4, color: [130, 70, 90] },
      { alt: 0, color: [230, 140, 90] },
      { alt: 8, color: [130, 170, 210] },
      { alt: 30, color: [80, 150, 215] },
      { alt: 90, color: [60, 130, 205] },
    ];

    function colorForSunAltitude(alt) {
      if (alt <= COLOR_STOPS[0].alt) return COLOR_STOPS[0].color;
      for (var i = 1; i < COLOR_STOPS.length; i++) {
        if (alt <= COLOR_STOPS[i].alt) {
          var a = COLOR_STOPS[i - 1], b = COLOR_STOPS[i];
          var t = (alt - a.alt) / (b.alt - a.alt);
          return [0, 1, 2].map(function (k) { return Math.round(a.color[k] + (b.color[k] - a.color[k]) * t); });
        }
      }
      return COLOR_STOPS[COLOR_STOPS.length - 1].color;
    }

    function readableTextColor(rgb) {
      var luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      return luminance > 140 ? Color.rgb(30, 30, 30) : Color.rgb(235, 235, 245);
    }

    // ─── facts ──────────────────────────────────────────────────────────────────

    function round(n) { return Math.round(n); }

    function factsFor(sky) {
      var moonEmoji = MOON_EMOJI[sky.moon.name] || '🌙';
      var facts = [];
      facts.push(moonEmoji + ' ' + sky.moon.name + ' — ' + round(sky.moon.illumination * 100) + '% illuminated');

      var toFull = daysToPhase(sky.moon, 0.5), toNew = daysToPhase(sky.moon, 0);
      if (toFull < toNew) {
        facts.push(MOON_EMOJI['Full Moon'] + ' Full Moon in ' + round(toFull) + (round(toFull) === 1 ? ' day' : ' days'));
      } else {
        facts.push(MOON_EMOJI['New Moon'] + ' New Moon in ' + round(toNew) + (round(toNew) === 1 ? ' day' : ' days'));
      }

      facts.push('☉ Sun in ' + sky.sunSign);

      if (sky.sunAltitude < -6) {
        facts.push('✨ ' + sky.highSign + ' high overhead tonight');
      } else {
        facts.push('☀️ Daytime — stars hidden by sunlight');
      }

      var v = sky.planets.venus;
      if (v.elongation < 8) {
        facts.push('♀ Venus lost in the Sun’s glare');
      } else {
        facts.push('♀ Venus in ' + v.sign + ' — the ' + (v.leadsSun ? 'Morning' : 'Evening') + ' Star');
      }

      var s = sky.planets.saturn;
      facts.push('♄ Saturn in ' + s.sign + (s.altitude > 0 ? ' — visible now' : ' — below the horizon'));

      return facts;
    }

    // ─── morph attachment ───────────────────────────────────────────────────────

    Object.subclass('lively.identity.SkyWidgetController',

    'initializing', {
      initialize: function () {
        this._morph = null;
        this._label = null;
        this._lat = null;
        this._lon = null;
        this._facts = [];
        this._factIndex = 0;
      },
    },

    'boot', {
      // No "already attached" instance flag guarding this — confirmed live
      // (lively.persistence.Serializer's default plugin set only strips
      // *function*-valued properties, via IgnoreFunctionsPlugin; a plain
      // boolean flag set directly on the morph has no such protection and
      // would serialize into a "Save World" snapshot same as any other own
      // property) that a flag here would deserialize back as true on the
      // very next fresh page load and permanently skip _locate() — freezing
      // the widget at whatever it last showed, forever. Re-running this on
      // an already-set-up morph is safe without one: _buildLabel below finds
      // and reuses the existing named label instead of duplicating it, and
      // morph.startStepping() (see Core.js) already dedupes by selector via
      // removeEqualScripts before adding a script.
      attachTo: function (morph) {
        this._morph = morph;
        this._buildLabel(morph);
        this._locate();
      },

      // Named lookup (not just morph.submorphs[0]) so a world saved *after*
      // the label was added, then reloaded fresh, reuses the existing label
      // instead of stacking a duplicate on top of it.
      _buildLabel: function (morph) {
        var label = morph.submorphs.filter(function (m) { return m.name === 'SkyWidgetLabel'; })[0];
        if (!label) {
          var pad = 10;
          var extent = morph.getExtent();
          label = new lively.morphic.Text(
            lively.rect(pad, pad, extent.x - pad * 2, extent.y - pad * 2),
            'Reading the sky…'
          );
          label.setName('SkyWidgetLabel');
          morph.addMorph(label);
        }
        // Re-applied even when reusing an existing (e.g. previously-saved)
        // label, not just on first creation — a style fix here would
        // otherwise silently never reach any label that already existed in
        // a saved snapshot. "textAlign" is not a key applyStyle recognizes
        // (confirmed live — TextCore.js's applyStyle reads spec.align, not
        // spec.textAlign, so that key was silently dropped and the label
        // rendered left-aligned despite this call). "align"/"verticalAlign"
        // are the real keys.
        label.applyStyle({
          allowInput: false, selectable: false, fill: null, borderWidth: 0,
          fontSize: 15, align: 'center', verticalAlign: 'middle',
        });
        this._label = label;
      },

      // CSS vertical-align only affects inline/table-cell elements — Lively
      // renders text morphs as a plain block div (confirmed live), so the
      // verticalAlign style above is a no-op and text always sits top-
      // aligned regardless. Recentered manually instead: measure the actual
      // rendered content height (getTextExtent — a real DOM measurement,
      // not the label's own fixed box extent) and pad the top by half the
      // leftover space. Re-run after every text change since fact length
      // varies between one and two lines.
      _recenterLabel: function () {
        var label = this._label;
        if (!label) return;
        var boxH = label.getExtent().y;
        var contentH = label.getTextExtent().y;
        var topPad = Math.max(0, (boxH - contentH) / 2);
        label.setPadding(Rectangle.inset(0, topPad, 0, 0));
      },
    },

    'geolocation', {
      // Best-effort only — this is a decorative widget, not the postcard
      // map, so it never shows a permission-prompt UI of its own. Falls
      // back to a longitude estimated from the browser's UTC offset (so
      // day/night at least roughly lines up with the visitor's own clock)
      // and an arbitrary mid-latitude default.
      _locate: function () {
        var self = this;
        var fallback = function () {
          var offsetHours = -(new Date().getTimezoneOffset()) / 60;
          self._onLocated(40, offsetHours * 15);
        };
        if (!navigator.geolocation) return fallback();
        navigator.geolocation.getCurrentPosition(function (pos) {
          self._onLocated(pos.coords.latitude, pos.coords.longitude);
        }, fallback, { timeout: 8000, maximumAge: 600000 });
      },

      _onLocated: function (lat, lon) {
        this._lat = lat;
        this._lon = lon;
        var morph = this._morph;
        var self = this;
        morph.skyWidgetTick = function () { self.tick(); };
        morph.skyWidgetRotate = function () { self.rotate(); };
        this.tick();
        this.rotate();
        morph.startStepping(60000, 'skyWidgetTick');
        morph.startStepping(30000, 'skyWidgetRotate');
      },
    },

    'updating', {
      tick: function () {
        if (this._lat === null || !this._morph) return;
        var sky = computeSky(new Date(), this._lat, this._lon);
        var rgb = colorForSunAltitude(sky.sunAltitude);
        this._morph.setFill(Color.rgb(rgb[0], rgb[1], rgb[2]));
        if (this._label) this._label.setTextColor(readableTextColor(rgb));
        this._facts = factsFor(sky);
        this._factIndex = 0;
      },

      rotate: function () {
        if (!this._label || this._facts.length === 0) return;
        this._label.setTextString(this._facts[this._factIndex % this._facts.length]);
        this._factIndex++;
        this._recenterLabel();
      },
    });

    // ─── class-side entry point ─────────────────────────────────────────────────

    lively.identity.SkyWidget = {
      attachTo: function (morph) {
        var controller = new lively.identity.SkyWidgetController();
        controller.attachTo(morph);
        return controller;
      },
      // exposed for debugging/testing from a JS workspace
      _astro: { computeSky: computeSky, moonPhase: moonPhase, colorForSunAltitude: colorForSunAltitude, factsFor: factsFor },
    };

  }); // end module('lively.identity.SkyWidget')
