var dir  = process.env.WORKSPACE_LK,
    pty;

try { pty = require('node-pty'); } catch (e) {
    console.warn('PtyServer: node-pty is not installed, pty-backed terminals are unavailable. Run "npm install" (inside WSL, where the server runs) to enable.');
}

/*
 * default env settings for spawned pty processes, same shape as CommandLineServer.js
 */
var env = {
    __proto__: process.env,
    SHELL: '/bin/bash',
    TERM: 'xterm-256color'
};

/*
 * live pty sessions, keyed by the pty process's own pid (mirrors
 * CommandLineServer.js's shellCommands/findShellCommand bookkeeping)
 */
var ptySessions = global.ptySessions = [];
function findPtySession(id) {
    for (var i = 0; i < ptySessions.length; i++) {
        if (ptySessions[i].id === id) return ptySessions[i];
    }
    return null;
}

var ptyServices = {

    startPtyCommand: function(sessionServer, connection, msg) {
        function answer(hasMore, data) {
            connection.send({
                expectMoreResponses: hasMore,
                action: msg.action + 'Result',
                inResponseTo: msg.messageId, data: data});
        }

        if (!pty) { answer(false, {error: 'node-pty not installed on server'}); return; }

        var opts = msg.data || {};
        var commandEnv = opts.env || {};
        commandEnv.__proto__ = env;

        var ptyProcess;
        try {
            ptyProcess = pty.spawn(opts.shell || env.SHELL, [], {
                name: 'xterm-256color',
                cols: opts.cols || 80,
                rows: opts.rows || 24,
                cwd: opts.cwd || dir,
                env: commandEnv
            });
        } catch (e) {
            answer(false, {error: 'Error spawning pty: ' + e});
            return;
        }

        var session = {id: String(ptyProcess.pid), ptyProcess: ptyProcess};
        ptySessions.push(session);
        answer(true, {id: session.id, pid: ptyProcess.pid});

        ptyProcess.onData(function(data) { answer(true, {data: data}); });
        ptyProcess.onExit(function(e) {
            answer(false, {exitCode: e.exitCode, signal: e.signal});
            ptySessions = global.ptySessions = ptySessions.filter(function(s) { return s !== session; });
        });
    },

    ptyInput: function(sessionServer, connection, msg) {
        function answer(data) {
            connection.send({action: msg.action + 'Result', inResponseTo: msg.messageId, data: data});
        }
        var session = findPtySession(msg.data && msg.data.id);
        if (!session) { answer({error: 'pty session not found'}); return; }
        session.ptyProcess.write(msg.data.data || '');
        answer({ok: true});
    },

    ptyResize: function(sessionServer, connection, msg) {
        function answer(data) {
            connection.send({action: msg.action + 'Result', inResponseTo: msg.messageId, data: data});
        }
        var session = findPtySession(msg.data && msg.data.id);
        if (!session) { answer({error: 'pty session not found'}); return; }
        try { session.ptyProcess.resize(msg.data.cols, msg.data.rows); } catch (e) { /* pty may have just exited */ }
        answer({ok: true});
    },

    stopPtyCommand: function(sessionServer, connection, msg) {
        function answer(data) {
            connection.send({action: msg.action + 'Result', inResponseTo: msg.messageId, data: data});
        }
        var session = findPtySession(msg.data && msg.data.id);
        if (!session) { answer({ok: false, error: 'pty session not found'}); return; }
        session.ptyProcess.kill(msg.data.signal || 'SIGHUP');
        answer({ok: true});
    }
};

var services = require("./LivelyServices").services;
Object.assign(services, ptyServices);

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

module.exports = function(route, app) {
    app.get(route, function(req, res) {
        res.json({platform: process.platform, ptyAvailable: !!pty, activeSessions: ptySessions.length});
    });
};

module.exports.ptySessions = ptySessions;
