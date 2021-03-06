// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
/*
 * This is the TLS code from Node 10.25. However, the "SecurePair" implementation is
 * different because Trireme uses SSLEngine which is a lot like OpenSSL but it is not
 * entirely the same.
 */

var crypto = require('crypto');
var util = require('util');
var net = require('net');
var url = require('url');
var events = require('events');
var stream = require('stream');
var assert = require('assert').ok;
var constants = require('constants');

// Allow {CLIENT_RENEG_LIMIT} client-initiated session renegotiations
// every {CLIENT_RENEG_WINDOW} seconds. An error event is emitted if more
// renegotations are seen. The settings are applied to all remote client
// connections.
exports.CLIENT_RENEG_LIMIT = 3;
exports.CLIENT_RENEG_WINDOW = 600;

exports.SLAB_BUFFER_SIZE = 10 * 1024 * 1024;

exports.getCiphers = function() {
  var names = process.binding('crypto').getSSLCiphers();
  // Drop all-caps names in favor of their lowercase aliases,
  var ctx = {};
  names.forEach(function(name) {
    if (/^[0-9A-Z\-]+$/.test(name)) name = name.toLowerCase();
    ctx[name] = true;
  });
  return Object.getOwnPropertyNames(ctx).sort();
};


var debug;
var debugEnabled;
if (process.env.NODE_DEBUG && /tls/.test(process.env.NODE_DEBUG)) {
  debug = function(a) { console.error('TLS:', a); };
  debugEnabled = true;
} else {
  debug = function() { };
  debugEnabled = false;
}


var Connection = null;
try {
  Connection = process.binding('crypto').Connection;
} catch (e) {
  throw new Error('node.js not compiled with openssl crypto support.');
}

// Convert protocols array into valid OpenSSL protocols list
// ("\x06spdy/2\x08http/1.1\x08http/1.0")
function convertNPNProtocols(NPNProtocols, out) {
  // If NPNProtocols is Array - translate it into buffer
  if (Array.isArray(NPNProtocols)) {
    var buff = new Buffer(NPNProtocols.reduce(function(p, c) {
      return p + 1 + Buffer.byteLength(c);
    }, 0));

    NPNProtocols.reduce(function(offset, c) {
      var clen = Buffer.byteLength(c);
      buff[offset] = clen;
      buff.write(c, offset + 1);

      return offset + 1 + clen;
    }, 0);

    NPNProtocols = buff;
  }

  // If it's already a Buffer - store it
  if (Buffer.isBuffer(NPNProtocols)) {
    out.NPNProtocols = NPNProtocols;
  }
}


function checkServerIdentity(host, cert) {
  // Create regexp to much hostnames
  function regexpify(host, wildcards) {
    // Add trailing dot (make hostnames uniform)
    if (!/\.$/.test(host)) host += '.';

    // The same applies to hostname with more than one wildcard,
    // if hostname has wildcard when wildcards are not allowed,
    // or if there are less than two dots after wildcard (i.e. *.com or *d.com)
    //
    // also
    //
    // "The client SHOULD NOT attempt to match a presented identifier in
    // which the wildcard character comprises a label other than the
    // left-most label (e.g., do not match bar.*.example.net)."
    // RFC6125
    if (!wildcards && /\*/.test(host) || /[\.\*].*\*/.test(host) ||
        /\*/.test(host) && !/\*.*\..+\..+/.test(host)) {
      return /$./;
    }

    // Replace wildcard chars with regexp's wildcard and
    // escape all characters that have special meaning in regexps
    // (i.e. '.', '[', '{', '*', and others)
    var re = host.replace(
        /\*([a-z0-9\\-_\.])|[\.,\-\\\^\$+?*\[\]\(\):!\|{}]/g,
        function(all, sub) {
          if (sub) return '[a-z0-9\\-_]*' + (sub === '-' ? '\\-' : sub);
          return '\\' + all;
        });

    return new RegExp('^' + re + '$', 'i');
  }

  var dnsNames = [],
      uriNames = [],
      ips = [],
      matchCN = true,
      valid = false;

  // There're several names to perform check against:
  // CN and altnames in certificate extension
  // (DNS names, IP addresses, and URIs)
  //
  // Walk through altnames and generate lists of those names
  if (cert.subjectaltname) {
    cert.subjectaltname.split(/, /g).forEach(function(altname) {
      if (/^DNS:/.test(altname)) {
        dnsNames.push(altname.slice(4));
      } else if (/^IP Address:/.test(altname)) {
        ips.push(altname.slice(11));
      } else if (/^URI:/.test(altname)) {
        var uri = url.parse(altname.slice(4));
        if (uri) uriNames.push(uri.hostname);
      }
    });
  }

  // If hostname is an IP address, it should be present in the list of IP
  // addresses.
  if (net.isIP(host)) {
    valid = ips.some(function(ip) {
      return ip === host;
    });
  } else {
    // Transform hostname to canonical form
    if (!/\.$/.test(host)) host += '.';

    // Otherwise check all DNS/URI records from certificate
    // (with allowed wildcards)
    dnsNames = dnsNames.map(function(name) {
      return regexpify(name, true);
    });

    // Wildcards ain't allowed in URI names
    uriNames = uriNames.map(function(name) {
      return regexpify(name, false);
    });

    dnsNames = dnsNames.concat(uriNames);

    if (dnsNames.length > 0) matchCN = false;

    // Match against Common Name (CN) only if no supported identifiers are
    // present.
    //
    // "As noted, a client MUST NOT seek a match for a reference identifier
    //  of CN-ID if the presented identifiers include a DNS-ID, SRV-ID,
    //  URI-ID, or any application-specific identifier types supported by the
    //  client."
    // RFC6125
    if (matchCN) {
      var commonNames = cert.subject.CN;
      if (Array.isArray(commonNames)) {
        for (var i = 0, k = commonNames.length; i < k; ++i) {
          dnsNames.push(regexpify(commonNames[i], true));
        }
      } else {
        var reg = regexpify(commonNames, true);
        debug(reg);
        dnsNames.push(reg);
      }
    }

    valid = dnsNames.some(function(re) {
      return re.test(host);
    });
  }

  return valid;
}
exports.checkServerIdentity = checkServerIdentity;

