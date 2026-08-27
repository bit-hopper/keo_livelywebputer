/*global require, process, __dirname*/

// Must be set before Node's threadpool does any work (i.e. before requiring
// anything that makes an async fs.* call) -- the default of 4 threads gets
// saturated by OptimizedLoadingServer.js's combined-bundle computation
// (~130 concurrent fs.promises calls per run via prepareFileForConcat's
// Promise.all), queuing any unrelated fs-bound request behind it for the
// duration. Measured live 2026-08-27: 1 of 30 unrelated static-file
// requests fired during a ~1.15s computation queued for ~1.08s instead of
// its normal ~20ms.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || "16";

var path = require("path"),
  fs = require("fs"),
  exec = require("child_process").exec,
  cluster = require("cluster"),
  os = require("os"),
  checkNPMPackages = require("./helper/check-modules"),
  env = require("./env"),
  args = require("./helper/args");

/*
 * This script starts up a node.js server for lively. The server itself is
 * implemented in the life_star module.
 * Note that we check node_module dependencies in this script (comparing the
 * package.json and node_modules folder). When you edit this script please keep
 * in mind that we cannot rely on external modules being available Until this
 * has happened!
 */

// -=-=-=-=-=-=-=-=-=-=-
// script options
// -=-=-=-=-=-=-=-=-=-=-
var options = args.options(
  [
    ["-h", "--help", "Show this help."],
    ["-p", "--port NUMBER", "On which port to run, default is 9001."],
    ["--host STRING", "Hostname, default is localhost."],
    [
      "--log-level STRING",
      "Log level, accepted values: error, warning, info, debug.",
    ],
    [
      "--lk-dir DIR",
      "The directory of the Lively Kernel core repository (git).",
    ],
    [
      "--no-version-control",
      "Don't version objects and files, this overrides --db-config.",
    ],
    [
      "--db-config JSON",
      "Stringified JSON object that configures the object DB and lively-davfs\n" +
        "                                 like {\n" +
        "                                   includedFiles: [STRING],\n" +
        "                                   excludedDirectories: [STRING],\n" +
        "                                   excludedFiles: [STRING],\n" +
        "                                   dbFile: [STRING], -- path to db file\n" +
        "                                   resetDatabase: [BOOL]\n" +
        "                                 }",
    ],
    [
      "--behind-proxy",
      "Add this option if requests going to the server are " +
        "proxied by another server, e.g. Apache",
    ],
    ["--enable-ssl", "Enable https server."],
    [
      "--enable-ssl-client-auth",
      "Whether to use authentication via SSL client certificate.",
    ],
    ["--ssl-server-key FILE", "Where the server key is located."],
    ["--ssl-server-cert FILE", "Where the server certificate is located."],
    ["--ssl-ca-cert FILE", "Where the CA certificate is located."],
    [
      "--info",
      "Print whether there is a running server on " +
        "the specified port or " +
        env.LIFE_STAR_PORT +
        " and the process pid.",
    ],
    [
      "--kill",
      "Stop the server process for the specified port or " +
        env.LIFE_STAR_PORT +
        " if there exist one.",
    ],
    [
      "--no-subservers",
      "By default servers in " +
        env.WORKSPACE_LK +
        " are started with the core server. Setting this option" +
        " disables this behavior.",
    ],
    [
      "--exclude-subserver STRING",
      "Exclude a subserver from being started, comma separated string.",
    ],
    [
      "--subserver STRING",
      "Add a subserver, expects filesystem path to js file like " +
        '"foo/bar.js" to start subserver bar. Aliasing supported via ' +
        '"baz:foo/bar.js" to start subserver bar.js as baz.',
    ],
    [
      "--use-manifest",
      "Enables the creation of manifest file for application cache.",
    ],
    [
      "--no-partsbin-check",
      "Don't check for PartsBin existance and update the PartsBin.",
    ],
    ["--install-missing-npm-packages", "Automatically install npm packages?"],
    [
      "--workers NUMBER",
      "Number of cluster worker processes to fork for handling requests.\n" +
        "                                 Default is 1 (no clustering, same as before this option existed).\n" +
        "                                 Pass a number, or \"auto\" to use one worker per CPU core.\n" +
        "                                 WARNING: realtime/collaborative features (Yjs canvas sync,\n" +
        "                                 the L2L session tracker, WebRTC room signaling) keep their\n" +
        "                                 state in each worker's own process memory with no cross-worker\n" +
        "                                 sharing yet -- two users land on the same worker only by chance,\n" +
        "                                 so clustering can silently break realtime sync between them until\n" +
        "                                 that state moves to a shared backplane (see DeployCheckList.md).",
    ],
  ],
  {},
  "Starts a Lively Kernel server.",
);

