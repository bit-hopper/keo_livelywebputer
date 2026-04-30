module('lively.LexEditor')
  .requires('lively.LexicalEditor', 'lively.LexicalToolbar', 'lively.LexicalCollaboration')
  .toRun(function() {

/**
 * LexEditor
 * 
 * Morphic wrapper component for Lexical rich text editor
 * Integrates toolbar, editor, and collaborative editing
 */

Object.extend(lively.LexEditor = {}, {

  /**
   * Initialize LexEditor on a DOM container
   * Called when LexEditor.html PartsBin component is loaded
   */
  initializeEditor: function(containerElement, options) {
    options = options || {};
    
    if (!containerElement) {
      console.warn('LexEditor: No container element provided');
      return null;
    }

    // Get editor and toolbar placeholder elements
    const editorContentElement = containerElement.querySelector('#lex-editor-content');
    const editorRootElement = containerElement.querySelector('#lex-editor-root');
    const toolbarPlaceholder = containerElement.querySelector('#lex-toolbar-placeholder');
    const statusBar = containerElement.querySelector('[style*="Ready"]').parentElement;

    if (!editorRootElement) {
      console.warn('LexEditor: No editor root element found');
      return null;
    }

    // Initialize Lexical editor
    const editorConfig = Object.extend({
      theme: {
        text: {
          bold: 'lex-text-bold',
          italic: 'lex-text-italic',
          strikethrough: 'lex-text-strikethrough',
          underline: 'lex-text-underline',
          code: 'lex-text-code',
          subscript: 'lex-text-subscript',
          superscript: 'lex-text-superscript'
        },
        heading: {
          h1: 'lex-heading-h1',
          h2: 'lex-heading-h2',
          h3: 'lex-heading-h3'
        },
        list: {
          ul: 'lex-list-ul',
          ol: 'lex-list-ol',
          listitem: 'lex-list-item'
        },
        quote: 'lex-quote',
        codeblock: 'lex-codeblock',
        table: 'lex-table',
        tableAddColumns: 'lex-table-add-columns',
        tableAddRows: 'lex-table-add-rows',
        tableContentEditable: 'lex-table-cell-editable',
        tableCellHeader: 'lex-table-cell-header',
        tableCellResizer: 'lex-table-cell-resizer',
        tableCell: 'lex-table-cell',
        tableCellSortedIndicator: 'lex-table-sorted',
        tableRow: 'lex-table-row',
        tableSelection: 'lex-table-selection'
      }
    }, options.editorConfig || {});

    const lexicalEditor = lively.LexicalEditor.createEditor(editorRootElement, editorConfig);

    if (!lexicalEditor) {
      console.warn('LexEditor: Failed to initialize Lexical editor');
      return null;
    }

    // Create toolbar
    const toolbar = lively.LexicalToolbar.createToolbar(lexicalEditor, options.toolbarConfig);
    if (toolbar && toolbarPlaceholder) {
      toolbarPlaceholder.innerHTML = '';
      toolbarPlaceholder.appendChild(toolbar);
    }

    // Setup collaboration if requested
    if (options.collaborationEnabled) {
      const collabOptions = Object.extend({
        documentId: options.documentId || 'lexeditor-doc-' + Math.random().toString(36).substr(2, 9),
        userId: options.userId || 'user-' + Math.random().toString(36).substr(2, 9),
        userName: options.userName || 'Anonymous',
        userColor: options.userColor || '#' + Math.floor(Math.random()*16777215).toString(16),
        serverSync: options.serverSync !== false // enabled by default
      }, options.collaborationOptions || {});

      lively.LexicalCollaboration.setupCollaboration(lexicalEditor, collabOptions.documentId, collabOptions);
    }

    // Setup status bar updates
    lexicalEditor.getEditor().registerUpdateListener(function() {
      if (statusBar) {
        const state = lexicalEditor.getEditor().getEditorState();
        // Could update status bar here with character count, etc.
      }
    });

    // Return control interface
    return {
      editor: lexicalEditor,
      container: containerElement,
      editorRoot: editorRootElement,
      toolbar: toolbar,
      options: options,

      /**
       * Get editor state as JSON
       */
      getState: function() {
        return lexicalEditor.getStateAsJSON();
      },

      /**
       * Set editor state from JSON
       */
      setState: function(state) {
        return lexicalEditor.setStateFromJSON(state);
      },

      /**
       * Get plain text content
       */
      getText: function() {
        return lexicalEditor.getPlainText();
      },

      /**
       * Set plain text content
       */
      setText: function(text) {
        return lexicalEditor.setPlainText(text);
      },

      /**
       * Focus the editor
       */
      focus: function() {
        return lexicalEditor.focus();
      },

      /**
       * Blur the editor
       */
      blur: function() {
        return lexicalEditor.blur();
      },

      /**
       * Clear all content
       */
      clear: function() {
        return lexicalEditor.clear();
      },

      /**
       * Check if focused
       */
      isFocused: function() {
        return lexicalEditor.isFocused();
      },

      /**
       * Undo last change
       */
      undo: function() {
        return lexicalEditor.executeCommand('HISTORY_UNDO');
      },

      /**
       * Redo last undo
       */
      redo: function() {
        return lexicalEditor.executeCommand('HISTORY_REDO');
      },

      /**
       * Dispose of editor
       */
      dispose: function() {
        lexicalEditor.destroy();
        if (toolbar && toolbar.parentNode) {
          toolbar.parentNode.removeChild(toolbar);
        }
      }
    };
  },

  /**
   * Auto-initialize if called from PartsBin
   */
  onPartLoaded: function() {
    // This will be called automatically by Lively when the part is loaded
    const container = document.getElementById('lex-editor-container');
    if (container) {
      return this.initializeEditor(container, {
        collaborationEnabled: false, // Can be enabled via morphic object properties
        toolbarConfig: {}
      });
    }
  }

});

}); // end of module