// Base class of both CleartextStream and EncryptedStream
function CryptoStream(pair, options) {
  stream.Duplex.call(this, options);
  this.pair = pair;
  this.callbacks = [];

  this.once('finish', onCryptoStreamFinish);
}
util.inherits(CryptoStream, stream.Duplex);

function onCryptoStreamFinish() {
  this._finished = true;

  var self = this;
  if (this === this.pair.cleartext) {
    if (this.pair.ssl) {
      debug('Shutting down SSL output');
      this.pair.ssl.shutdown(function() {
        debug('Shutdown complete');
        self._done();
      });

      if (this.pair.ssl && this.pair.ssl.error) {
        return this.pair.error();
      }
    }

  } else {
    debug('encrypted.onfinish');
    if (!this.pair._secureEstablished && !this._destroyed) {
      this.pair.emit('error', new Error('Socket hung up'));
    } else {
      if (this.pair.ssl) {
        debug('Shutting down SSL input in response to a connection close');
        this.pair.ssl.shutdownInbound();
      }
    }
  }

  // Try to read just to get sure that we won't miss EOF
  if (this._opposite.readable) this._opposite.read(0);

  if (this._opposite._ended) {
    this._done();

    // No half-close, sorry
    if (this === this.pair.cleartext) this._opposite._done();
  }
}

CryptoStream.prototype.end = function(chunk, encoding) {
  if (this === this.pair.cleartext) {
    debug('cleartext.end');
  } else {
    debug('encrypted.end');
  }

  this.writable = false;
  stream.Duplex.prototype.end.call(this, chunk, encoding);
};

CryptoStream.prototype.destroySoon = function(err) {
  if (this === this.pair.cleartext) {
    debug('cleartext.destroySoon');
  } else {
    debug('encrypted.destroySoon');
  }

  if (this.writable)
    this.end();

  if (this._writableState.finished && this._opposite._ended) {
    this.destroy();
  } else {
    // Wait for both `finish` and `end` events to ensure that all data that
    // was written on this side was read from the other side.
    var self = this;
    var waiting = 1;
    this._opposite.once('end', finish);
    if (!this._finished) {
      this.once('finish', finish);
      ++waiting;
    }
  }

  function finish() {
    if (--waiting === 0) self.destroy();
  }
};


CryptoStream.prototype.destroy = function(err) {
  if (this._destroyed) return;
  this._destroyed = true;
  this.readable = this.writable = false;

  this._deliverCallbacks();

  // Destroy both ends
  if (this === this.pair.cleartext) {
    debug('cleartext.destroy');
  } else {
    debug('encrypted.destroy');
  }
  this._opposite.destroy();

  var self = this;
  process.nextTick(function() {
    // Force EOF
    self.push(null);

    // Emit 'close' event
    self.emit('close', err ? true : false);
  });
};

CryptoStream.prototype._read = function() {
  // It's OK to read now so pop any write callbacks that we queued
  this._deliverCallbacks();
};

