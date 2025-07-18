// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

define([
    '/api/config',
    '/file/file-crypto.js',
    '/common/common-hash.js',
    '/common/common-util.js',
    '/common/cache-store.js',
    '/common/outer/http-command.js',
    '/components/chainpad-crypto/crypto.js',
    '/components/nthen/index.js',
], function (ApiConfig, FileCrypto, Hash, Util, Cache, ServerCommand, Crypto, nThen) {
    var module = {};
    const USE_WS = false;

    module.uploadU8 = function (common, data, cb) {
        var teamId = data.teamId;
        var u8 = data.u8;
        var metadata = data.metadata;
        var key = data.key;

        var onError = data.onError || function () {};
        var onPending = data.onPending || function () {};
        var updateProgress = data.updateProgress || function () {};
        var owned = data.owned;
        var id = data.id;

        var next = FileCrypto.encrypt(u8, metadata, key);

        var estimate = FileCrypto.computeEncryptedSize(u8.length, metadata);



        var sendChunkWs = function (box, cb) {
            var enc = Util.encodeBase64(box);
            common.uploadChunk(teamId, enc, function (e, msg) {
                cb(e, msg);
            });
        };


        let uploadUrl = '/upload-blob';
        let keys, cookie;
        if (ApiConfig.fileHost) {
            const origin = new URL(ApiConfig.fileHost).origin;
            uploadUrl = origin + uploadUrl;
        }
        var sendChunk = function (box, cb) {
            const enc = Util.encodeBase64(box);

            const c = Util.decodeUTF8(cookie);
            const sig_str = window.nacl.sign(c, keys.secretKey);
            const sig = Util.encodeBase64(sig_str);

            const body = {
                chunk: enc,
                sig: sig,
                edPublic: keys.edPublic
            };

            fetch(uploadUrl, {
                method: 'post',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            }).then(res => res.json())
              .then(json => {
                if (json?.error) {
                    return cb(json.error);
                }
                cookie = json.cookie;
                cb();
            }).catch(cb);
        };

        var actual = 0;
        var encryptedArr = [];
        var again = function (err, box) {
            if (err) { onError(err); }
            if (box) {
                encryptedArr.push(box);
                actual += box.length;
                var progressValue = (actual / estimate * 100);
                progressValue = Math.min(progressValue, 100);
                updateProgress(progressValue);

                let send = sendChunk;
                if (USE_WS) {
                    send = sendChunkWs;
                }
                return void send(box, function (e) {
                    if (e) { return console.error(e); }
                    next(again);
                });
            }

            if (actual !== estimate) {
                console.error('Estimated size does not match actual size');
            }

            // if not box then done
            common.uploadComplete(teamId, id, owned, function (e) {
                if (e) { return void console.error(e); }
                var uri = ['', 'blob', id.slice(0,2), id].join('/');
                console.log("encrypted blob is now available as %s", uri);

                var box_u8 = Util.uint8ArrayJoin(encryptedArr);
                Cache.setBlobCache(id, box_u8, function (err) {
                    if (err) { console.warn(err); }
                    cb();
                });
            });
        };

        const startUpload = () => {
            if (USE_WS) {
                return void next(again);
            }
            common.getAccessKeys(arr => {
                const myKeys = arr.find(obj => {
                    return (!obj.id && !teamId) || +obj.id === +teamId;
                });
                if (!myKeys) { return void onError('NO_KEYS'); }
                keys = {
                    edPublic: myKeys.edPublic,
                    publicKey: Util.decodeBase64(myKeys.edPublic),
                    secretKey: Util.decodeBase64(myKeys.edPrivate)
                };
                ServerCommand(keys, {
                    command: 'UPLOAD_COOKIE',
                }, (err, data) => {
                    cookie = data?.cookie;
                    if (err || !cookie) { return void onError(err || 'NOCOOKIE'); }
                    next(again);
                });
            });
        };

        common.uploadStatus(teamId, estimate, function (e, pending) {
            if (e) {
                console.error(e);
                onError(e);
                return;
            }

            if (pending) {
                return void onPending(function () {
                    // if the user wants to cancel the pending upload to execute that one
                    common.uploadCancel(teamId, estimate, function (e) {
                        if (e) {
                            return void console.error(e);
                        }
                        startUpload();
                    });
                });
            }
            startUpload();
        });
    };

    module.upload = function (file, noStore, common, updateProgress, onComplete, onError, onPending) {
        var u8 = file.blob; // This is not a blob but a uint8array
        var metadata = file.metadata;

        var owned = file.owned;
        var teamId = file.teamId;

        // if it exists, path contains the new pad location in the drive
        var path = file.path;

        var password = file.password;
        var forceSave = file.forceSave;
        var hash, secret, key, id, href;

        var getNewHash = function () {
            hash = Hash.createRandomHash('file', password);
            secret = Hash.getSecrets('file', hash, password);
            key = secret.keys.cryptKey;
            id = secret.channel;
            href = '/file/#' + hash;
        };

        var getValidHash = function (cb) {
            getNewHash();
            common.getFileSize(href, password, function (err, size) {
                if (err || typeof(size) !== "number") {  throw new Error(err || "Invalid size!"); }
                if (size === 0) { return void cb(); }
                getValidHash();
            });
        };

        var edPublic;
        nThen(function (waitFor) {
            // Generate a hash and check if the resulting id is valid (not already used)
            getValidHash(waitFor());
        }).nThen(function (waitFor) {
            if (!owned) { return; }
            common.getEdPublic(teamId, waitFor(function (obj) {
                if (obj && obj.error) { return; }
                edPublic = obj;
                metadata.owners = [edPublic];
            }));
        }).nThen(function () {
            module.uploadU8(common, {
                teamId: teamId,
                u8: u8,
                metadata: metadata,
                key: key,
                id: id,
                owned: owned,
                onError: onError,
                onPending: onPending,
                updateProgress: updateProgress,
            }, function () {
                if (noStore) { return void onComplete(href); }

                var title = metadata.name;
                var data = {
                    teamId: teamId,
                    title: title || "",
                    href: href,
                    path: path,
                    password: password,
                    channel: id,
                    owners: metadata.owners,
                    forceSave: forceSave
                };
                common.setPadTitle(data, function (err) {
                    if (err) { return void console.error(err); }
                    onComplete(href);
                    common.setPadAttribute('fileType', metadata.type, null, href);
                    common.setPadAttribute('owners', metadata.owners, null, href);
                });
            });
        });

    };
    return module;
});
