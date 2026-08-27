/*global require, process, __dirname*/
/*global require, process, __dirname*/

var path = require("path"),
  util = require("util"),
  fs = require("fs"),
  zlib = require("zlib"),
  crypto = require("crypto"),
  lang = require("lively.lang"),
  rootDir = process.env.WORKSPACE_LK || path.resolve(__dirname, "../.."),
  relWorkDir = ".optimized-loading-cache",
  workDir = path.join(rootDir, relWorkDir),
  combinedFile = path.join(workDir, "combined.js"),
  combinedHashFile = path.join(workDir, "combined.js.hash"),
  _combinedFileAndHashCached = null,
  _combinedFileAndHashCachedTimeout = 1000, /*ms*/
  _concat = null,
  _babel = null,
  // In-process caches, keyed by absolute file path, populated across the
  // life of the server (not per-request/per-computation). Every
  // combinedFileAndHash() call re-walks the same ~130 core files even when
  // nothing changed; without these, that costs 5+ fs.promises calls per
  // file in prepareFileForConcat plus a full-content readFile per file in
  // spliceInDependencies -- 700+ real filesystem round trips on every
  // cache-miss, measured live to matter a lot on this repo's WSL/9p-mounted
  // filesystem. With these, an unchanged file costs exactly one stat() to
  // confirm its mtime hasn't moved; deliberately not fs.watch-based --
  // inotify is known-unreliable on 9p mounts, and a watch that silently
  // stops firing would be a worse, harder-to-notice bug than paying for a
  // stat() every time.
  _mtimeCache = new Map(), // fullFilePath -> last-confirmed-valid mtime string
  _depsCache = new Map(); // absolute core file path -> { mtime, deps: [absolute file paths] }

// source-map-concat and (especially) babel-core are only needed once we
// actually rebuild combined.js, deep inside the async chain below -- not at
// module load time. babel-core alone has a large enough dependency tree that
// requiring it eagerly here added ~8s to every server boot (measured on this
// repo's WSL/9p-mounted filesystem), blocking this subserver's own
// require() and, with it, every later subserver waiting behind it in the
// startup loop. Requiring lazily on first actual use lets that cost happen
// off the boot-critical path instead.
function concatModule() {
  return _concat || (_concat = require("source-map-concat"));
}
function babelModule() {
  return _babel || (_babel = require("babel-core"));
}

function fileExists(file) {
  return fs.promises.access(file, fs.constants.F_OK).then(
    () => true,
    () => false,
  );
}