CryptoStream.prototype._deliverCallbacks = function() {
    while (this.callbacks.length > 0) {
    debug('Delivering a deferred callback');
    var cb = this.callbacks.shift();
    cb();
  }
}

CryptoStream.prototype._done = function() {
  this._doneFlag = true;
  if (!this.pair) {
    // Might get called after we are destroyed
    return;
  }

  if (debugEnabled) {
    debug('_done cleartext: ' + this.pair.cleartext._doneFlag + ' encrypted: ' + this.pair.encrypted._doneFlag);
  }

  if (this === this.pair.encrypted && !this.pair._secureEstablished)
    return this.pair.error();

  if (this.pair.cleartext._doneFlag &&
      this.pair.encrypted._doneFlag &&
      !this.pair._doneFlag) {
    // If both streams are done:
    this.pair.destroy();
  }
};


// readyState is deprecated. Don't use it.
Object.defineProperty(CryptoStream.prototype, 'readyState', {
  get: function() {
    if (this._connecting) {
      return 'opening';
    } else if (this.readable && this.writable) {
      return 'open';
    } else if (this.readable && !this.writable) {
      return 'readOnly';
    } else if (!this.readable && this.writable) {
      return 'writeOnly';
    } else {
      return 'closed';
    }
  }
});

function CleartextStream(pair, options) {
  CryptoStream.call(this, pair, options);

  var self = this;
  this.pair.ssl.onwrap = function(chunk, shutdown, cb) {
    self._onwrap(chunk, shutdown, cb);
  };
  this.once('end', function() {
    self._onEnd();
  });
}
util.inherits(CleartextStream, CryptoStream);

CleartextStream.prototype.init = function() {
  assert(this._opposite);
};

CleartextStream.prototype._write = function(chunk, encoding, cb) {
  debug('CleartextStream._write');
  // Wrap and put on the queue for the encrypted stream
  if (!this.pair.ssl) {
    // Blackhole just like in regular node.
    return;
  }

  if (debugEnabled) {
    debug('Going to wrap ' + chunk.length);
  }
  this.pair.ssl.wrap(chunk, function(err) {
    debug('Wrapping complete');
    if (cb) {
      cb(err);
    }
  });
};

// Data from SSLEngine.wrap will end up here. It will pass
// us the callback used to
CleartextStream.prototype._onwrap = function(chunk, shutdown, writeCallback) {
  if (this._destroyed || !this.pair.ssl) {
    // Arrived late after close -- ignore
    return;
  }
  if (chunk) {
    if (debugEnabled) {
      debug('Received ' + chunk.length + ' wrapped bytes');
    }
    if (this._opposite.ondata) {
      this._opposite.ondata(chunk, 0, chunk.length);
    } else {
      var pushed = this._opposite.push(chunk);
      if (writeCallback) {
        if (pushed) {
          debug('Delivering write callback now');
          writeCallback();
        } else {
          debug('Deferring write callback');
          this._opposite.callbacks.push(writeCallback);
        }
      }
    }
  }
  if (shutdown) {
    debug('Received completion of shutdown request');
    this._opposite.push(null);
  }
};

CleartextStream.prototype._onEnd = function() {
  debug('CleartextStream end received');
  this._ended = true;
  this._done();
  if (this.onend) {
    debug('onend');
    this.onend();
  }
};

CleartextStream.prototype.address = function() {
  return this.socket && this.socket.address();
};

CleartextStream.prototype.__defineGetter__('remoteAddress', function() {
  return this.socket && this.socket.remoteAddress;
});

CleartextStream.prototype.__defineGetter__('remotePort', function() {
  return this.socket && this.socket.remotePort;
});

CleartextStream.prototype.getPeerCertificate = function() {
  if (this.pair.ssl) {
    return this.pair.ssl.getPeerCertificate();
  }

  return null;
};

CleartextStream.prototype.getSession = function() {
  if (this.pair.ssl) {
    return this.pair.ssl.getSession();
  }

  return null;
};

CleartextStream.prototype.isSessionReused = function() {
  if (this.pair.ssl) {
    return this.pair.ssl.isSessionReused();
  }

  return null;
};

CleartextStream.prototype.getCipher = function(err) {
  if (this.pair.ssl) {
    return this.pair.ssl.getCurrentCipher();
  } else {
    return null;
  }
};

CleartextStream.prototype.setTimeout = function(timeout, callback) {
  if (this.socket) this.socket.setTimeout(timeout, callback);
};


CleartextStream.prototype.setNoDelay = function(noDelay) {
  if (this.socket) this.socket.setNoDelay(noDelay);
};


CleartextStream.prototype.setKeepAlive = function(enable, initialDelay) {
  if (this.socket) this.socket.setKeepAlive(enable, initialDelay);
};