var port = options.port || env.LIFE_STAR_PORT,
  host = options.host || env.LIFE_STAR_HOST,
  subservers = {};

if (!options.lkDir && env.WORKSPACE_LK_EXISTS) {
  options.lkDir = env.WORKSPACE_LK || path.resolve(__dirname, "..");
} else {
  env.WORKSPACE_LK = options.lkDir;
}

if (!options.lkDir) {
  console.log(
    "Cannot find the Lively core repository. " +
      "Please start the server with --lk-dir PATH/TO/LK-REPO",
  );
}

var dbConfig;
if (options.defined("dbConfig")) {
  dbConfig = options.dbConfig;
}

if (options.defined("noVersionControl")) {
  dbConfig = JSON.stringify({ enableVersioning: false });
}

if (!dbConfig) {
  // Default configuration with API path exclusions for OAuth, Identity, and AT Protocol
  dbConfig = JSON.stringify({
    enableVersioning: true,
    excludePaths: [
      "/api/", // All API endpoints
      "/xrpc/", // AT Protocol xRPC endpoints
      "/service/", // Service endpoints
      "/.well-known/", // Well-known endpoints
    ],
  });
}

if (!options.defined("noSubservers")) {
  var excluded = options.defined("excludeSubserver")
    ? options.excludeSubserver.split(",")
    : [];
  var lkSubserverDir = path.join(options.lkDir, "core/servers");
  try {
    var fileList = fs.readdirSync(lkSubserverDir);
    fileList.forEach(function (name) {
      if (!name.match(/.js$/)) return;
      if (excluded.indexOf(name) !== -1) return;
      subservers[name.slice(0, -3)] = path.join(lkSubserverDir, name);
    });
  } catch (e) {
    console.warn("Problems finding subservers in %s: %s", lkSubserverDir, e);
  }
}

if (!options.defined("noSubservers") && options.defined("subserver")) {
  // read multiple --subserver STRING args
  // STRING can be name:path or just path
  for (var i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--subserver") continue;
    var spec = process.argv[i + 1];
    if (!spec) continue;
    var nameAndPath = spec.split(":"),
      name,
      file;
    if (nameAndPath.length === 2) {
      name = nameAndPath[0];
      file = nameAndPath[1];
    } else {
      file = nameAndPath[0];
      name = file.substring(file.lastIndexOf("/") + 1, file.lastIndexOf("."));
    }
    subservers[name] = file;
  }
}

// -=-=-=-=-=-=-=-=-=-=-=-
// Dealing with processes
// -=-=-=-=-=-=-=-=-=-=-=-
var pidFile = path.join(env.SERVER_PID_DIR, "server." + port + ".pid");

function removePidFile() {
  try {
    fs.unlink(pidFile);
  } catch (e) {}
}

function writePid(proc, callback) {
  if (!proc.pid) {
    callback();
    return;
  }
  function writePID() {
    fs.writeFile(pidFile, String(proc.pid), callback);
  }
  fs.exists(env.SERVER_PID_DIR, function (exists) {
    if (exists) {
      writePID();
      return;
    }
    fs.mkdir(env.SERVER_PID_DIR, function (err) {
      if (err) callback(err);
      else writePID();
    });
  });
}

