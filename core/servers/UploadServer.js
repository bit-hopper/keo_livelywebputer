var lang = require("lively.lang");
var fs = require("fs");
var util = require("util");
var async = require("async");
var path = require("path");
var exec = require("child_process").exec;
var os = require("os");

// Polyfill for os.tmpDir() which was removed in Node.js v18+
// This is needed for the old multiparty middleware to work
if (!os.tmpDir) {
  os.tmpDir = function () {
    return os.tmpdir();
  };
}

var numberFileRe = /^(.*\/)?([^\.]+)(\.[^\/]+)?$/;

function numberFileReplacer(match, path, baseName, ext) {
  // adds a -1, -2, ... to the filename before the extension
  var i = 1;
  var noMatch = baseName.match(/-([0-9]+)$/);
  if (noMatch) {
    baseName = baseName.slice(0, -noMatch[0].length);
    i = Number(noMatch[1]) + 1;
  }
  return (path || "") + baseName + "-" + i + (ext || "");
}

function findUnusedFileName(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  do {
    filePath = filePath.replace(numberFileRe, numberFileReplacer);
  } while (fs.existsSync(filePath));
  return filePath;
}

function gatherFormFiles(formFiles, location) {
  var files = Object.keys(formFiles).reduce(function (allFiles, key) {
    var files = formFiles[key];
    if (!util.isArray(files)) files = [files];
    return allFiles.concat(files);
  }, []);
  files.forEach(function (file) {
    var fname =
        file.originalFilename || file.name || file.type.replace(/\//, "."),
      targetPath = path.join(location, fname).replace(/\s/g, "_");
    file.targetPath = findUnusedFileName(targetPath);
  });
  return files;
}

function uploadFiles(location, formFiles, thenDo) {
  var report = { uploadedFiles: [] };
  // gather all files in the form

  lang.fun.composeAsync(
    function ensureLocation(n) {
      exec("mkdir -p " + location, function (err, stdout, stderr) {
        n(err);
      });
    },
    function (n) {
      var files = gatherFormFiles(formFiles, location),
        lkDir =
          lang.Path("lv.server.lifeStar.tree.basePath").get(global) ||
          process.env.WORKSPACE_LK ||
          process.cwd();

      async.forEach(
        files,
        function (file, next) {
          var to = file.targetPath,
            reported = {
              originalName: file.originalFilename || file.name,
              size: file.size,
              type: file.type,
              path: to,
              relativePath: path.relative(lkDir, to),
              name: path.basename(to),
            };
          report.uploadedFiles.push(reported);
          // by default files get uploaded via bodyParser to /tmp/... location. Move
          // them to the specified location
          exec(["mv", file.path, to].join(" "), next);
        },
        function (err) {
          n(err);
        },
      );
    },
  )(function (err) {
    thenDo(err, report);
  });
}

module.exports = function (route, app) {
  app.post("/upload", function (req, res) {
    // Handle FormData from browser: location and files come from FormData
    var additionalData = req.body || {};
    var location = additionalData.location || process.cwd();
    var files = req.files;

    // Debug logging
    console.log("[UploadServer] POST /upload received");
    console.log("[UploadServer] req.body keys:", Object.keys(req.body || {}));
    console.log(
      "[UploadServer] req.files:",
      req.files ? Object.keys(req.files) : "undefined",
    );
    console.log("[UploadServer] location:", location);

    // Validate that files exist
    if (!files || Object.keys(files).length === 0) {
      console.error("[UploadServer] Error: no files in upload request");
      return res.status(400).json({
        error: "No files provided in upload request",
        receivedBody: req.body,
        receivedFiles: files,
      });
    }

    uploadFiles(location, files, function (err, uploadReport) {
      if (err) {
        console.error("[UploadServer] Upload error:", err.stack || err);
        res.status(500).json({ error: String(err.stack || err) });
      } else {
        console.log("[UploadServer] Upload successful:", uploadReport);
        res.json(uploadReport);
      }
    });
  });
};