CleartextStream.prototype.__defineGetter__('bytesWritten', function() {
  return this.socket ? this.socket.bytesWritten : 0;
});


function EncryptedStream(pair, options) {
  CryptoStream.call(this, pair, options);

  var self = this;
  this.pair.ssl.onunwrap = function(chunk, shutdown, cb) {
    self._onunwrap(chunk, shutdown, cb);
  };
}
util.inherits(EncryptedStream, CryptoStream);

EncryptedStream.prototype.init = function() {
  assert(this._opposite);
  var self = this;
  this.once('end', function() {
    self._onEnd();
  });
  this.once('close', function() {
    self._closed = true;
  });
};

EncryptedStream.prototype._write = function(chunk, encoding, cb) {
  debug('EncryptedStream._write');
  // Unwrap and put on the queue for the cleartext stream
  if (!this.pair.ssl) {
    // Blackhole just like in regular node.
    return;
  }

  if (debugEnabled) {
    debug('Going to unwrap ' + chunk.length);
  }
  this.pair.ssl.unwrap(chunk, function(err) {
    debug('Unwrap complete');
    if (cb) {
      cb(err);
    }
  });
};

EncryptedStream.prototype._onunwrap = function(chunk, shutdown, readCallback) {
  if (this._destroyed || !this.pair.ssl) {
    // Arrived late after close -- ignore
    return;
  }
  if (chunk) {
    if (debugEnabled) {
      debug('Received ' + chunk.length + ' bytes of unwrapped data');
    }
    if (this._opposite.ondata) {
      this._opposite.ondata(chunk, 0, chunk.length);
    } else {
      var pushed = this._opposite.push(chunk);
      if (readCallback) {
        if (pushed) {
          debug('Delivering read callback now');
          readCallback();
        } else {
          debug('Deferring read callback');
          this._opposite.callbacks.push(readCallback);
        }
      }
    }
  }

  if (shutdown) {
    debug('Got shutdown from the client');
    this._done();
    this._opposite.push(null);
  }
};

EncryptedStream.prototype._onEnd = function() {
  debug('EncryptedStream end received');
  this._ended = true;
  if (!this.pair._secureEstablished && !this._destroyed) {
    this.pair.emit('error', new Error('Socket hung up'));
  } else {
    if (!this._closed) {
      this._done();
    }
    if (this.onend) {
      debug('onend');
      this.onend();
    }
  }
};

function onhandshakestart() {
  debug('onhandshakestart');

  var self = this;
  var ssl = self.ssl;
  var now = Date.now();

  assert(now >= ssl.lastHandshakeTime);

  if ((now - ssl.lastHandshakeTime) >= exports.CLIENT_RENEG_WINDOW * 1000) {
    ssl.handshakes = 0;
  }

  var first = (ssl.lastHandshakeTime === 0);
  ssl.lastHandshakeTime = now;
  if (first) return;

  if (++ssl.handshakes > exports.CLIENT_RENEG_LIMIT) {
    // Defer the error event to the next tick. We're being called from OpenSSL's
    // state machine and OpenSSL is not re-entrant. We cannot allow the user's
    // callback to destroy the connection right now, it would crash and burn.
    setImmediate(function() {
      var err = new Error('TLS session renegotiation attack detected.');
      if (self.cleartext) self.cleartext.emit('error', err);
    });
  }
}


function onhandshakedone() {
  // for future use
  debug('onhandshakedone');
  // Trireme -- no point in calling this in every write when we know when it happens
  this.maybeInitFinished();
}


function onclienthello(hello) {
  var self = this,
      once = false;

  this._resumingSession = true;
  function callback(err, session) {
    if (once) return;
    once = true;

    if (err) return self.socket.destroy(err);

    self.ssl.loadSession(session);

    // Cycle data
    self._resumingSession = false;
    self.cleartext.read(0);
    self.encrypted.read(0);
  }

  if (hello.sessionId.length <= 0 ||
      !this.server ||
      !this.server.emit('resumeSession', hello.sessionId, callback)) {
    callback(null, null);
  }
}


function onnewsession(key, session) {
  if (!this.server) return;
  this.server.emit('newSession', key, session);
}

// Catch errors that do not directly result from reads or writes.
// Particularly, ones raised directly by SSLEngine when "rejectUnauthorized" is set.
function onerror(err) {
  if (debugEnabled) {
    debug('Got SSL error: ' + err.message);
  }
  if (this.ssl.verifyError()) {
    // Handshaking error
    this.cleartext.authorized = false;
    this.cleartext.authorizationError = this.ssl.verifyError().message;
    this.destroy();
    this.emit('error', err);
  } else {
    this.cleartext.emit('error', err);
  }
}

