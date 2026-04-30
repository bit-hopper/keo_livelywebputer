module('lively.LexicalToolbar')
  .requires('lively.LexicalEditor')
  .toRun(function() {

/**
 * LexicalToolbar
 * 
 * Toolbar for Lexical editor with formatting commands
 * Supports: bold, italic, strikethrough, superscript, headings, lists,
 *           quotes, code blocks, links, images, videos, tables, spoilers
 */

Object.extend(lively.LexicalToolbar = {}, {

  /**
   * Create a formatting toolbar for Lexical editor
   */
  createToolbar: function(lexicalEditor, options) {
    options = options || {};

    const toolbar = document.createElement('div');
    toolbar.className = 'lexical-toolbar';
    toolbar.style.cssText = options.toolbarStyle || this._getDefaultToolbarStyle();

    const editor = lexicalEditor.getEditor();
    const buttons = [];

    // Text formatting buttons
    const formatButtons = [
      { id: 'bold', label: '𝐁', title: 'Bold (Ctrl+B)', command: 'TOGGLE_BOLD', hotkey: 'Ctrl-B' },
      { id: 'italic', label: '𝘐', title: 'Italic (Ctrl+I)', command: 'TOGGLE_ITALIC', hotkey: 'Ctrl-I' },
      { id: 'strikethrough', label: '⎯S', title: 'Strikethrough', command: 'TOGGLE_STRIKETHROUGH' },
      { id: 'superscript', label: 'ˢᵘᵖ', title: 'Superscript', command: 'TOGGLE_SUPERSCRIPT' },
      { id: 'code', label: '&lt;/&gt;', title: 'Code', command: 'TOGGLE_CODE' }
    ];

    const headingButtons = [
      { id: 'h1', label: 'H1', title: 'Heading 1', command: 'TOGGLE_HEADING', arg: 'h1' },
      { id: 'h2', label: 'H2', title: 'Heading 2', command: 'TOGGLE_HEADING', arg: 'h2' },
      { id: 'h3', label: 'H3', title: 'Heading 3', command: 'TOGGLE_HEADING', arg: 'h3' }
    ];

    const listButtons = [
      { id: 'bullet', label: '• List', title: 'Bullet List', command: 'TOGGLE_BULLET_LIST' },
      { id: 'numbered', label: '1. List', title: 'Numbered List', command: 'TOGGLE_NUMBERED_LIST' }
    ];

    const blockButtons = [
      { id: 'quote', label: '"', title: 'Quote', command: 'TOGGLE_QUOTE' },
      { id: 'codeblock', label: '{Code}', title: 'Code Block', command: 'TOGGLE_CODE_BLOCK' },
      { id: 'table', label: '⊞', title: 'Table', command: 'INSERT_TABLE' }
    ];

    const mediaButtons = [
      { id: 'link', label: '🔗', title: 'Link', action: 'insertLink', needsInput: true },
      { id: 'image', label: '🖼', title: 'Image', action: 'insertImage', needsFile: true },
      { id: 'video', label: '▶', title: 'Video', action: 'insertVideo', needsFile: true }
    ];

    const specialButtons = [
      { id: 'spoiler', label: '⚠ Spoiler', title: 'Spoiler Tag', action: 'insertSpoiler' }
    ];

    const utilityButtons = [
      { id: 'undo', label: '↶', title: 'Undo', command: 'HISTORY_UNDO' },
      { id: 'redo', label: '↷', title: 'Redo', command: 'HISTORY_REDO' },
      { id: 'clear', label: '✕', title: 'Clear', action: 'clearEditor' }
    ];

    // Add button groups
    const groups = [
      { buttons: formatButtons, name: 'formatting' },
      { buttons: headingButtons, name: 'headings' },
      { buttons: listButtons, name: 'lists' },
      { buttons: blockButtons, name: 'blocks' },
      { buttons: mediaButtons, name: 'media' },
      { buttons: specialButtons, name: 'special' },
      { buttons: utilityButtons, name: 'utility' }
    ];

    groups.forEach(function(group) {
      if (group.buttons.length === 0) return;

      const groupDiv = document.createElement('div');
      groupDiv.className = 'toolbar-group toolbar-' + group.name;
      groupDiv.style.cssText = 'display: inline-block; margin-right: 8px; padding: 0 4px; border-right: 1px solid #ccc;';

      group.buttons.forEach(function(btnConfig) {
        const btn = this._createButton(btnConfig, lexicalEditor);
        groupDiv.appendChild(btn);
        buttons.push(btn);
      }.bind(this));

      toolbar.appendChild(groupDiv);
    }.bind(this));

    // Store button references for state management
    toolbar._buttons = buttons;
    toolbar._editor = editor;
    toolbar._lexicalEditor = lexicalEditor;

    // Update button states on editor updates
    editor.registerUpdateListener(function() {
      this._updateButtonStates(toolbar);
    }.bind(this));

    return toolbar;
  },

  /**
   * Create individual toolbar button
   */
  _createButton: function(config, lexicalEditor) {
    const btn = document.createElement('button');
    btn.id = config.id;
    btn.innerHTML = config.label;
    btn.title = config.title;
    btn.className = 'toolbar-button toolbar-' + config.id;
    btn.style.cssText = 'padding: 6px 8px; margin: 2px; background: #f0f0f0; border: 1px solid #999; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;';
    btn._config = config;
    btn._active = false;

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      
      if (config.command) {
        // Execute Lexical command
        lexicalEditor.executeCommand(config.command, config.arg || null);
      } else if (config.action) {
        // Execute action
        this._executeAction(config.action, lexicalEditor, config);
      }
    }.bind(this));

    btn.addEventListener('mousedown', function(e) {
      e.preventDefault(); // Prevent blur
    });

    return btn;
  },

  /**
   * Execute toolbar action
   */
  _executeAction: function(action, lexicalEditor, config) {
    switch (action) {
      case 'insertLink':
        this._promptForLink(lexicalEditor);
        break;
      case 'insertImage':
        this._promptForImage(lexicalEditor);
        break;
      case 'insertVideo':
        this._promptForVideo(lexicalEditor);
        break;
      case 'insertSpoiler':
        this._insertSpoiler(lexicalEditor);
        break;
      case 'clearEditor':
        lexicalEditor.clear();
        break;
    }
  },

  /**
   * Prompt for link input
   */
  _promptForLink: function(lexicalEditor) {
    const url = prompt('Enter URL:');
    if (url) {
      lexicalEditor.getEditor().update(function() {
        const selection = $getSelection();
        if (selection) {
          const linkNode = {
            type: 'link',
            url: url,
            target: '_blank'
          };
          // Would create actual link node here
        }
      });
    }
  },

  /**
   * Prompt for image file
   */
  _promptForImage: function(lexicalEditor) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    
    input.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (file) {
        this._readFileAsBase64(file, function(base64) {
          lexicalEditor.insertImage(base64, file.name);
        }.bind(this));
      }
    }.bind(this));
    
    input.click();
  },

  /**
   * Prompt for video file
   */
  _promptForVideo: function(lexicalEditor) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    
    input.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (file) {
        this._readFileAsBase64(file, function(base64) {
          lexicalEditor.insertVideo(base64, file.name);
        }.bind(this));
      }
    }.bind(this));
    
    input.click();
  },

  /**
   * Insert spoiler/hidden text
   */
  _insertSpoiler: function(lexicalEditor) {
    // Would implement spoiler node insertion
    console.log('Spoiler insertion not yet implemented');
  },

  /**
   * Read file as base64
   */
  _readFileAsBase64: function(file, callback) {
    const reader = new FileReader();
    reader.onload = function(e) {
      callback(e.target.result);
    };
    reader.readAsDataURL(file);
  },

  /**
   * Update button states based on current selection
   */
  _updateButtonStates: function(toolbar) {
    // Check which formatting is active and update button appearance
    toolbar._buttons.forEach(function(btn) {
      btn.style.background = btn._active ? '#d0d0d0' : '#f0f0f0';
      btn.style.borderWidth = btn._active ? '2px' : '1px';
    });
  },

  /**
   * Get default toolbar styling
   */
  _getDefaultToolbarStyle: function() {
    return 'background: #fafafa; padding: 8px; border-bottom: 1px solid #ddd; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; user-select: none;';
  }

});

}); // end of module