function readPid(callback) {
  fs.readFile(pidFile, function (err, data) {
    callback(null, data);
  });
}

function isPidInOutput(pid, out, callback) {
  var lines = out.split("\n"),
    regexp = new RegExp(pid),
    result = lines.some(function (line) {
      return regexp.test(line);
    });
  callback(null, result, pid);
}

function processExists(pid, callback) {
  if (!pid || !pid.length) {
    callback({ err: "No pid" });
    return;
  }
  var isWindows = /^win/i.test(process.platform),
    cmd = isWindows ? "tasklist.exe" : "ps -A";
  exec(cmd, {}, function (code, out, err) {
    isPidInOutput(pid, out || "", callback);
  });
}

function getServerInfo(callback) {
  readPid(function (err, pid) {
    if (err) {
      callback(err);
      return;
    }
    processExists(pid, function (err, isAlive) {
      callback(null, { alive: err ? false : isAlive, pid: String(pid) });
    });
  });
}

function killOldServer(infoAboutOldServer, callback) {
  if (infoAboutOldServer.alive) {
    console.log(
      "Stopping lk server process with pid " + infoAboutOldServer.pid,
    );
    try {
      process.kill(infoAboutOldServer.pid);
    } catch (e) {}
  }
  callback();
}

function downloadPartsBin(thenDo) {
  if (options.defined("noPartsbinCheck")) thenDo();
  else
    require("./helper/download-partsbin.js")(function (err) {
      if (err) {
        console.error("Error downloading PartsBin: %s", err);
        console.log("Proceeding without PartsBin...");
      }
      thenDo();
    });
}

function startServer(callback) {
  // life_star only actually turns on HTTPS when sslServerKey, sslServerCert,
  // AND sslCACert are all present (it ANDs all three together internally) --
  // sslCACert is only ever used for optional client-cert auth, but its file
  // still has to exist or that AND short-circuits to false and life_star
  // silently falls back to plain http. Default it to the server cert (a
  // self-signed leaf is a fine no-op "CA" when client-cert auth is off) so
  // --enable-ssl works with just a key and a cert, as its help text implies.
  var sslServerKey = options.defined("enableSsl") ? options.sslServerKey : null,
    sslServerCert = options.defined("enableSsl") ? options.sslServerCert : null,
    sslCACert = options.defined("enableSsl")
      ? options.sslCaCert || options.sslServerCert
      : null,
    sslActuallyEnabled = options.defined("enableSsl") && !!sslServerKey && !!sslServerCert && !!sslCACert;

  require("life_star")({
    host: host,
    port: port,
    fsNode: options.lkDir, // LivelyKernel directory to serve from
    dbConf: dbConfig, // lively-davfs
    enableTesting: env.LIFE_STAR_TESTING === "testing",
    logLevel: options.logLevel || env.LIFE_STAR_LOG_LEVEL, // log level for logger: error, warning, info, debug
    behindProxy: options.defined("behindProxy"),
    subservers: subservers || null,
    useManifestCaching: options.defined("useManifest"),
    enableSSL: options.defined("enableSsl"),
    enableSSLClientAuth: options.defined("enableSsl")
      ? options.defined("enableSslClientAuth")
      : false,
    sslServerKey: sslServerKey,
    sslServerCert: sslServerCert,
    sslCACert: sslCACert,
  });
  if (options.defined("enableSsl") && !sslActuallyEnabled) {
    console.error(
      "--enable-ssl was passed but --ssl-server-key/--ssl-server-cert " +
        "are missing -- falling back to plain http.",
    );
  }
  console.log(
    "Server with pid %s is now running at %s://%s:%s",
    process.pid,
    sslActuallyEnabled ? "https" : "http",
    host,
    port,
  );
  console.log("Serving files from " + options.lkDir);
  callback(null, process);
}

function loadNodejsLively(thenDo) {
  require("lively-loader").withLivelyNamespaceDo(function (err, lively) {
    if (lively) global.lively = lively;
    thenDo(err);
  });
}