/**
 * Provides a pair of streams to do encrypted communication.
 */

function SecurePair(credentials, isServer, requestCert, rejectUnauthorized,
                    options) {
  if (!(this instanceof SecurePair)) {
    return new SecurePair(credentials,
                          isServer,
                          requestCert,
                          rejectUnauthorized,
                          options);
  }

  var self = this;

  options || (options = {});

  events.EventEmitter.call(this);

  this.server = options.server;
  this._secureEstablished = false;
  this._isServer = isServer ? true : false;
  this._encWriteState = true;
  this._clearWriteState = true;
  this._doneFlag = false;
  this._destroying = false;

  if (!credentials) {
    this.credentials = crypto.createCredentials();
  } else {
    this.credentials = credentials;
  }

  if (!this._isServer) {
    // For clients, we will always have either a given ca list or be using
    // default one
    requestCert = true;
  }

  this._rejectUnauthorized = rejectUnauthorized ? true : false;
  this._requestCert = requestCert ? true : false;

  this.ssl = new Connection(this.credentials.context,
                            this._isServer ? true : false,
                            this._isServer ? this._requestCert :
                                             options.servername,
                            this._rejectUnauthorized,
                            options.port);

  if (this._isServer) {
    this.ssl.onhandshakestart = onhandshakestart.bind(this);
    this.ssl.onclienthello = onclienthello.bind(this);
    this.ssl.onnewsession = onnewsession.bind(this);
    this.ssl.lastHandshakeTime = 0;
    this.ssl.handshakes = 0;
  }
  // Trireme: Use this on both client and server
  this.ssl.onhandshakedone = onhandshakedone.bind(this);
  this.ssl.onerror = onerror.bind(this);

  if (process.features.tls_sni) {
    if (this._isServer && options.SNICallback) {
      this.ssl.setSNICallback(options.SNICallback);
    }
    this.servername = null;
  }

  if (process.features.tls_npn && options.NPNProtocols) {
    this.ssl.setNPNProtocols(options.NPNProtocols);
    this.npnProtocol = null;
  }

  // Complete initialization of SSL engine
  this.ssl.init();

  /* Acts as a r/w stream to the cleartext side of the stream. */
  this.cleartext = new CleartextStream(this, options.cleartext);

  /* Acts as a r/w stream to the encrypted side of the stream. */
  this.encrypted = new EncryptedStream(this, options.encrypted);

  /* Let streams know about each other */
  this.cleartext._opposite = this.encrypted;
  this.encrypted._opposite = this.cleartext;
  this.cleartext.init();
  this.encrypted.init();

  process.nextTick(function() {
    /* The Connection may be destroyed by an abort call */
    if (self.ssl) {
      self.ssl.start();

      /* In case of cipher suite failures - SSL_accept/SSL_connect may fail */
      if (self.ssl && self.ssl.error)
        self.error();
    }
  });
}

util.inherits(SecurePair, events.EventEmitter);


exports.createSecurePair = function(credentials,
                                    isServer,
                                    requestCert,
                                    rejectUnauthorized) {
  var pair = new SecurePair(credentials,
                            isServer,
                            requestCert,
                            rejectUnauthorized);
  return pair;
};


SecurePair.prototype.maybeInitFinished = function() {
  if (this.ssl && !this._secureEstablished && this.ssl.isInitFinished()) {
    if (process.features.tls_npn) {
      this.npnProtocol = this.ssl.getNegotiatedProtocol();
    }

    if (process.features.tls_sni) {
      this.servername = this.ssl.getServername();
    }

    this._secureEstablished = true;
    debug('secure established');
    this.emit('secure');
  }
};


SecurePair.prototype.destroy = function() {
  if (this._destroying) return;

  if (!this._doneFlag) {
    debug('SecurePair.destroy');
    this._destroying = true;

    // SecurePair should be destroyed only after it's streams
    this.cleartext.destroy();
    this.encrypted.destroy();

    this._doneFlag = true;
    this.ssl.error = null;
    this.ssl.close();
    this.ssl = null;
  }
};


SecurePair.prototype.error = function(returnOnly) {
  var err = this.ssl.error;
  this.ssl.error = null;

  if (!this._secureEstablished) {
    // Emit ECONNRESET instead of zero return
    if (!err || err.message === 'ZERO_RETURN') {
      var connReset = new Error('socket hang up');
      connReset.code = 'ECONNRESET';
      connReset.sslError = err && err.message;

      err = connReset;
    }
    this.destroy();
    if (!returnOnly) this.emit('error', err);
  } else if (this._isServer &&
             this._rejectUnauthorized &&
             /peer did not return a certificate/.test(err.message)) {
    // Not really an error.
    this.destroy();
  } else {
    if (!returnOnly) this.cleartext.emit('error', err);
  }
  return err;
};

