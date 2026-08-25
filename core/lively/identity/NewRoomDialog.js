/**
 * lively.identity.NewRoomDialog
 *
 * Small BuildSpec dialog collecting a name and voice/video toggles for a
 * new Spaces/rooms room (ConstellationLounge.js's Spaces panel). Styled
 * after lively.identity.NewWikiPageDialog / lively.morphic.tools.
 * PublishToInventoryDialog (same style tokens: border radii, Color.rgb(...)
 * values, padding, button styling) and opened the same way (world-tracked
 * singleton via lively.BuildSpec(...).createMorph() +
 * openInWorldCenter().comeForward()).
 *
 * The dialog itself never touches storage — it only collects and validates
 * { name, isVideo, isVoice, access, activity } and hands them to the
 * caller's onCreate callback, which POSTs to /c/:name/rooms (see
 * ConstellationLounge.js's _openNewRoom).
 *
 * The video/voice toggles are two independent chips (not a radio group,
 * unlike PublishToInventoryDialog's visibility buttons) — a room can be
 * marked as a camera room, a headset room, both, or neither (plain
 * text-only room). Each chip pairs a Material Symbols glyph with a plain
 * text label as two separate Text morphs rather than one — CLAUDE.md's
 * icon-font-and-body-font-don't-share-a-baseline gotcha, accepted here
 * since there's enough visual separation (icon vs. label) that a slight
 * mismatch doesn't read as one broken unit, unlike the single-baseline
 * "+ Postcard"-style pill button elsewhere in this codebase.
 *
 * Access ("Open" / "Request to Join"), below the toggles, IS a real
 * 2-way radio group — same manual-radio idiom PublishToInventoryDialog's
 * Public/Private/Shared buttons use (each button's connectionRebuilder
 * fires into one selectAccess method with a converter supplying its own
 * value). 'open': any signed-in constellation member can join the room by
 * clicking its card. 'request': a member must request access; a
 * constellation controller approves/declines (mirrors the constellation's
 * own join-request flow, scoped to one room).
 *
 * The "Active Participants Nickname" field, below the toggles, is a plain
 * free-text input line (same shape as NameText) — the creator types their
 * own optional nickname/category (e.g. "Jamming", "Reading") describing
 * what active participants are doing, rather than picking from a preset
 * list. This becomes room.activity server-side and shows on the room card
 * as "· <activity>" (ConstellationLounge.js's _renderRoomCard already
 * renders this field — it just had no way to be set before this dialog
 * collected it).
 */

