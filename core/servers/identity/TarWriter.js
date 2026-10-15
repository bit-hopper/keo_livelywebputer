/**
 * core/servers/identity/TarWriter.js
 *
 * A minimal streaming tar writer — just enough to emit a .keo archive
 * (settings.md §5a). No dependency (tar-stream is installed only as a
 * transitive dependency of tar-fs and declared nowhere), and nothing is
 * buffered beyond one entry's own header: file bytes go straight from a
 * readable to the output with backpressure.
 *
 * Format: POSIX ustar, regular files only. A name longer than 100 bytes is
 * split on a "/" into ustar prefix (<=155) + name (<=100) when possible,
 * otherwise carried in a PAX extended header ('x' entry) — so any tar tool
 * reads the result and long upload paths survive.
 *
 * Every add* call reports { size, sha256 } of the entry's content, which the
 * caller records in the manifest. A tar entry's size is in its header, so a
 * streamed entry's size must be known up front; if the stream then delivers a
 * different number of bytes the archive can no longer be valid and the writer
 * fails hard (callers should destroy the output).
 */

'use strict';

var crypto = require('crypto');

var BLOCK = 512;

function _octal(n, width) {
  var s = n.toString(8);
  while (s.length < width) s = '0' + s;
  return s;
}

function _putString(buf, str, offset, length) {
  var bytes = Buffer.from(str, 'utf8');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

// A 512-byte ustar header. `name` and `prefix` must already fit (<=100/<=155 bytes).
function _header(name, prefix, size, typeflag, mtimeSec) {
  var buf = Buffer.alloc(BLOCK);
  _putString(buf, name, 0, 100);
  _putString(buf, '0000644\0', 100, 8);                 // mode
  _putString(buf, '0000000\0', 108, 8);                 // uid
  _putString(buf, '0000000\0', 116, 8);                 // gid
  _putString(buf, _octal(size, 11) + '\0', 124, 12);    // size
  _putString(buf, _octal(mtimeSec, 11) + '\0', 136, 12);// mtime
  _putString(buf, '        ', 148, 8);                  // checksum placeholder (spaces)
  _putString(buf, typeflag, 156, 1);
  _putString(buf, 'ustar\0', 257, 6);
  _putString(buf, '00', 263, 2);
  _putString(buf, prefix || '', 345, 155);
  var sum = 0;
  for (var i = 0; i < BLOCK; i++) sum += buf[i];
  _putString(buf, _octal(sum, 6) + '\0 ', 148, 8);
  return buf;
}

// One PAX record: "<len> <key>=<value>\n", where len counts the whole record
// including its own digits.
function _paxRecord(key, value) {
  var body = ' ' + key + '=' + value + '\n';
  var len = Buffer.byteLength(body, 'utf8');
  var digits = String(len).length;
  while (String(len + digits).length !== digits) digits = String(len + digits).length;
  return Buffer.from((len + digits) + body, 'utf8');
}

// Splits `name` into {prefix, name} for ustar, or returns null if it can't fit.
function _splitName(name) {
  if (Buffer.byteLength(name, 'utf8') <= 100) return { prefix: '', name: name };
  for (var i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    var p = name.slice(0, i), n = name.slice(i + 1);
    if (Buffer.byteLength(p, 'utf8') <= 155 && Buffer.byteLength(n, 'utf8') <= 100 && n.length) return { prefix: p, name: n };
  }
  return null;
}

// out: any Writable. Calls to add* must be sequential (wait for the callback).
function TarWriter(out) {
  var self = this;
  this.out = out;
  this.failed = null;
  this.written = 0;
  this._mtime = Math.floor(Date.now() / 1000);
  // A closed/errored output (client aborted the download) fails every later call.
  out.on('close', function () { if (!self.failed && !self._finished) self.failed = new Error('TarWriter: output closed'); });
  out.on('error', function (err) { if (!self.failed) self.failed = err; });
}

TarWriter.prototype._write = function (chunk, cb) {
  if (this.failed) return cb(this.failed);
  this.written += chunk.length;
  if (this.out.write(chunk)) return cb(null);
  var self = this;
  var onDrain = function () { self.out.removeListener('close', onClose); cb(self.failed || null); };
  var onClose = function () { self.out.removeListener('drain', onDrain); cb(self.failed || new Error('TarWriter: output closed')); };
  this.out.once('drain', onDrain);
  this.out.once('close', onClose);
};

TarWriter.prototype._pad = function (size, cb) {
  var rem = size % BLOCK;
  if (!rem) return cb(null);
  this._write(Buffer.alloc(BLOCK - rem), cb);
};

// Writes the header (and a PAX header if the name needs one). cb(err)
TarWriter.prototype._beginEntry = function (name, size, cb) {
  var self = this;
  var split = _splitName(name);
  if (split) return this._write(_header(split.name, split.prefix, size, '0', this._mtime), cb);
  // PAX: an 'x' entry carrying the real path, then the file header with a truncated name.
  var rec = _paxRecord('path', name);
  var short = Buffer.from(name, 'utf8').slice(0, 99).toString('utf8').replace(/�/g, '_');
  this._write(_header('PaxHeader', '', rec.length, 'x', this._mtime), function (err) {
    if (err) return cb(err);
    self._write(rec, function (err) {
      if (err) return cb(err);
      self._pad(rec.length, function (err) {
        if (err) return cb(err);
        self._write(_header(short, '', size, '0', self._mtime), cb);
      });
    });
  });
};

// cb(err, { size, sha256 })
TarWriter.prototype.addBuffer = function (name, buf, cb) {
  var self = this;
  var sha = crypto.createHash('sha256').update(buf).digest('hex');
  this._beginEntry(name, buf.length, function (err) {
    if (err) return cb(err);
    self._write(buf, function (err) {
      if (err) return cb(err);
      self._pad(buf.length, function (err) {
        if (err) return cb(err);
        cb(null, { size: buf.length, sha256: sha });
      });
    });
  });
};

// `size` is the exact byte length the readable will deliver.
// cb(err, { size, sha256 })
TarWriter.prototype.addStream = function (name, size, readable, cb) {
  var self = this;
  this._beginEntry(name, size, function (err) {
    if (err) { readable.destroy && readable.destroy(); return cb(err); }
    var hash = crypto.createHash('sha256');
    var n = 0;
    var settled = false;
    function fail(e) {
      if (settled) return;
      settled = true;
      readable.destroy && readable.destroy();
      self.failed = self.failed || e;
      cb(e);
    }
    readable.on('data', function (chunk) {
      if (settled) return;
      n += chunk.length;
      if (n > size) return fail(new Error('TarWriter: ' + name + ' is larger than its declared size ' + size));
      hash.update(chunk);
      self.written += chunk.length;
      if (!self.out.write(chunk)) {
        readable.pause();
        var resume = function () { self.out.removeListener('close', onClose); readable.resume(); };
        var onClose = function () { self.out.removeListener('drain', resume); fail(new Error('TarWriter: output closed')); };
        self.out.once('drain', resume);
        self.out.once('close', onClose);
      }
    });
    readable.on('error', fail);
    readable.on('end', function () {
      if (settled) return;
      if (n !== size) return fail(new Error('TarWriter: ' + name + ' delivered ' + n + ' bytes, expected ' + size));
      self._pad(size, function (err) {
        if (settled) return;
        settled = true;
        if (err) return cb(err);
        cb(null, { size: size, sha256: hash.digest('hex') });
      });
    });
  });
};

// Two zero blocks end a tar archive. Does not end the output.
TarWriter.prototype.finish = function (cb) {
  this._finished = true;
  this._write(Buffer.alloc(BLOCK * 2), cb);
};

module.exports = { TarWriter: TarWriter, BLOCK: BLOCK };