// TODO: support anonymous (nocert) and PSK


// AUTHENTICATION MODES
//
// There are several levels of authentication that TLS/SSL supports.
// Read more about this in "man SSL_set_verify".
//
// 1. The server sends a certificate to the client but does not request a
// cert from the client. This is common for most HTTPS servers. The browser
// can verify the identity of the server, but the server does not know who
// the client is. Authenticating the client is usually done over HTTP using
// login boxes and cookies and stuff.
//
// 2. The server sends a cert to the client and requests that the client
// also send it a cert. The client knows who the server is and the server is
// requesting the client also identify themselves. There are several
// outcomes:
//
//   A) verifyError returns null meaning the client's certificate is signed
//   by one of the server's CAs. The server know's the client idenity now
//   and the client is authorized.
//
//   B) For some reason the client's certificate is not acceptable -
//   verifyError returns a string indicating the problem. The server can
//   either (i) reject the client or (ii) allow the client to connect as an
//   unauthorized connection.
//
// The mode is controlled by two boolean variables.
//
// requestCert
//   If true the server requests a certificate from client connections. For
//   the common HTTPS case, users will want this to be false, which is what
//   it defaults to.
//
// rejectUnauthorized
//   If true clients whose certificates are invalid for any reason will not
//   be allowed to make connections. If false, they will simply be marked as
//   unauthorized but secure communication will continue. By default this is
//   true.
//
//
//
// Options:
// - requestCert. Send verify request. Default to false.
// - rejectUnauthorized. Boolean, default to true.
// - key. string.
// - cert: string.
// - ca: string or array of strings.
//
// emit 'secureConnection'
//   function (cleartextStream, encryptedStream) { }
//
//   'cleartextStream' has the boolean property 'authorized' to determine if
//   it was verified by the CA. If 'authorized' is false, a property
//   'authorizationError' is set on cleartextStream and has the possible
//   values:
//
//   "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_CRL",
//   "UNABLE_TO_DECRYPT_CERT_SIGNATURE", "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
//   "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "CERT_SIGNATURE_FAILURE",
//   "CRL_SIGNATURE_FAILURE", "CERT_NOT_YET_VALID" "CERT_HAS_EXPIRED",
//   "CRL_NOT_YET_VALID", "CRL_HAS_EXPIRED" "ERROR_IN_CERT_NOT_BEFORE_FIELD",
//   "ERROR_IN_CERT_NOT_AFTER_FIELD", "ERROR_IN_CRL_LAST_UPDATE_FIELD",
//   "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "OUT_OF_MEM",
//   "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
//   "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
//   "CERT_CHAIN_TOO_LONG", "CERT_REVOKED" "INVALID_CA",
//   "PATH_LENGTH_EXCEEDED", "INVALID_PURPOSE" "CERT_UNTRUSTED",
//   "CERT_REJECTED"
//
//
// TODO:
// cleartext.credentials (by mirroring from pair object)
// cleartext.getCertificate() (by mirroring from pair.credentials.context)
function Server(/* [options], listener */) {
  var options, listener;
  if (typeof arguments[0] == 'object') {
    options = arguments[0];
    listener = arguments[1];
  } else if (typeof arguments[0] == 'function') {
    options = {};
    listener = arguments[0];
  }

  if (!(this instanceof Server)) return new Server(options, listener);

  this._contexts = [];

  var self = this;

  // Handle option defaults:
  this.setOptions(options);

  if (!self.pfx && (!self.cert || !self.key) && !self.keystore) {
    throw new Error('Missing PFX or certificate + private key.');
  }

  // TRIREME: DEFAULT_CIPHERS screws everything up
  var sharedCreds = crypto.createCredentials({
    pfx: self.pfx,
    key: self.key,
    cert: self.cert,
    ca: self.ca,
    ciphers: self.ciphers,
    secureProtocol: self.secureProtocol,
    secureOptions: self.secureOptions,
    crl: self.crl,
    sessionIdContext: self.sessionIdContext,
    keystore: self.keystore,
    passphrase: self.passphrase,
    truststore: self.truststore
  });

  var timeout = options.handshakeTimeout || (120 * 1000);

  if (typeof timeout !== 'number') {
    throw new TypeError('handshakeTimeout must be a number');
  }

  // constructor call
  net.Server.call(this, function(socket) {
    var creds = crypto.createCredentials(null, sharedCreds.context);

    var pair = new SecurePair(creds,
                              true,
                              self.requestCert,
                              self.rejectUnauthorized,
                              {
                                server: self,
                                NPNProtocols: self.NPNProtocols,
                                SNICallback: self.SNICallback,

                                // Stream options
                                cleartext: self._cleartext,
                                encrypted: self._encrypted
                              });

    var cleartext = pipe(pair, socket);
    cleartext._controlReleased = false;

    function listener() {
      pair.emit('error', new Error('TLS handshake timeout'));
    }

    if (timeout > 0) {
      socket.setTimeout(timeout, listener);
    }

    pair.once('secure', function() {
      socket.setTimeout(0, listener);

      pair.cleartext.authorized = false;
      pair.cleartext.npnProtocol = pair.npnProtocol;
      pair.cleartext.servername = pair.servername;

      if (!self.requestCert) {
        cleartext._controlReleased = true;
        self.emit('secureConnection', pair.cleartext, pair.encrypted);
      } else {
        var verifyError = pair.ssl.verifyError();
        if (verifyError) {
          pair.cleartext.authorizationError = verifyError.message;

          if (self.rejectUnauthorized) {
            socket.destroy();
            pair.destroy();
          } else {
            cleartext._controlReleased = true;
            self.emit('secureConnection', pair.cleartext, pair.encrypted);
          }
        } else {
          pair.cleartext.authorized = true;
          cleartext._controlReleased = true;
          self.emit('secureConnection', pair.cleartext, pair.encrypted);
        }
      }
    });
    pair.on('error', function(err) {
      self.emit('clientError', err, this);
    });
  });

  if (listener) {
    this.on('secureConnection', listener);
  }
}

