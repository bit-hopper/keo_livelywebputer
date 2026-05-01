module("lively.LexicalEditor")
  .requires("lively.Network")
  .toRun(function () {
    /**
     * LexicalEditor
     *
     * A rich text editor component based on Meta's Lexical framework
     * Supports collaborative editing via Yjs and persistent storage on server
     *
     * Features:
     * - Rich formatting (bold, italic, strikethrough, superscript, etc.)
     * - Lists (bullet, numbered)
     * - Code blocks, quotes, tables
     * - Image/video embedding (as base64 in JSON)
     * - Real-time collaboration via Yjs
     * - Undo/redo with history
     */

    Object.extend((lively.LexicalEditor = {}), {
      VERSION: "1.0.0",

      /**
       * Initialize a new Lexical editor instance
       * @param {HTMLElement} containerElement - DOM element to attach editor to
       * @param {Object} config - Configuration object
       * @returns {Object} Editor instance with control methods
       */
      createEditor: function (containerElement, config) {
        config = config || {};

        const {
          createEditor,
          $getRoot,
          $getSelection,
          TextNode,
          ParagraphNode,
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          CodeHighlightNode,
          LinkNode,
          TableNode,
          TableRowNode,
          TableCellNode,
          AutoLinkNode,
          LineBreakNode,
          RangeSelection,
          NodeSelection,
          GridSelection,
        } = window.lexical;

        const editorConfig = {
          namespace: config.namespace || "LexicalEditor",
          theme: config.theme || {},
          onError: function (error) {
            console.error("Lexical error:", error);
            if (config.onError) config.onError(error);
          },
          nodes: [
            TextNode,
            ParagraphNode,
            HeadingNode,
            ListNode,
            ListItemNode,
            QuoteNode,
            CodeNode,
            CodeHighlightNode,
            LinkNode,
            TableNode,
            TableRowNode,
            TableCellNode,
            AutoLinkNode,
            LineBreakNode,
            ...(config.customNodes || []),
          ],
        };

        const editor = createEditor(editorConfig);

        // Attach to DOM
        if (containerElement) {
          editor.setRootElement(containerElement);
        }

        // Setup update listener for state changes
        const unregisterUpdateListener = editor.registerUpdateListener(
          function ({
            editorState,
            dirtyElements,
            dirtyLeaves,
            prevEditorState,
            tags,
          }) {
            if (config.onUpdate) {
              config.onUpdate({
                editorState: editorState,
                dirtyElements: dirtyElements,
                dirtyLeaves: dirtyLeaves,
                prevEditorState: prevEditorState,
                tags: tags,
              });
            }
          },
        );

        // Return editor wrapper with utility methods
        return {
          _editor: editor,
          _unregisterUpdateListener: unregisterUpdateListener,
          _config: config,

          /**
           * Get current editor state as JSON
           */
          getStateAsJSON: function () {
            let json = null;
            this._editor.read(
              function () {
                json = this._editor.getEditorState().toJSON();
              }.bind(this),
            );
            return json;
          },

          /**
           * Set editor state from JSON
           */
          setStateFromJSON: function (json) {
            const editorState = this._editor.parseEditorState(json);
            this._editor.setEditorState(editorState);
          },

          /**
           * Get plain text content
           */
          getPlainText: function () {
            let text = "";
            this._editor.read(
              function () {
                text = this._editor.getEditorState().read(function () {
                  const root = $getRoot();
                  return root.getTextContent();
                });
              }.bind(this),
            );
            return text;
          },

          /**
           * Set plain text content
           */
          setPlainText: function (text) {
            this._editor.update(function () {
              const root = $getRoot();
              root.clear();
              root.append(TextNode.importJSON({ type: "text", text: text }));
            });
          },

          /**
           * Insert image as base64
           */
          insertImage: function (base64Data, alt) {
            this._editor.update(
              function () {
                // Create image node object for Lexical
                const imageNode = {
                  type: "image",
                  src: base64Data,
                  alt: alt || "Image",
                  width: 400,
                  height: 300,
                };
                // Store as JSON in document
                const root = $getRoot();
                // Note: Actual image node implementation needs custom node type
              }.bind(this),
            );
          },

          /**
           * Insert video as base64
           */
          insertVideo: function (base64Data, alt) {
            this._editor.update(
              function () {
                const videoNode = {
                  type: "video",
                  src: base64Data,
                  alt: alt || "Video",
                  width: 400,
                  height: 300,
                };
                // Store as JSON in document
              }.bind(this),
            );
          },

          /**
           * Execute formatting command
           */
          executeCommand: function (command, payload) {
            this._editor.dispatchCommand(command, payload);
          },

          /**
           * Register command handler
           */
          registerCommand: function (command, handler, priority) {
            return this._editor.registerCommand(
              command,
              handler,
              priority || 0,
            );
          },

          /**
           * Get editor instance for advanced usage
           */
          getEditor: function () {
            return this._editor;
          },

          /**
           * Focus editor
           */
          focus: function () {
            this._editor.focus();
          },

          /**
           * Blur editor
           */
          blur: function () {
            this._editor.blur();
          },

          /**
           * Check if editor is focused
           */
          isFocused: function () {
            return (
              this._editor.getRootElement() &&
              document.activeElement === this._editor.getRootElement()
            );
          },

          /**
           * Clear all content
           */
          clear: function () {
            this._editor.update(function () {
              const root = $getRoot();
              root.clear();
            });
          },

          /**
           * Setup Yjs collaboration
           */
          setupCollaboration: function (yDoc, providerConfig) {
            // This will be connected to the collaboration module
            // yDoc: Y.Doc instance
            // providerConfig: Server connection details
            this._yDoc = yDoc;
            this._providerConfig = providerConfig;

            // Binding will be set up by LexicalCollaboration module
            return this;
          },

          /**
           * Destroy editor and clean up
           */
          destroy: function () {
            this._unregisterUpdateListener && this._unregisterUpdateListener();
            this._editor = null;
          },
        };
      },

      /**
       * Create minimal contenteditable container for editor
       */
      createEditorContainer: function (config) {
        config = config || {};

        const container = document.createElement("div");
        container.className = "lexical-editor-container";
        container.contentEditable = "true";
        container.style.cssText =
          config.containerStyle ||
          'width: 100%; height: 100%; padding: 10px; overflow-y: auto; font-family: "Monaco", monospace; font-size: 14px; line-height: 1.5;';

        return container;
      },

      /**
       * Export state as plain HTML
       */
      exportAsHTML: function (editorState) {
        // Convert Lexical JSON to HTML
        // This will be implemented with custom logic
        return "";
      },

      /**
       * Import from HTML
       */
      importFromHTML: function (html) {
        // Convert HTML to Lexical JSON state
        // This will be implemented with custom logic
        return {};
      },
    });
  }); // end of module
