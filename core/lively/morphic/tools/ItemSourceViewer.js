/**
 * lively.morphic.tools.ItemSourceViewer
 *
 * Read-only, syntax-highlighted viewer for an Inventory/PartsBin item's
 * embedded addScript/BuildSpec method source — lets an item's code be
 * inspected BEFORE it is ever loaded/deserialized/eval'd. Built on
 * lively.persistence.Serializer.scriptSourcesIn, which extracts the source
 * text from an item's raw parsed JSON without instantiating anything, so
 * this is safe to call on untrusted item JSON.
 *
 * Shared by both the Inventory browser and the classic PartsBin browser
 * (see Inventory.js's viewSourceOfSelectedItem and tools/PartsBin.js's
 * viewSourceForSelection).
 */
module('lively.morphic.tools.ItemSourceViewer')
  .requires()
  .toRun(function () {

    lively.morphic.tools = lively.morphic.tools || {};

    function jsoOf(json) {
      return typeof json === 'string' ? lively.persistence.Serializer.parseJSON(json) : json;
    }

    function concatenateSource(scripts) {
      if (!scripts.length) {
        return '// No addScript/BuildSpec method source found in this item.';
      }
      return scripts.map(function (s) {
        var owner = s.ownerName || s.ownerClass || ('#' + s.ownerId);
        return '// --- ' + owner + '.' + s.scriptName + ' ---\n' + s.source;
      }).join('\n\n');
    }

    lively.morphic.tools.ItemSourceViewer = {
      open: function (itemName, json) {
        var jso = jsoOf(json),
            scripts = lively.persistence.Serializer.scriptSourcesIn(jso),
            content = concatenateSource(scripts);
        return $world.addCodeEditor({
          title: 'Source: ' + itemName,
          content: content,
          textMode: 'javascript',
          theme: 'twilight',
          allowInput: false,
          gutter: false,
          extent: lively.pt(700, 500)
        });
      }
    };

  });