util.inherits(Server, net.Server);
exports.Server = Server;
exports.createServer = function(options, listener) {
  return new Server(options, listener);
};


Server.prototype.setOptions = function(options) {
  if (typeof options.requestCert == 'boolean') {
    this.requestCert = options.requestCert;
  } else {
    this.requestCert = false;
  }

  if (typeof options.rejectUnauthorized == 'boolean') {
    this.rejectUnauthorized = options.rejectUnauthorized;
  } else {
    this.rejectUnauthorized = false;
  }

  if (options.pfx) this.pfx = options.pfx;
  if (options.key) this.key = options.key;
  if (options.passphrase) this.passphrase = options.passphrase;
  if (options.cert) this.cert = options.cert;
  if (options.ca) this.ca = options.ca;
  if (options.secureProtocol) this.secureProtocol = options.secureProtocol;
  if (options.crl) this.crl = options.crl;
  if (options.ciphers) this.ciphers = options.ciphers;
  var secureOptions = options.secureOptions || 0;
  if (options.honorCipherOrder) {
    secureOptions |= constants.SSL_OP_CIPHER_SERVER_PREFERENCE;
  }
  if (secureOptions) this.secureOptions = secureOptions;
  if (options.NPNProtocols) convertNPNProtocols(options.NPNProtocols, this);
  if (options.SNICallback) {
    this.SNICallback = options.SNICallback;
  } else {
    this.SNICallback = this.SNICallback.bind(this);
  }
  if (options.sessionIdContext) {
    this.sessionIdContext = options.sessionIdContext;
  } else if (this.requestCert) {
    this.sessionIdContext = crypto.createHash('md5')
                                  .update(process.argv.join(' '))
                                  .digest('hex');
  }
  if (options.cleartext) this.cleartext = options.cleartext;
  if (options.encrypted) this.encrypted = options.encrypted;
  if (options.keystore) this.keystore = options.keystore;
  if (options.passphrase) this.passphrase = options.passphrase;
  if (options.truststore) this.truststore = options.truststore;
};

// SNI Contexts High-Level API
Server.prototype.addContext = function(servername, credentials) {
  if (!servername) {
    throw 'Servername is required parameter for Server.addContext';
  }

  var re = new RegExp('^' +
                      servername.replace(/([\.^$+?\-\\[\]{}])/g, '\\$1')
                                .replace(/\*/g, '.*') +
                      '$');
  this._contexts.push([re, crypto.createCredentials(credentials).context]);
};

Server.prototype.SNICallback = function(servername) {
  var ctx;

  this._contexts.some(function(elem) {
    if (servername.match(elem[0]) !== null) {
      ctx = elem[1];
      return true;
    }
  });

  return ctx;
};


