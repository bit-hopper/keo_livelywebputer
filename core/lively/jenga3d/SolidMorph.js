/**
 * lively.jenga3d.SolidMorph
 *
 * A CAD solid as a Morph (Jenga3Dspec_v0.md §8, §13 step 13) — deliberately
 * just a Morph so it inherits saving, publishing, and sharing from the
 * existing identity system for free: no new envelope type, no new server
 * route, no new URL namespace segment. Subclasses `lively.jenga3d.Viewport`
 * (§13 step 4) rather than wrapping one — a solid IS its own rendering
 * surface — adding the one thing Viewport alone doesn't have: a persisted
 * `featureTree` (§7.1's Application State layer) plus, since §14.5/§13
 * step 17, an `assembly` (`lively.jenga3d.Assembly`) tying that tree's
 * (potentially several, §14.2) instances to this morph's own rendering —
 * replacing the single `SceneSync` this class held directly before
 * multi-instance support existed.
 *
 * §7.1: render state (the THREE scene/mesh) is never persisted, only
 * `featureTree` — a plain `lively.jenga3d.FeatureTree` instance, which
 * serializes generically like any other Lively object graph (no special
 * handling needed, same as a Shape or a MetaInfo object already does).
 *
 * **Correction to §8's wording**: the spec calls this an "afterDeserialization
 * hook" — no such hook exists anywhere in this codebase (confirmed by
 * grep before writing this). The real, generic mechanism is
 * `lively.persistence.Serializer`'s own plugin system, which calls
 * `.onrestore()` on any deserialized object that defines one
 * (core/lively/persistence/Serializer.js, `afterDeserializeObj` — the
 * same mechanism `lively.morphic.CodeEditor`'s own `onLoad`-under-
 * `'serialization'` pattern is adjacent to, but `onrestore` is the one
 * actually invoked automatically for every object, not just morphs).
 * `onrestore` recreates `sceneSync` — whose own constructor already
 * re-evaluates the tree through the worker and regenerates the mesh once
 * three.js is ready (§4.5, §13 step 5) — and re-registers the
 * `whenOpenedInWorld` hook `Viewport`'s constructor normally sets up,
 * since `initialize` does not run again on restore.
 */

module('lively.jenga3d.SolidMorph')
  .requires('lively.jenga3d.Viewport', 'lively.jenga3d.FeatureTree', 'lively.jenga3d.Assembly')
  .toRun(function () {

    lively.jenga3d.Viewport.subclass('lively.jenga3d.SolidMorph',

    'settings', {
      doNotSerialize: ['_three', '_meshes', '_selectionOutlines', 'assembly'],
    },

    'initializing', {
      // featureTree: optional existing lively.jenga3d.FeatureTree to take
      // ownership of (e.g. handed off from a tool that built one before
      // a SolidMorph existed to own it) — omit for a fresh empty solid.
      initialize: function ($super, bounds, featureTree) {
        $super(bounds);
        this.featureTree = featureTree || new lively.jenga3d.FeatureTree();
        this.assembly = new lively.jenga3d.Assembly(this.featureTree, this);
      },
    },

    'serialization', {
      // §7.1, §8: called automatically by lively.persistence.Serializer
      // on restore (see file doc for why this isn't the "afterDeserialization"
      // hook name §8 originally described). featureTree itself is already
      // fully reconstructed by this point — only the doNotSerialize'd
      // transient state (assembly, and everything Viewport itself already
      // excludes) needs rebuilding. Assembly's own constructor resyncs a
      // SceneSync per already-existing root (§13 step 17), so restoring
      // a tree with several instances re-renders all of them, not just one.
      onrestore: function () {
        this.assembly = new lively.jenga3d.Assembly(this.featureTree, this);
        var self = this;
        this.whenOpenedInWorld(function () { self._ensureThreeRuntime(function () { self._setupThree(); }); });
      },
    });

  });
