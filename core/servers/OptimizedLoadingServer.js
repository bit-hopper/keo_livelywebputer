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
  _babel = null;

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
  // for fast subsequent requests cache the hash / combined result
  // combinedFileAndHashCached().then(x => console.log(x)).catch(err => console.error(err))
  if (typeof Config !== "undefined" && !Config.optimizedLoading)
    return Promise.reject("Optimized loading not enabled");
  return _combinedFileAndHashCached
    ? Promise.resolve(_combinedFileAndHashCached)
    : combinedFileAndHash().then((result) => {
        _combinedFileAndHashCached = result;
        setTimeout(
          () => (_combinedFileAndHashCached = null),
          _combinedFileAndHashCachedTimeout,
        );
        return result;
      });
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
        : String(fs.readFileSync(combinedHashFile)),
    (hash) => ({ hash: hash, file: combinedFile }),
  ]));
}

function prepareFileForConcat(rootDir, cacheDir, file) {
  // es5 translation of core files, stores into cache dir

  // var x = prepareFileForConcat(rootDir, workDir, files[1])
  // x.then((arg) => console.log(arg))

  return new Promise((resolve, reject) => {
    var babelExceptions = ["core/lib/lively-libs-debug.js"],
      fullFilePath = path.join(rootDir, file),
      cacheFile = path.join(cacheDir, file.replace(/\//g, "_")),
      mtimeFile = cacheFile + ".mtime",
      mtime,
      needsUpdate,
      source;

    // Check if file exists first
    if (!fs.existsSync(fullFilePath)) {
      console.warn("File not found, skipping: " + fullFilePath);
      return resolve({
        source: file,
        code: "",
        sourcesRelativeTo: rootDir.replace(/\/$/, "/"),
        cacheFile: cacheFile,
        wasChanged: false,
      });
    }

    try {
      mtime = String(fs.statSync(fullFilePath).mtime);
      needsUpdate =
        !fs.existsSync(cacheFile) ||
        !fs.existsSync(mtimeFile) ||
        mtime !== String(fs.readFileSync(mtimeFile));
    } catch (e) {
      console.error("Error checking file " + fullFilePath + ": " + e);
      return reject(e);
    }

    if (needsUpdate) {
      console.log(file + " needs update");
      try {
        source =
          babelExceptions.indexOf(file) > -1
            ? fs.readFileSync(fullFilePath)
            : babelModule().transformFileSync(fullFilePath, { presets: ["es2015"] })
                .code;
        fs.writeFileSync(cacheFile, source);
        fs.writeFileSync(mtimeFile, mtime);
      } catch (e) {
        console.error("Error processing file " + fullFilePath + ": " + e);
        return reject(e);
      }
    }

    resolve({
      source: file,
      code: source && String(source),
      sourcesRelativeTo: rootDir.replace(/\/$/, "/"),
      cacheFile: cacheFile,
      wasChanged: !!source,
    });
  });
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
  ).then((filesForConcat) => {
    var changed = filesForConcat.some((ea) => ea.wasChanged);
    if (
      !changed &&
      fs.existsSync(combinedFile) &&
      fs.existsSync(combinedHashFile)
    ) {
      return { file: combinedFile, wasChanged: false };
    }

    return lang.promise.chain([
      () =>
        Promise.all(
          filesForConcat.map((ea) =>
            ea.code
              ? ea
              : lang.obj.merge(ea, {
                  code: String(fs.readFileSync(ea.cacheFile)),
                }),
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

  async function fileExists(file) {
    return fs.promises.access(file, fs.constants.F_OK).then(
      () => true,
      () => false,
    );
  }

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
        var content = (await fs.promises.readFile(filename)).toString();
        // FIXME: do real parsing, evil eval
        var modRegEx = /module\((.*?)\)\.requires\((.*?)\)./g;
        var moduleDefs = modRegEx.exec(content);
        if (moduleDefs) {
          var req = eval("[" + moduleDefs[2] + "]");
          var deps = dependencies[filename];
          for (var module of req) {
            var depFile = await moduleToFile(module);
            files.splice(i + 1, 0, depFile);
            deps.push(depFile);
          }
        }
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