// Target API:
//
//  var s = tls.connect({port: 8000, host: "google.com"}, function() {
//    if (!s.authorized) {
//      s.destroy();
//      return;
//    }
//
//    // s.socket;
//
//    s.end("hello world\n");
//  });
//
//
function normalizeConnectArgs(listArgs) {
  var args = net._normalizeConnectArgs(listArgs);
  var options = args[0];
  var cb = args[1];

  if (typeof listArgs[1] === 'object') {
    options = util._extend(options, listArgs[1]);
  } else if (typeof listArgs[2] === 'object') {
    options = util._extend(options, listArgs[2]);
  }

  return (cb) ? [options, cb] : [options];
}

exports.connect = function(/* [port, host], options, cb */) {
  var args = normalizeConnectArgs(arguments);
  var options = args[0];
  var cb = args[1];

  var defaults = {
    rejectUnauthorized: '0' !== process.env.NODE_TLS_REJECT_UNAUTHORIZED
  };
  options = util._extend(defaults, options || {});

  var socket = options.socket ? options.socket : new net.Stream();
  var port = options.port ? options.port : -1;

  var sslcontext = crypto.createCredentials(options);

  var NPN = {};
  convertNPNProtocols(options.NPNProtocols, NPN);
  var hostname = options.servername || options.host || 'localhost',
      pair = new SecurePair(sslcontext, false, true,
                            options.rejectUnauthorized === true ? true : false,
                            {
                              NPNProtocols: NPN.NPNProtocols,
                              servername: hostname,
                              port: port,
                              cleartext: options.cleartext,
                              encrypted: options.encrypted
                            });

  if (options.session) {
    var session = options.session;
    if (typeof session === 'string')
      session = new Buffer(session, 'binary');
    pair.ssl.setSession(session);
  }

  var cleartext = pipe(pair, socket);
  if (cb) {
    cleartext.once('secureConnect', cb);
  }

  if (!options.socket) {
    var connect_opt = (options.path && !options.port) ? {path: options.path} : {
      port: options.port,
      host: options.host,
      localAddress: options.localAddress
    };
    socket.connect(connect_opt);
  }

  pair.on('secure', function() {
    var verifyError = pair.ssl.verifyError();
    if (debugEnabled) {
      debug('on secure. Verify error = ' +  pair.ssl.verifyError());
    }

    cleartext.npnProtocol = pair.npnProtocol;

    // Verify that server's identity matches it's certificate's names
    if (!verifyError) {
      var validCert = checkServerIdentity(hostname,
                                          pair.cleartext.getPeerCertificate());
      if (!validCert) {
        if (debugEnabled) {
          debug(util.format('Failed check for "%s" against %j', hostname, pair.cleartext.getPeerCertificate()));
        }
        verifyError = new Error('Hostname/IP doesn\'t match certificate\'s ' +
                                'altnames');
      }
    }

    if (verifyError) {
      cleartext.authorized = false;
      cleartext.authorizationError = verifyError.message;

      if (pair._rejectUnauthorized) {
        cleartext.emit('error', verifyError);
        pair.destroy();
      } else {
        cleartext.emit('secureConnect');
      }
    } else {
      cleartext.authorized = true;
      cleartext.emit('secureConnect');
    }
  });
  pair.on('error', function(err) {
    cleartext.emit('error', err);
  });

  cleartext._controlReleased = true;
  return cleartext;
};


function pipe(pair, socket) {
  pair.encrypted.pipe(socket);
  socket.pipe(pair.encrypted);

  pair.encrypted.on('close', function() {
    process.nextTick(function() {
      // Encrypted should be unpiped from socket to prevent possible
      // write after destroy.
      pair.encrypted.unpipe(socket);
      socket.destroySoon();
    });
  });

  pair.fd = socket.fd;
  var cleartext = pair.cleartext;
  cleartext.socket = socket;
  cleartext.encrypted = pair.encrypted;
  cleartext.authorized = false;

  // cycle the data whenever the socket drains, so that
  // we can pull some more into it.  normally this would
  // be handled by the fact that pipe() triggers read() calls
  // on writable.drain, but CryptoStreams are a bit more
  // complicated.  Since the encrypted side actually gets
  // its data from the cleartext side, we have to give it a
  // light kick to get in motion again.
  socket.on('drain', function() {
    if (pair.encrypted._pending)
      pair.encrypted._writePending();
    if (pair.cleartext._pending)
      pair.cleartext._writePending();
    pair.encrypted.read(0);
    pair.cleartext.read(0);
  });

  function onerror(e) {
    if (cleartext._controlReleased) {
      cleartext.emit('error', e);
    }
  }

  function onclose() {
    socket.removeListener('error', onerror);
    socket.removeListener('timeout', ontimeout);
  }

  function ontimeout() {
    cleartext.emit('timeout');
  }

  socket.on('error', onerror);
  socket.on('close', onclose);
  socket.on('timeout', ontimeout);

  return cleartext;
}