// -=-=-=-=-=-=-=-=-=-
// Cluster worker count
// -=-=-=-=-=-=-=-=-=-
// Opt-in, defaulting to 1 (today's exact single-process behavior) so local
// dev usage is unaffected -- pass --workers N or --workers auto (one per
// CPU core) to actually cluster. See the --workers help text above for the
// realtime-state caveat this carries.
function numWorkersRequested() {
  if (options.defined("workers")) {
    return options.workers === "auto"
      ? os.cpus().length
      : Math.max(1, parseInt(options.workers, 10) || 1);
  }
  if (process.env.WEB_CONCURRENCY) {
    return Math.max(1, parseInt(process.env.WEB_CONCURRENCY, 10) || 1);
  }
  return 1;
}

// A forked cluster worker re-runs this entire script from the top (that's
// how Node's cluster module works) -- all the option/config parsing above
// is pure and safe to redo, but the one-time setup below (PartsBin
// download, killing any previous server on this port, writing the pid
// file) must only happen once, in the primary, before any workers exist.
// A worker just loads Lively and starts serving; the primary handles
// everything else and, when clustering, never calls startServer itself.
function launchServer() {
  var numWorkers = numWorkersRequested();

  if (numWorkers <= 1) {
    require("async").waterfall(
      [loadNodejsLively, startServer, writePid],
      function (err) {
        if (err) console.error("Error starting Lively server: %s", err);
        else console.log("Lively server starting...");
      },
    );
    return;
  }

  console.log(
    "Clustering across %d worker processes (pid %s is the primary)",
    numWorkers,
    process.pid,
  );

  writePid(process, function (err) {
    if (err) console.error("Error writing pid file: %s", err);
  });

  var shuttingDown = false;
  function shutdownWorkers(signal) {
    shuttingDown = true;
    Object.keys(cluster.workers).forEach(function (id) {
      try {
        cluster.workers[id].process.kill(signal);
      } catch (e) {}
    });
  }
  process.on("SIGTERM", function () {
    shutdownWorkers("SIGTERM");
    process.exit(0);
  });
  process.on("SIGINT", function () {
    shutdownWorkers("SIGINT");
    process.exit(0);
  });

  for (var i = 0; i < numWorkers; i++) cluster.fork();

  cluster.on("exit", function (worker, code, signal) {
    if (shuttingDown) return;
    console.error(
      "Worker %d died (code %s, signal %s) -- forking a replacement",
      worker.process.pid,
      code,
      signal,
    );
    cluster.fork();
  });
}

// -=-=-=-=-=-=-=-=-=-=-=-=-
// This is where we do stuff
// -=-=-=-=-=-=-=-=-=-=-=-=-

if (!cluster.isPrimary) {
  // Forked cluster worker.
  require("async").waterfall([loadNodejsLively, startServer], function (err) {
    if (err)
      console.error(
        "Worker %d error starting Lively server: %s",
        process.pid,
        err,
      );
  });
} else if (options.defined("info")) {
  getServerInfo(function (err, info) {
    console.log(info ? JSON.stringify(info) : "{}");
  });
} else if (options.defined("kill")) {
  var onError = function (err) {
    console.error("Error stopping server: %s", err);
  };
  getServerInfo(function (err, serverInfo) {
    if (err) onError(err);
    else
      killOldServer(serverInfo, function (err) {
        if (err) onError(err);
        else console.log("server stopped %s", serverInfo);
      });
  });
} else {
  var run = function () {
    require("async").waterfall(
      [
        downloadPartsBin,
        getServerInfo,
        killOldServer, // Ensure that only one server for the given port is running
      ],
      function (err) {
        if (err) {
          console.error("Error starting Lively server: %s", err);
          return;
        }
        launchServer();
      },
    );
  };

  // let it fly!
  if (options.defined("installMissingNpmPackages")) {
    checkNPMPackages(function (err) {
      if (err) {
        console.error("error on server start: %s", err);
        return;
      }
      run();
    });
  } else {
    run();
  }
}