module('lively.identity.NewRoomDialog')
  .requires('lively.persistence.BuildSpec')
  .toRun(function () {

    lively.BuildSpec('lively.identity.NewRoomDialog', {
      _BorderRadius: 7,
      _Extent: lively.pt(380.0, 324.0),
      _Fill: Color.rgb(88, 101, 242),
      className: 'lively.morphic.Window',
      name: 'NewRoomDialog',
      sourceModule: 'lively.identity.NewRoomDialog',
      contentOffset: lively.pt(3.0, 22.0),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      minExtent: lively.pt(380.0, 324.0),
      submorphs: [{
        _BorderColor: Color.rgb(95, 94, 95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0, 296.0),
        _Fill: Color.rgb(243, 243, 243),
        _Position: lively.pt(3.0, 23.0),
        className: 'lively.morphic.Box',
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: { adjustForNewBounds: true, resizeWidth: true },
        name: 'NewRoomDialogPane',
        sourceModule: 'lively.morphic.Core',
        submorphs: [{
          _Extent: lively.pt(100.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 8.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'NameLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Room Name',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 30.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'NameText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 64.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'ToggleLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Room Type (optional)',
        }, {
          // Camera/video chip -- toggles independently of the voice chip.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 16,
          _BorderWidth: 1,
          _Extent: lively.pt(84.0, 32.0),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(10.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'VideoToggleChip',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(18.0, 18.0),
            _Position: lively.pt(10.0, 7.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13.5,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VideoIcon',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'videocam',
          }, {
            _Extent: lively.pt(48.0, 16.0),
            _Position: lively.pt(30.0, 8.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VideoLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'Video',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleVideo();
            evt.stop();
            return true;
          },
        }, {
          // Headset/voice chip -- toggles independently of the video chip.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 16,
          _BorderWidth: 1,
          _Extent: lively.pt(84.0, 32.0),
          _Fill: Color.rgb(243, 243, 243),
          _Position: lively.pt(104.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'VoiceToggleChip',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(18.0, 18.0),
            _Position: lively.pt(10.0, 7.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13.5,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VoiceIcon',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'headset',
          }, {
            _Extent: lively.pt(48.0, 16.0),
            _Position: lively.pt(30.0, 8.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'VoiceLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'Voice',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleVoice();
            evt.stop();
            return true;
          },
        }, {
          _Extent: lively.pt(300.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 126.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'ActivityLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Active Participants Nickname (optional)',
        }, {
          // Free-text, creator-typed nickname/category (e.g. "Jamming",
          // "Reading") describing what active participants are doing --
          // same input-line shape as NameText above. Shown on the room
          // card as "· <activity>" once set (ConstellationLounge.js's
          // _renderRoomCard, room.activity).
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 148.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'ActivityText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 180.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'AccessLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Access',
        }, {
          // 2-way radio: 'open' (default) vs 'request' -- see selectAccess.
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(70.0, 24.0),
          _Position: lively.pt(10.0, 202.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Open',
          name: 'OpenButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectAccess', {
              converter: function() { return 'open'; }
            });
          },
        }, {
          _BorderColor: Color.rgb(180, 180, 180),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(130.0, 24.0),
          _Position: lively.pt(88.0, 202.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'Request to Join',
          name: 'RequestButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'selectAccess', {
              converter: function() { return 'request'; }
            });
          },
        }, {
          _Extent: lively.pt(354.0, 18.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 236.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'StatusText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textColor: Color.rgb(153, 153, 153),
          textString: '',
        }, {
          _BorderColor: Color.rgb(214, 214, 214),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(80.0, 24.0),
          _Position: lively.pt(204.0, 262.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'cancel',
          name: 'CancelButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'onCancel', {});
          },
        }, {
          _BorderColor: Color.rgb(160, 168, 250),
          _BorderRadius: 5.2,
          _BorderWidth: 1.184,
          _Extent: lively.pt(80.0, 24.0),
          _Fill: Color.rgb(231, 233, 254),
          _Position: lively.pt(288.0, 262.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'create',
          name: 'CreateButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewRoomDialogPane'), 'onSubmit', {});
          },
        }],
        target: null,

        // ─── lifecycle ──────────────────────────────────────────────────────────

        // scope: { constellation: name } -- informational only, threaded
        // straight through to onCreate's caller-supplied callback; this
        // dialog never itself decides what scope means.
        configure: function configure(opts) {
          this._scope = (opts && opts.scope) || null;
          this._onCreateCallback = (opts && opts.onCreate) || null;
          this._isVideo = false;
          this._isVoice = false;
          this.get('NameText').textString = '';
          this.get('ActivityText').textString = '';
          this.paintToggle('VideoToggleChip', 'VideoIcon', 'VideoLabel', false);
          this.paintToggle('VoiceToggleChip', 'VoiceIcon', 'VoiceLabel', false);
          this.selectAccess('open');
          this.setStatus('');
        },

        onCancel: function onCancel() {
          this.owner.remove();
        },

        onRemove: function onRemove() {
          $world.newRoomDialog && $world.newRoomDialog.remove();
        },

        setStatus: function setStatus(text, isError) {
          var t = this.get('StatusText');
          t.textString = text || '';
          t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
        },

        // ─── toggles ────────────────────────────────────────────────────────────
        // Two independent on/off chips, not a radio group -- each just
        // flips its own boolean and repaints itself, no interaction with
        // the other chip's state.

        paintToggle: function paintToggle(chipName, iconName, labelName, isOn) {
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          var selectedText = Color.rgb(72, 82, 224), normalText = Color.rgb(120, 120, 120);
          var chip = this.get(chipName);
          chip.setFill(isOn ? selectedFill : normalFill);
          chip.setBorderColor(isOn ? selectedBorder : normalBorder);
          this.get(iconName).setTextColor(isOn ? selectedText : normalText);
          this.get(labelName).setTextColor(isOn ? selectedText : normalText);
        },

        toggleVideo: function toggleVideo() {
          this._isVideo = !this._isVideo;
          this.paintToggle('VideoToggleChip', 'VideoIcon', 'VideoLabel', this._isVideo);
        },

        toggleVoice: function toggleVoice() {
          this._isVoice = !this._isVoice;
          this.paintToggle('VoiceToggleChip', 'VoiceIcon', 'VoiceLabel', this._isVoice);
        },

        // ─── access ─────────────────────────────────────────────────────────────
        // A real 2-way radio (unlike the video/voice toggles above) -- each
        // button's connectionRebuilder fires here with its own converter
        // value (see OpenButton/RequestButton above), same manual-radio
        // idiom PublishToInventoryDialog's selectVisibility uses for its
        // Public/Private/Shared buttons.

        selectAccess: function selectAccess(v) {
          this._access = v;
          var selectedFill = Color.rgb(224, 227, 254), selectedBorder = Color.rgb(88, 101, 242);
          var normalFill = Color.rgb(243, 243, 243), normalBorder = Color.rgb(180, 180, 180);
          [['OpenButton', 'open'], ['RequestButton', 'request']].forEach(function(pair) {
            var btn = this.get(pair[0]);
            var isSelected = pair[1] === v;
            btn.setFill(isSelected ? selectedFill : normalFill);
            btn.setBorderColor(isSelected ? selectedBorder : normalBorder);
          }, this);
        },

        // ─── submit ──────────────────────────────────────────────────────────────

        onSubmit: function onSubmit() {
          var name = this.get('NameText').textString.trim();
          if (!name) { this.setStatus('Room name is required', true); return; }

          var activity = this.get('ActivityText').textString.trim();
          var fields = {
            name: name, isVideo: this._isVideo, isVoice: this._isVoice, access: this._access,
            activity: activity || null,
          };
          var cb = this._onCreateCallback;
          this.owner.remove();
          if (cb) cb(fields);
        },
      }],
      titleBar: 'New Room',
      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, 'remove', this.get('NewRoomDialogPane'), 'onRemove', {});
      },
    });

    // Static open helper -- same world-tracked-singleton pattern as
    // lively.identity.NewWikiPageDialog.open.
    //
    // opts: { scope: {constellation:name}, onCreate(fields) }
    // fields: { name, isVideo, isVoice, access, activity }
    Object.extend(lively.identity.NewRoomDialog, {
      open: function (opts) {
        var world = lively.morphic.World.current();
        if (world.newRoomDialog) world.newRoomDialog.remove();
        var dlg = lively.BuildSpec('lively.identity.NewRoomDialog').createMorph();
        dlg.openInWorldCenter().comeForward();
        world.newRoomDialog = dlg;
        dlg.get('NewRoomDialogPane').configure(opts || {});
        return dlg;
      },
    });

  }); // end of module
