module("lively.LexicalCollaboration")
  .requires("lively.LexicalEditor", "lively.Network")
  .toRun(function () {
    /**
     * LexicalCollaboration
     *
     * Handles real-time collaborative editing using Yjs
     * Syncs editor state with Lively server for persistence
     * Supports multiple concurrent users
     */

    Object.extend((lively.LexicalCollaboration = {}), {
      /**
       * Setup collaboration for a Lexical editor
       * @param {Object} lexicalEditor - LexicalEditor instance
       * @param {String} documentId - Unique document identifier
       * @param {Object} options - Configuration options
       */
      setupCollaboration: function (lexicalEditor, documentId, options) {
        options = options || {};

        const Y = window.Y;
        if (!Y) {
          console.error("Yjs library not loaded");
          return null;
        }

        // Create Yjs document
        const yDoc = new Y.Doc();
        const yXmlFragment = yDoc.getXmlFragment("editor");

        // Create awareness for presence tracking
        const awareness = yDoc.awareness;
        const clientID = awareness.clientID;

        // Set user info (will include atproto DID later)
        awareness.setLocalState({
          user: {
            name: options.userName || "Anonymous",
            color:
              options.userColor ||
              "#" + Math.floor(Math.random() * 16777215).toString(16),
            clientID: clientID,
            timestamp: Date.now(),
          },
          cursor: null,
        });

        // Bind Lexical editor to Yjs
        const binding = this._createLexicalBinding(lexicalEditor, yXmlFragment);

        // Create collaboration state object
        const collaboration = {
          _yDoc: yDoc,
          _yXmlFragment: yXmlFragment,
          _awareness: awareness,
          _binding: binding,
          _documentId: documentId,
          _options: options,
          _syncServer: null,
          _isConnected: false,
          _pendingUpdates: [],

          /**
           * Connect to server for sync
           */
          connectToServer: function (serverConfig) {
            this._syncServer = {
              url:
                serverConfig.url ||
                "http://localhost:9001/nodejs/CollaborativeEditor/",
              documentId: this._documentId,
            };

            // Start syncing with server
            this._startServerSync();
            return this;
          },

          /**
           * Sync updates with server
           */
          _startServerSync: function () {
            if (!this._syncServer) return;

            // Periodically fetch updates from server
            const syncInterval = setInterval(
              function () {
                if (!this._syncServer) {
                  clearInterval(syncInterval);
                  return;
                }

                this._fetchUpdatesFromServer();
                this._pushUpdatesToServer();
              }.bind(this),
              options.syncInterval || 1000,
            );

            this._syncInterval = syncInterval;
          },

          /**
           * Fetch latest updates from server
           */
          _fetchUpdatesFromServer: function () {
            const url = new URL(this._syncServer.url + "fetch");
            url.search =
              "?docId=" +
              encodeURIComponent(this._documentId) +
              "&stateVector=" +
              encodeURIComponent(this._getStateVector());

            url
              .asWebResource()
              .beAsync()
              .withJSONWhenDone(
                function (result) {
                  if (result && result.updates) {
                    // Apply updates from server
                    const updates = result.updates.map(function (u) {
                      return new Uint8Array(
                        atob(u)
                          .split("")
                          .map(function (c) {
                            return c.charCodeAt(0);
                          }),
                      );
                    });

                    updates.forEach(
                      function (update) {
                        Y.applyUpdate(this._yDoc, update);
                      }.bind(this),
                    );
                  }
                }.bind(this),
              )
              .get();
          },

          /**
           * Push local updates to server
           */
          _pushUpdatesToServer: function () {
            if (this._pendingUpdates.length === 0) return;

            const updates = this._pendingUpdates;
            this._pendingUpdates = [];

            const url = new URL(this._syncServer.url + "sync");
            const updateData = {
              docId: this._documentId,
              clientID: this._awareness.clientID,
              updates: updates.map(function (u) {
                return btoa(String.fromCharCode.apply(null, new Uint8Array(u)));
              }),
              awareness: this._awareness.getLocalState(),
              timestamp: Date.now(),
            };

            url
              .asWebResource()
              .beAsync()
              .withJSONWhenDone(
                function (result) {
                  if (result.success) {
                    this._isConnected = true;
                    if (this._options.onSync) {
                      this._options.onSync(result);
                    }
                  }
                }.bind(this),
              )
              .post(JSON.stringify(updateData), "application/json");
          },

          /**
           * Get state vector for incremental syncing
           */
          _getStateVector: function () {
            const sv = Y.encodeStateVector(this._yDoc);
            return btoa(String.fromCharCode.apply(null, sv));
          },

          /**
           * Track local changes
           */
          _observeChanges: function () {
            this._yDoc.on(
              "update",
              function (update) {
                this._pendingUpdates.push(update);
                if (this._options.onChange) {
                  this._options.onChange(update);
                }
              }.bind(this),
            );
          },

          /**
           * Get connected users
           */
          getConnectedUsers: function () {
            const users = [];
            this._awareness.getStates().forEach(function (state) {
              if (state.user) {
                users.push(state.user);
              }
            });
            return users;
          },

          /**
           * Update local user presence
           */
          updateUserPresence: function (presence) {
            const state = this._awareness.getLocalState() || {};
            state.user = Object.extend(state.user || {}, presence);
            this._awareness.setLocalState(state);
          },

          /**
           * Get document state as JSON
           */
          getDocumentState: function () {
            return Y.encodeStateAsUpdate(this._yDoc);
          },

          /**
           * Disconnect from server
           */
          disconnect: function () {
            if (this._syncInterval) {
              clearInterval(this._syncInterval);
              this._syncInterval = null;
            }
            this._syncServer = null;
            this._isConnected = false;
            return this;
          },

          /**
           * Check connection status
           */
          isConnected: function () {
            return this._isConnected;
          },

          /**
           * Destroy collaboration
           */
          destroy: function () {
            this.disconnect();
            if (this._binding) {
              this._binding.destroy();
            }
            this._yDoc.destroy();
          },
        };

        // Start observing changes
        collaboration._observeChanges();

        return collaboration;
      },

      /**
       * Create binding between Lexical editor and Yjs
       */
      _createLexicalBinding: function (lexicalEditor, yXmlFragment) {
        // Create a simple binding that syncs editor state to Yjs
        const editor = lexicalEditor.getEditor();

        let isRemoteChange = false;

        // Listen for Yjs changes
        const yXmlObserver = function (event) {
          isRemoteChange = true;

          // When Yjs updates, we need to update the editor
          // This is a simplified approach - a full implementation would
          // do more granular node-by-node syncing

          // For now, we sync at the state level
          const editorState = lexicalEditor.getStateAsJSON();
          // Store in Yjs
          yXmlFragment.delete(0, yXmlFragment.length);
          yXmlFragment.insert(0, [new yxml.Element("editor-state")]);

          isRemoteChange = false;
        };

        yXmlFragment.observe(yXmlObserver);

        // Listen for editor changes and update Yjs
        const unregisterUpdateListener = editor.registerUpdateListener(
          function ({ editorState }) {
            if (isRemoteChange) return;

            // Convert editor state to base64 for storage
            const stateJSON = editorState.toJSON();
            const stateStr = JSON.stringify(stateJSON);
            const stateB64 = btoa(stateStr);

            // Update Yjs document
            yXmlFragment.delete(0, yXmlFragment.length);
            yXmlFragment.insert(0, [new yxml.Text(stateB64)]);
          },
        );

        return {
          destroy: function () {
            yXmlFragment.unobserve(yXmlObserver);
            unregisterUpdateListener && unregisterUpdateListener();
          },
        };
      },

      /**
       * Load document from server
       */
      loadDocumentFromServer: function (documentId, callback) {
        const url = new URL(
          "http://localhost:9001/nodejs/CollaborativeEditor/load",
        );
        url.search = "?docId=" + encodeURIComponent(documentId);

        url
          .asWebResource()
          .beAsync()
          .withJSONWhenDone(function (result) {
            if (result && result.state) {
              // Decode state
              const stateStr = atob(result.state);
              const state = JSON.parse(stateStr);
              callback(null, state);
            } else {
              callback(result ? result.error : "Unknown error", null);
            }
          })
          .get();
      },

      /**
       * Save document to server
       */
      saveDocumentToServer: function (documentId, state, callback) {
        const url = new URL(
          "http://localhost:9001/nodejs/CollaborativeEditor/save",
        );

        const data = {
          docId: documentId,
          state: btoa(JSON.stringify(state)),
          timestamp: Date.now(),
        };

        url
          .asWebResource()
          .beAsync()
          .withJSONWhenDone(function (result) {
            if (callback) {
              callback(result.error, result.success);
            }
          })
          .post(JSON.stringify(data), "application/json");
      },
    });
  }); // end of module
