/*global require, __dirname*/

// jsDAV/lively-davfs's generic static-file serving (life_star's catch-all
// app.all(/.*/, fsHandler.handleRequest...)) applies zero compression, even
// when a client sends Accept-Encoding -- confirmed live: a real curl request
// with Accept-Encoding: gzip, deflate, br against postcard-runtime.js and
// lively-ace.js got back no content-encoding header at all and a
// content-length matching the full uncompressed file. Both are large
// (originally ~1.5MB/1.4MB) vendored/bundled JS files loaded eagerly on
// normal page views, confirmed via a real performance-report verification
// pass (DeployCheckList.md, 2026-09-02) as genuine contributors to page
// weight. Scoped explicitly to these two known-large files rather than a
// generic "compress everything under core/lib" rule, to keep blast radius
// small -- most of the ~80-130 files a boot fetches are small enough that
// compression isn't worth the added complexity (see DeployCheckList.md's
// deferred "move static serving behind a CDN" item for the broader
// architectural fix).
//
// Same in-memory compressed-buffer-cache-with-single-flight idiom as
// OptimizedLoadingServer.js's getCompressedBundle(), except keyed by file
// mtime (these are plain static files with no content-hash of their own,
// unlike combined.js) rather than a build-computed hash.

var fs = require("fs"),
  path = require("path"),
  zlib = require("zlib");

var COMPRESSED_STATIC_FILES = {
  "/core/lib/postcard/postcard-runtime.js": path.join(
    __dirname,
    "..",
    "lib",
    "postcard",
    "postcard-runtime.js",
  ),
  "/core/lib/ace/lively-ace.js": path.join(__dirname, "..", "lib", "ace", "lively-ace.js"),
};

var _cache = {}; // route -> { mtime, buffers: {gzip, deflate}, pending: {} }

function compressWholeFile(file, encoding) {
  return new Promise(function (resolve, reject) {
    var chunks = [],
      src = fs.createReadStream(file),
      compressor = encoding === "deflate" ? zlib.createDeflate() : zlib.createGzip(),
      stream = src.pipe(compressor);
    src.on("error", reject);
    stream.on("error", reject);
    stream.on("data", function (chunk) {
      chunks.push(chunk);
    });
    stream.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
  });
}

function getCompressedFile(route, file, mtime, encoding) {
  var entry = _cache[route];
  if (!entry || entry.mtime !== mtime) {
    entry = _cache[route] = { mtime: mtime, buffers: {}, pending: {} };
  }
  if (entry.buffers[encoding]) return Promise.resolve(entry.buffers[encoding]);
  if (entry.pending[encoding]) return entry.pending[encoding];
  var promise = compressWholeFile(file, encoding).then(
    function (buf) {
      if (entry === _cache[route]) {
        entry.buffers[encoding] = buf;
        delete entry.pending[encoding];
      }
      return buf;
    },
    function (err) {
      if (entry === _cache[route]) delete entry.pending[encoding];
      throw err;
    },
  );
  entry.pending[encoding] = promise;
  return promise;
}

module.exports = function (_route, app) {
  Object.keys(COMPRESSED_STATIC_FILES).forEach(function (route) {
    var file = COMPRESSED_STATIC_FILES[route];
    app.get(route, function (req, res) {
      fs.stat(file, function (err, stat) {
        if (err) {
          res.status(404).end();
          return;
        }
        var mtime = String(stat.mtime),
          lastModified = stat.mtime.toUTCString(),
          header = {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
            "Last-Modified": lastModified,
          };

        if (req.headers["if-modified-since"] === lastModified) {
          res.status(304).end();
          return;
        }

        var acceptEncoding = req.headers["accept-encoding"] || "",
          encoding = acceptEncoding.match(/\bdeflate\b/)
            ? "deflate"
            : acceptEncoding.match(/\bgzip\b/)
              ? "gzip"
              : null;

        if (!encoding) {
          res.writeHead(200, header);
          fs.createReadStream(file).pipe(res);
          return;
        }

        header["content-encoding"] = encoding;
        getCompressedFile(route, file, mtime, encoding)
          .then(function (buf) {
            res.writeHead(200, header);
            res.end(buf);
          })
          .catch(function (err) {
            res.status(500).end(String(err && err.stack || err));
          });
      });
    });
  });
};