function transformFileAsync(file, opts) {
  return new Promise((resolve, reject) => {
    babelModule().transformFile(file, opts, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

(function onStartup() {
  if (typeof lively === "undefined" || !lively.Config) {
    console.log(
      "lively.Config not yet initialized, skipping optimized-loading-cache initialization",
    );
    return;
  }
  combinedFileAndHash()
    .then(() => console.log("optimized-loading-cache initialized"))
    .catch((err) =>
      console.error("optimized-loading-cache initialization errored", err),
    );
})();

function combinedFileAndHashCached() {
  // for fast subsequent requests cache the hash / combined result.
  // combinedFileAndHashCached().then(x => console.log(x)).catch(err => console.error(err))
  //
  // This caches the *in-flight promise itself*, not just its resolved value,
  // and stores it immediately (before the computation has even started)
  // rather than after it resolves. combinedFileAndHash() takes ~2s+ on a
  // cache miss; storing only the resolved value meant every request that
  // arrived while a computation was still in flight started its own
  // independent recomputation instead of sharing this one -- under real
  // concurrent traffic this single-threaded server was doing N redundant
  // ~2s blocking-ish walks at once instead of one. Sharing the promise
  // makes concurrent requests true single-flight.
  if (typeof Config !== "undefined" && !Config.optimizedLoading)
    return Promise.reject("Optimized loading not enabled");
  if (_combinedFileAndHashCached) return _combinedFileAndHashCached;

  var promise = combinedFileAndHash();
  _combinedFileAndHashCached = promise;
  promise.then(
    () => {
      // keep serving the resolved promise for a short window, then let the
      // next request trigger a fresh computation (picks up on-disk changes).
      setTimeout(() => {
        if (_combinedFileAndHashCached === promise)
          _combinedFileAndHashCached = null;
      }, _combinedFileAndHashCachedTimeout);
    },
    () => {
      // don't cache a failure -- let the very next request retry fresh.
      if (_combinedFileAndHashCached === promise)
        _combinedFileAndHashCached = null;
    },
  );
  return promise;
}

function combinedFileAndHash() {
  // The main function. Creates a cache directory, computes the "core files",
  // processes them to be es5 compatible, concats them into one combined.js file,
  // computes hash for that file (used as etag for HTTP requests)

  // require("child_process").exec("rm " + workDir + "/*")
  // require("child_process").exec("rm -rf $WORKSPACE_LK/.optimized-loading-cache/node_modules_lively.lang_lib_promise.js*")
  // require("child_process").exec("rm -rf $WORKSPACE_LK/.optimized-loading-cache/combined.js*")
  // require("child_process").exec("rm -rf $WORKSPACE_LK/.optimized-loading-cache/*")
  // combinedFileAndHash().then(x => console.log(x)).catch(err => console.error(err))
  return coreFiles(process.env.WORKSPACE_LK).then((files) => lang.promise.chain([
    () =>
      lang
        .promise(fs.mkdir)(workDir)
        .catch((_) => {}),
    () => concatAndWrite(files, rootDir, workDir, combinedFile, new Date()),
    (concatResult) =>
      concatResult.wasChanged
        ? computeHash(combinedFile)
        : fs.promises.readFile(combinedHashFile).then(String),
    (hash) => ({ hash: hash, file: combinedFile }),
  ]));
}

async function prepareFileForConcat(rootDir, cacheDir, file) {
  // es5 translation of core files, stores into cache dir

  // prepareFileForConcat(rootDir, workDir, files[1]).then((arg) => console.log(arg))

  // Was fs.existsSync/statSync/readFileSync/writeFileSync throughout -- this
  // per-file mtime-check-and-maybe-transpile runs for every core file (100+)
  // on every combined-bundle computation, so the sync calls here blocked the
  // Node event loop for the whole server on every cache-miss request. Now
  // fs.promises equivalents so the walk interleaves with everything else.
  var babelExceptions = ["core/lib/lively-libs-debug.js"],
    fullFilePath = path.join(rootDir, file),
    cacheFile = path.join(cacheDir, file.replace(/\//g, "_")),
    mtimeFile = cacheFile + ".mtime",
    mtime,
    needsUpdate,
    source;

  // Existence check folded into the stat below (ENOENT in the catch) rather
  // than a separate fileExists() call -- one fewer fs round trip per file.
  try {
    mtime = String((await fs.promises.stat(fullFilePath)).mtime);
  } catch (e) {
    console.warn("File not found, skipping: " + fullFilePath);
    return {
      source: file,
      code: "",
      sourcesRelativeTo: rootDir.replace(/\/$/, "/"),
      cacheFile: cacheFile,
      wasChanged: false,
    };
  }

  // Fast path: if this exact mtime was already confirmed valid by a
  // previous call in this process's lifetime, skip re-verifying the on-disk
  // transpile cache (3 more fs round trips) entirely -- steady state costs
  // exactly the one stat() above. Falls through to the real disk-based
  // check below on first touch since process start, or when mtime changed.
  if (_mtimeCache.get(fullFilePath) === mtime) {
    needsUpdate = false;
  } else {
    try {
      needsUpdate =
        !(await fileExists(cacheFile)) ||
        !(await fileExists(mtimeFile)) ||
        mtime !== String(await fs.promises.readFile(mtimeFile));
    } catch (e) {
      console.error("Error checking file " + fullFilePath + ": " + e);
      throw e;
    }
    if (!needsUpdate) _mtimeCache.set(fullFilePath, mtime);
  }

  if (needsUpdate) {
    console.log(file + " needs update");
    try {
      source =
        babelExceptions.indexOf(file) > -1
          ? await fs.promises.readFile(fullFilePath)
          : (await transformFileAsync(fullFilePath, { presets: ["es2015"] })).code;
      await Promise.all([
        fs.promises.writeFile(cacheFile, source),
        fs.promises.writeFile(mtimeFile, mtime),
      ]);
      _mtimeCache.set(fullFilePath, mtime);
    } catch (e) {
      console.error("Error processing file " + fullFilePath + ": " + e);
      throw e;
    }
  }

  return {
    source: file,
    code: source && String(source),
    sourcesRelativeTo: rootDir.replace(/\/$/, "/"),
    cacheFile: cacheFile,
    wasChanged: !!source,
  };
}

function concatAndWrite(files, rootDir, workDir, targetFilePath, time) {
  // files - list of files to concat
  // rootDir - dir to start to look for files from
  // targetFilePath like combined.js
  // jsmFilePath like combined.js.jsm

  // concat needs spec per file like
  // {source: pathToFile, code: STRING, sourcesRelativeTo: STRING}

  return Promise.all(
    files.map((f) => prepareFileForConcat(rootDir, workDir, f)),
  ).then(async (filesForConcat) => {
    var changed = filesForConcat.some((ea) => ea.wasChanged);
    if (
      !changed &&
      (await fileExists(combinedFile)) &&
      (await fileExists(combinedHashFile))
    ) {
      return { file: combinedFile, wasChanged: false };
    }

    return lang.promise.chain([
      () =>
        Promise.all(
          filesForConcat.map((ea) =>
            ea.code
              ? ea
              : fs.promises
                  .readFile(ea.cacheFile)
                  .then((content) => lang.obj.merge(ea, { code: String(content) })),
          ),
        ),
      (filesForConcat) =>
        concatModule()(filesForConcat, {
          delimiter: "\n",
          mapPath: targetFilePath + ".jsm",
        }),
      (concatenated) => {
        concatenated.prepend(createHeader(time, files));
        var result = concatenated.toStringWithSourceMap({
          file: path.basename(targetFilePath),
        });
        return lang.promise(fs.writeFile)(targetFilePath, result.code);
      },
      // () => console.log(targetFilePath + " written"),
      () => ({ file: targetFilePath, wasChanged: true }),
    ]);
  });
}

function createHeader(timestamp, files) {
  // Note: JSLoader relies on JSLoader.expectToLoadModules to be initialized!
  return util.format(
    "// This file was generated on %s\n\n" +
      "JSLoader.expectToLoadModules(%s);\n\n",
    timestamp.toGMTString(),
    JSON.stringify(files),
  );
}

function computeHash(combinedFile) {
  return new Promise((resolve, reject) => {
    var md5sum = crypto.createHash("md5"),
      hash;
    md5sum.setEncoding("hex");
    md5sum.on("data", (d) => (hash = String(d)));
    md5sum.on("error", (err) => reject(err));
    md5sum.on("end", () => resolve(hash));
    fs.createReadStream(combinedFile).pipe(md5sum);
  }).then((hash) => {
    fs.writeFileSync(combinedHashFile, hash);
    return hash;
  });
}

async function coreFiles(baseDir) {
  var cfg = lively.Config,
    libsFile = path.join(baseDir, "core/lib/lively-libs-debug.js"),
    // Convert bootstrap files to absolute paths by resolving them relative to baseDir
    bootstrapFiles = (cfg.get("bootstrapFiles") || []).map(function (file) {
      return path.join(baseDir, file);
    }),
    modulesToInclude = cfg
      .get("bootstrapModules")
      .concat(cfg.get("modulesBeforeWorldLoad"))
      .concat(cfg.get("modulesOnWorldLoad"));

  var initialFiles = await Promise.all(modulesToInclude.map(moduleToFile));
  var coreFiles = await spliceInDependencies(initialFiles.reverse());
  coreFiles = [libsFile].concat(bootstrapFiles).concat(coreFiles);

  // Convert all absolute paths back to relative paths for the module loading system
  coreFiles = coreFiles.map(function (file) {
    return file[0] === "/" || (file.length > 1 && file[1] === ":")
      ? path.relative(baseDir, file)
      : file;
  });

  return coreFiles;

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  async function moduleToFile(module) {
    // TODO: Adapt module load logic
    var relFile = "core/" + module.replace(/\./g, "/") + ".js",
      absFile = path.join(baseDir, relFile);
    if (await fileExists(absFile)) return absFile;
    relFile = module.replace(/\./g, "/") + ".js";
    absFile = path.join(baseDir, relFile);
    return absFile;
  }

  // Walks the module dependency graph declared via module(...).requires(...)
  // calls at the top of each core file. This used to do this with
  // fs.readFileSync in a tight synchronous loop, which -- across the
  // hundred-plus core files -- blocked the Node event loop for the whole
  // walk (visibly stalling all other subserver startup during boot).
  // fs.promises.readFile here lets the walk interleave with everything else
  // that's starting up concurrently instead of monopolizing the thread.
  //
  // Beyond just being non-blocking, this also used to re-read every file's
  // *full content* on every single call regardless of whether anything had
  // changed -- unlike prepareFileForConcat there was no caching here at
  // all. _depsCache (module-level, keyed by absolute path, spans the whole
  // process lifetime) skips straight to the previously-extracted dependency
  // list when a cheap stat() confirms the file's mtime hasn't moved, so a
  // steady-state walk pays one stat() per file instead of a full read.
  async function spliceInDependencies(files) {
    // rk 2014-10-25: Uuhhh ha, this looks like an ad-hoc parsing adventure...
    var i = 0,
      dependencies = {};
    while (i < files.length) {
      var filename = files[i];
      if (dependencies[filename]) {
        dependencies[filename].forEach(function (dep) {
          files.splice(i + 1, 0, dep);
        });
        i++;
        continue;
      }
      dependencies[filename] = [];
      try {
        var mtime = String((await fs.promises.stat(filename)).mtime);
        var cached = _depsCache.get(filename);
        var deps;
        if (cached && cached.mtime === mtime) {
          deps = cached.deps;
        } else {
          var content = (await fs.promises.readFile(filename)).toString();
          // FIXME: do real parsing, evil eval
          var modRegEx = /module\((.*?)\)\.requires\((.*?)\)./g;
          var moduleDefs = modRegEx.exec(content);
          deps = [];
          if (moduleDefs) {
            var req = eval("[" + moduleDefs[2] + "]");
            for (var module of req) deps.push(await moduleToFile(module));
          }
          _depsCache.set(filename, { mtime: mtime, deps: deps });
        }
        dependencies[filename] = deps;
        for (var dep of deps) files.splice(i + 1, 0, dep);
      } catch (e) {
        console.log("Problems processing: " + filename);
      }
      i++;
    }

    // remove duplicates - keep as absolute paths for now, will be converted to relative in coreFiles()
    return lang.arr.uniq(files);
  }
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

module.exports = function (_route, app) {
  app.get("/generated/combinedModulesHash.txt", function (_req, res) {
    combinedFileAndHashCached()
      .then((hashAndFile) => {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        });
        res.end(hashAndFile.hash);
      })
      .catch((err) => {
        res
          .status(500)
          .end(String("optimized loading error " + err.stack || err));
      });
  });

  app.get("/generated/:hash/combinedModules.js", function (req, res) {
    combinedFileAndHashCached()
      .then((hashAndFile) => {
        if (req.headers["if-none-match"] === hashAndFile.hash) {
          res.status(304);
          res.end();
          return;
        }

        var stream = fs.createReadStream(hashAndFile.file),
          oneYear = 1000 * 60 * 60 * 24 * 30 * 12,
          acceptEncoding = req.headers["accept-encoding"] || "",
          header = {
            "Content-Type": "application/javascript",
            Expires: new Date(Date.now() + oneYear).toGMTString(),
            "Cache-Control": "public",
            ETag: hashAndFile.hash,
          };
        if (acceptEncoding.match(/\bdeflate\b/)) {
          header["content-encoding"] = "deflate";
          stream = stream.pipe(zlib.createDeflate());
        } else if (acceptEncoding.match(/\bgzip\b/)) {
          header["content-encoding"] = "gzip";
          stream = stream.pipe(zlib.createGzip());
        }
        res.writeHead(200, header);
        stream.pipe(res);
      })
      .catch((err) =>
        res
          .status(500)
          .end(String("optimized loading error " + err.stack || err)),
      );
  });
};
