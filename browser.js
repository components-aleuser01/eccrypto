/**
 * Browser eccrypto implementation.
 */

"use strict";

var EC = require("elliptic").ec;

var ec = new EC("secp256k1");
var cryptoObj = window.crypto || window.msCrypto || {};
var subtle = cryptoObj.subtle || cryptoObj.webkitSubtle;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function randomBytes(size) {
  var arr = new Uint8Array(size);
  window.crypto.getRandomValues(arr);
  return new Buffer(arr);
}

function sha512(msg) {
  return subtle.digest({name: "SHA-512"}, msg).then(function(hash) {
    return new Buffer(new Uint8Array(hash));
  });
}

function getAes(op) {
  return function(iv, key, data) {
    var importAlgorithm = {name: "AES-CBC"};
    var keyp = subtle.importKey("raw", key, importAlgorithm, false, [op]);
    return keyp.then(function(cryptoKey) {
      var encAlgorithm = {name: "AES-CBC", iv: iv};
      return subtle[op](encAlgorithm, cryptoKey, data);
    }).then(function(result) {
      return new Buffer(new Uint8Array(result));
    });
  };
}

var aesCbcEncrypt = getAes("encrypt");
var aesCbcDecrypt = getAes("decrypt");

function hmacSha256Sign(key, msg) {
  var algorithm = {name: "HMAC", hash: {name: "SHA-256"}};
  var keyp = subtle.importKey("raw", key, algorithm, false, ["sign"]);
  return keyp.then(function(cryptoKey) {
    return subtle.sign(algorithm, cryptoKey, msg);
  }).then(function(sig) {
    return new Buffer(new Uint8Array(sig));
  });
}

function hmacSha256Verify(key, msg, sig) {
  var algorithm = {name: "HMAC", hash: {name: "SHA-256"}};
  var keyp = subtle.importKey("raw", key, algorithm, false, ["verify"]);
  return keyp.then(function(cryptoKey) {
    return subtle.verify(algorithm, cryptoKey, sig, msg);
  });
}

var getPublic = exports.getPublic = function(privateKey) {
  // This function has sync API so we throw an error immediately.
  assert(privateKey.length === 32, "Bad private key");
  // XXX(Kagami): `elliptic.utils.encode` returns array for every
  // encoding except `hex`.
  return new Buffer(ec.keyFromPrivate(privateKey).getPublic("arr"));
};

// NOTE(Kagami): We don't use promise shim in Browser implementation
// because it's supported natively in new browsers (see
// <http://caniuse.com/#feat=promises>) and we can use only new browsers
// because of the WebCryptoAPI (see
// <http://caniuse.com/#feat=cryptography>).
exports.sign = function(privateKey, msg) {
  return new Promise(function(resolve) {
    assert(privateKey.length === 32, "Bad private key");
    assert(msg.length > 0, "Message should not be empty");
    assert(msg.length <= 32, "Message is too long");
    resolve(new Buffer(ec.sign(msg, privateKey, {canonical: true}).toDER()));
  });
};

exports.verify = function(publicKey, msg, sig) {
  return new Promise(function(resolve, reject) {
    assert(publicKey.length === 65, "Bad public key");
    assert(publicKey[0] === 4, "Bad public key");
    assert(msg.length > 0, "Message should not be empty");
    assert(msg.length <= 32, "Message is too long");
    if (ec.verify(msg, sig, publicKey)) {
      resolve(null);
    } else {
      reject(new Error("Bad signature"));
    }
  });
};

var derive = exports.derive = function(privateKeyA, publicKeyB) {
  return new Promise(function(resolve) {
    assert(privateKeyA.length === 32, "Bad private key");
    assert(publicKeyB.length === 65, "Bad public key");
    assert(publicKeyB[0] === 4, "Bad public key");
    var keyA = ec.keyFromPrivate(privateKeyA);
    var keyB = ec.keyFromPublic(publicKeyB);
    var Px = keyA.derive(keyB.getPublic());  // BN instance
    resolve(new Buffer(Px.toArray()));
  });
};

exports.encrypt = function(publicKeyTo, msg, opts) {
  assert(subtle, "WebCryptoAPI is not available");
  opts = opts || {};
  // Tmp variables to save context from flat promises;
  var iv, ephemPublicKey, ciphertext, macKey;
  return new Promise(function(resolve) {
    var ephemPrivateKey = opts.ephemPrivateKey || randomBytes(32);
    ephemPublicKey = getPublic(ephemPrivateKey);
    resolve(derive(ephemPrivateKey, publicKeyTo));
  }).then(function(Px) {
    return sha512(Px);
  }).then(function(hash) {
    iv = opts.iv || randomBytes(16);
    var encryptionKey = hash.slice(0, 32);
    macKey = hash.slice(32);
    return aesCbcEncrypt(iv, encryptionKey, msg);
  }).then(function(data) {
    ciphertext = data;
    var dataToMac = Buffer.concat([iv, ephemPublicKey, ciphertext]);
    return hmacSha256Sign(macKey, dataToMac);
  }).then(function(mac) {
    return {
      iv: iv,
      ephemPublicKey: ephemPublicKey,
      ciphertext: ciphertext,
      mac: mac,
    };
  });
};

exports.decrypt = function(privateKey, opts) {
  assert(subtle, "WebCryptoAPI is not available");
  // Tmp variable to save context from flat promises;
  var encryptionKey;
  return derive(privateKey, opts.ephemPublicKey).then(function(Px) {
    return sha512(Px);
  }).then(function(hash) {
    encryptionKey = hash.slice(0, 32);
    var macKey = hash.slice(32);
    var dataToMac = Buffer.concat([
      opts.iv,
      opts.ephemPublicKey,
      opts.ciphertext
    ]);
    return hmacSha256Verify(macKey, dataToMac, opts.mac);
  }).then(function(macGood) {
    assert(macGood, "Bad MAC");
    return aesCbcDecrypt(opts.iv, encryptionKey, opts.ciphertext);
  }).then(function(msg) {
    return new Buffer(new Uint8Array(msg));
  });
};
