// ==UserScript==
// @name         E-Hentai Upload Queue Helper
// @namespace    local.eh.upload.queue
// @version      0.3.0
// @description  Queue uploader for upload.e-hentai.org images and zip archives, with auto compression, settings save, and persistent file-handle resume
// @match        https://upload.e-hentai.org/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const MB = 1024 * 1024;
    const MAX_UPLOAD_MB = 500;
    const MAX_IMAGES_PER_BATCH = 2000;
    const MAX_DIMENSION = 20000;

    const COMPRESS_OUTPUT_TYPE = "image/webp";
    const COMPRESS_OUTPUT_EXT = "webp";
    const COMPRESS_SAFETY_RATIO = 0.98;
    const COMPRESS_MAX_CANVAS_PIXELS = 80 * 1000 * 1000;
    const COMPRESS_MAX_CANVAS_SIDE = 16000;
    const COMPRESS_MAX_ROUNDS = 18;
    const COMPRESS_SCALE_STEP = 0.82;

    const LIVE_UPDATE_INTERVAL_MS = 10000;
    const PANEL_MINIMIZED_KEY = "ehq_panel_minimized_v1";
    const SETTINGS_KEY = "ehq_settings_v1";
    const PERSIST_DB_NAME = "ehq_persistent_queue_db_v1";
    const PERSIST_STORE_NAME = "kv";
    const PERSIST_SESSION_KEY = "active_session";
    const PERSIST_AUTO_RESUME_DELAY_MS = 2000;

    const IMAGE_RULES = {
        jpg: 20 * MB,
        jpeg: 20 * MB,
        webp: 20 * MB,
        png: 50 * MB,
        gif: 10 * MB,
    };

    const state = {
        files: [],
        validFiles: [],
        validItems: [],
        invalidFiles: [],
        queue: [],
        running: false,
        stopRequested: false,
        currentIndex: 0,
        persistentMode: false,
        restoredPersistentSession: false,
        activeMode: "auto",
    };

    const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
    });

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function formatMB(bytes) {
        return (bytes / MB).toFixed(2) + " MB";
    }

    function getExt(file) {
        const name = file.name || "";
        const i = name.lastIndexOf(".");
        return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
    }

    function sortFiles(files) {
        return files.slice().sort((a, b) => {
            const an = getFileMeta(a)?.path || a.webkitRelativePath || a.name;
            const bn = getFileMeta(b)?.path || b.webkitRelativePath || b.name;
            return collator.compare(an, bn);
        });
    }

    function getProgressText() {
        const el = document.querySelector("#progress_readout");
        return el ? el.innerText.trim() : "";
    }

    function getUploadInput() {
        return document.querySelector("#uploadfiles");
    }

    function getUploadButton() {
        return document.querySelector("#uploadbutton");
    }

    function isUploadButtonBusy(button) {
        if (!button) return false;
        const txt = (button.innerText || button.value || "").trim();
        return button.disabled || /上传中|Uploading|Processing/i.test(txt);
    }

    function log(msg) {
        const box = document.querySelector("#ehq-log");
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log("[EHQ]", msg);

        if (box) {
            box.textContent += line + "\n";
            box.scrollTop = box.scrollHeight;
        }
    }

    function live(msg) {
        const el = document.querySelector("#ehq-live");
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log("[EHQ-LIVE]", msg);
        if (el) el.textContent = line;
    }

    function setStatus(msg) {
        const el = document.querySelector("#ehq-status");
        if (el) el.textContent = msg;
    }

    function getUserLimitBytes() {
        const input = document.querySelector("#ehq-limit");
        let mb = Number(input.value || 0);

        if (!Number.isFinite(mb) || mb <= 0) {
            mb = 450;
            input.value = "450";
        }

        if (mb > MAX_UPLOAD_MB) {
            mb = MAX_UPLOAD_MB;
            input.value = String(MAX_UPLOAD_MB);
            alert("单次上传不能超过 500 MB，已自动改为 500 MB。");
        }

        return mb * MB;
    }

    function getMode() {
        return document.querySelector("#ehq-mode").value;
    }

    function getAutoCompress() {
        const el = document.querySelector("#ehq-autocompress");
        return el ? el.checked : true;
    }

    function getAllowGifFirstFrame() {
        const el = document.querySelector("#ehq-gif-first-frame");
        return el ? el.checked : false;
    }

    function getAutoStartAfterGroup() {
        const el = document.querySelector("#ehq-autostart");
        return el ? el.checked : false;
    }


    function getStoredSettings() {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
        } catch (err) {
            return {};
        }
    }

    function saveSettings() {
        const settings = {
            mode: document.querySelector("#ehq-mode")?.value || "auto",
            limitMB: document.querySelector("#ehq-limit")?.value || "450",
            autoCompress: !!document.querySelector("#ehq-autocompress")?.checked,
            gifFirstFrame: !!document.querySelector("#ehq-gif-first-frame")?.checked,
            autoStart: !!document.querySelector("#ehq-autostart")?.checked,
        };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function loadSettingsToPanel() {
        const settings = getStoredSettings();

        const mode = document.querySelector("#ehq-mode");
        const limit = document.querySelector("#ehq-limit");
        const autoCompress = document.querySelector("#ehq-autocompress");
        const gifFirstFrame = document.querySelector("#ehq-gif-first-frame");
        const autoStart = document.querySelector("#ehq-autostart");

        if (mode && settings.mode) mode.value = settings.mode;
        if (limit && settings.limitMB) limit.value = settings.limitMB;
        if (autoCompress && typeof settings.autoCompress === "boolean") autoCompress.checked = settings.autoCompress;
        if (gifFirstFrame && typeof settings.gifFirstFrame === "boolean") gifFirstFrame.checked = settings.gifFirstFrame;
        if (autoStart && typeof settings.autoStart === "boolean") autoStart.checked = settings.autoStart;
    }

    function bindSettingsSave() {
        for (const id of ["#ehq-mode", "#ehq-limit", "#ehq-autocompress", "#ehq-gif-first-frame", "#ehq-autostart"]) {
            const el = document.querySelector(id);
            if (!el) continue;
            el.addEventListener("change", saveSettings);
            el.addEventListener("input", saveSettings);
        }
    }

    function openPersistentDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(PERSIST_DB_NAME, 1);

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(PERSIST_STORE_NAME)) {
                    db.createObjectStore(PERSIST_STORE_NAME);
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("打开 IndexedDB 失败"));
        });
    }

    async function idbGet(key) {
        const db = await openPersistentDB();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(PERSIST_STORE_NAME, "readonly");
                const store = tx.objectStore(PERSIST_STORE_NAME);
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error || new Error("读取 IndexedDB 失败"));
            });
        } finally {
            db.close();
        }
    }

    async function idbSet(key, value) {
        const db = await openPersistentDB();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(PERSIST_STORE_NAME, "readwrite");
                const store = tx.objectStore(PERSIST_STORE_NAME);
                const req = store.put(value, key);
                req.onsuccess = () => resolve(true);
                req.onerror = () => reject(req.error || new Error("写入 IndexedDB 失败"));
            });
        } finally {
            db.close();
        }
    }

    async function idbDelete(key) {
        const db = await openPersistentDB();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(PERSIST_STORE_NAME, "readwrite");
                const store = tx.objectStore(PERSIST_STORE_NAME);
                const req = store.delete(key);
                req.onsuccess = () => resolve(true);
                req.onerror = () => reject(req.error || new Error("删除 IndexedDB 失败"));
            });
        } finally {
            db.close();
        }
    }

    function supportsPersistentHandles() {
        return !!window.showOpenFilePicker && !!window.showDirectoryPicker && !!window.indexedDB;
    }

    function getFileMeta(file) {
        return file && file.__ehqMeta ? file.__ehqMeta : null;
    }

    function attachFileMeta(file, meta) {
        try {
            Object.defineProperty(file, "__ehqMeta", {
                value: meta,
                configurable: true,
            });
        } catch (err) {
            file.__ehqMeta = meta;
        }
        return file;
    }

    function makeEntryId(path, index) {
        return `${index}::${path}`;
    }

    function createPersistentItem(file, options) {
        const meta = getFileMeta(file);
        if (!state.persistentMode || !meta || !meta.handle) return null;

        return {
            id: meta.id,
            path: meta.path,
            name: file.name,
            ext: getExt(file),
            handle: meta.handle,
            originalSize: file.size,
            finalSize: options.finalSize,
            finalName: options.finalName || file.name,
            compressed: !!options.compressed,
            targetBytes: options.targetBytes || 0,
        };
    }

    function addValidPersistentItem(file, options) {
        const item = createPersistentItem(file, options);
        if (item) {
            if (options.cachedFile) item.cachedFile = options.cachedFile;
            state.validItems.push(item);
        }
    }

    function serializeItemForDB(item) {
        return {
            id: item.id,
            path: item.path,
            name: item.name,
            ext: item.ext,
            handle: item.handle,
            originalSize: item.originalSize,
            finalSize: item.finalSize,
            finalName: item.finalName,
            compressed: item.compressed,
            targetBytes: item.targetBytes,
        };
    }

    function serializeQueueForDB(queue) {
        return queue.map(batch => ({
            bytes: batch.bytes,
            label: batch.label,
            items: (batch.items || []).map(serializeItemForDB),
        }));
    }

    async function savePersistentSession() {
        if (!state.persistentMode || !state.queue.length) return;

        const session = {
            version: 1,
            updatedAt: Date.now(),
            mode: state.activeMode,
            currentIndex: state.currentIndex || 0,
            queue: serializeQueueForDB(state.queue),
        };

        await idbSet(PERSIST_SESSION_KEY, session);
    }

    async function clearPersistentSession() {
        await idbDelete(PERSIST_SESSION_KEY);
    }

    async function hasReadPermission(handle) {
        if (!handle || !handle.queryPermission) return true;
        try {
            return await handle.queryPermission({ mode: "read" }) === "granted";
        } catch (err) {
            return false;
        }
    }

    async function ensureReadPermission(handle) {
        if (!handle || !handle.queryPermission) return true;

        let perm = await handle.queryPermission({ mode: "read" });
        if (perm === "granted") return true;

        if (!handle.requestPermission) {
            throw new Error("浏览器没有提供文件句柄授权接口");
        }

        perm = await handle.requestPermission({ mode: "read" });
        if (perm !== "granted") {
            throw new Error("没有读取本地文件的权限，请点击“继续持久队列”并允许授权");
        }

        return true;
    }

    async function collectDirectoryFileHandles(dirHandle, basePath = "") {
        const result = [];

        for await (const [name, handle] of dirHandle.entries()) {
            const path = basePath ? `${basePath}/${name}` : name;

            if (handle.kind === "file") {
                result.push({ handle, path });
            } else if (handle.kind === "directory") {
                const children = await collectDirectoryFileHandles(handle, path);
                result.push(...children);
            }
        }

        return result;
    }

    async function loadFilesFromPersistentHandleEntries(entries) {
        const files = [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            await ensureReadPermission(entry.handle);
            const file = await entry.handle.getFile();

            attachFileMeta(file, {
                id: makeEntryId(entry.path || file.name, i),
                path: entry.path || file.name,
                handle: entry.handle,
                persistent: true,
            });

            files.push(file);
            live(`读取持久文件 ${i + 1} / ${entries.length}: ${entry.path || file.name}`);
        }

        return sortFiles(files);
    }

    async function choosePersistentFiles() {
        if (!supportsPersistentHandles()) {
            alert("当前浏览器不支持持久文件句柄。建议使用最新版 Chrome 或 Edge。");
            return;
        }

        const handles = await window.showOpenFilePicker({
            multiple: true,
            excludeAcceptAllOption: false,
            types: [{
                description: "Images or ZIP",
                accept: {
                    "image/*": [".jpg", ".jpeg", ".webp", ".png", ".gif", ".bmp", ".avif"],
                    "application/zip": [".zip"],
                },
            }],
        });

        const entries = handles.map(handle => ({ handle, path: handle.name }));
        await startPersistentSelection(entries, "已持久选择");
    }

    async function choosePersistentFolder() {
        if (!supportsPersistentHandles()) {
            alert("当前浏览器不支持持久文件夹句柄。建议使用最新版 Chrome 或 Edge。");
            return;
        }

        const dirHandle = await window.showDirectoryPicker({ mode: "read" });
        const entries = await collectDirectoryFileHandles(dirHandle, dirHandle.name);
        await startPersistentSelection(entries, "已持久选择文件夹");
    }

    async function startPersistentSelection(entries, prefix) {
        if (!entries.length) {
            alert("没有读取到文件。");
            return;
        }

        await clearPersistentSession();

        state.persistentMode = true;
        state.restoredPersistentSession = false;
        state.validFiles = [];
        state.validItems = [];
        state.invalidFiles = [];
        state.queue = [];
        state.currentIndex = 0;

        setStatus(`${prefix} ${entries.length} 个文件，正在读取文件信息。`);
        live(`${prefix} ${entries.length} 个文件，正在读取文件信息。`);

        state.files = await loadFilesFromPersistentHandleEntries(entries);

        setStatus(`${prefix} ${state.files.length} 个文件。请点击“检查并分组”。`);
        live(`${prefix} ${state.files.length} 个文件。`);
        log(`${prefix} ${state.files.length} 个文件。此模式支持页面刷新后继续队列。`);
    }

    function getBatchCount(batch) {
        return batch.items ? batch.items.length : batch.files.length;
    }

    function getBatchLine(index, total, batch) {
        return `正在上传 ${index + 1}/${total} 组，${getBatchCount(batch)} 个文件，${formatMB(batch.bytes)}。`;
    }

    function extractUploadPercent(text) {
        const s = (text || "").replace(/\s+/g, " ");
        const m = s.match(/上传中[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) ||
            s.match(/Uploading[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) ||
            s.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
        return m ? `${m[1]}%` : "等待网页更新";
    }

    async function materializeBatchFiles(batch) {
        if (!batch.items) return batch.files;

        const files = [];

        for (let i = 0; i < batch.items.length; i++) {
            const item = batch.items[i];

            if (item.cachedFile) {
                files.push(item.cachedFile);
                continue;
            }

            await ensureReadPermission(item.handle);
            const original = await item.handle.getFile();

            if (item.compressed) {
                live(`重新压缩队列文件 ${i + 1} / ${batch.items.length}: ${item.path}`);
                const compressed = await compressImageFile(original, item.targetBytes);
                item.cachedFile = compressed.file;
                files.push(compressed.file);
            } else {
                files.push(original);
            }
        }

        return files;
    }

    async function restorePersistentSession() {
        let session = null;

        try {
            session = await idbGet(PERSIST_SESSION_KEY);
        } catch (err) {
            log(`读取持久队列失败：${err.message}`);
            return;
        }

        if (!session || !session.queue || !session.queue.length) return;

        state.persistentMode = true;
        state.restoredPersistentSession = true;
        state.queue = session.queue;
        state.currentIndex = Math.max(0, Math.min(session.currentIndex || 0, session.queue.length));
        state.activeMode = session.mode || "auto";

        if (state.currentIndex >= state.queue.length) {
            await clearPersistentSession();
            return;
        }

        const nextBatch = state.queue[state.currentIndex];
        setStatus(`检测到持久队列：将从 ${state.currentIndex + 1}/${state.queue.length} 组继续。`);
        live(getBatchLine(state.currentIndex, state.queue.length, nextBatch));
        log(`检测到持久队列：共 ${state.queue.length} 组，将从第 ${state.currentIndex + 1} 组继续。`);

        const allGranted = await Promise.all(
            (nextBatch.items || []).map(item => hasReadPermission(item.handle))
        ).then(values => values.every(Boolean)).catch(() => false);

        if (allGranted) {
            setTimeout(() => {
                if (!state.running) startQueue();
            }, PERSIST_AUTO_RESUME_DELAY_MS);
        } else {
            live("需要点击“继续持久队列”授权读取文件，然后继续。");
        }
    }

function stripExt(name) {
        const i = name.lastIndexOf(".");
        return i >= 0 ? name.slice(0, i) : name;
    }

    function makeCompressedName(file) {
        const oldName = file.name || "image";
        return stripExt(oldName) + "_compressed." + COMPRESS_OUTPUT_EXT;
    }

    function loadImageSize(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();

            img.onload = () => {
                const result = {
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                };
                URL.revokeObjectURL(url);
                resolve(result);
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("Cannot read image"));
            };

            img.src = url;
        });
    }

    function loadImageElement(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();

            img.onload = () => {
                resolve({ img, url });
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("浏览器无法读取这张图片"));
            };

            img.src = url;
        });
    }

    function canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (!blob) {
                    reject(new Error("Canvas 导出失败"));
                    return;
                }
                resolve(blob);
            }, type, quality);
        });
    }

    function makeFileFromBlob(blob, sourceFile, width, height, quality, round) {
        const newFile = new File(
            [blob],
            makeCompressedName(sourceFile),
            {
                type: COMPRESS_OUTPUT_TYPE,
                lastModified: Date.now(),
            }
        );

        return {
            file: newFile,
            width,
            height,
            quality,
            round,
        };
    }

    async function compressImageFile(file, targetBytes) {
        const { img, url } = await loadImageElement(file);

        try {
            const srcW = img.naturalWidth;
            const srcH = img.naturalHeight;

            if (!srcW || !srcH) {
                throw new Error("无法读取图片尺寸");
            }

            let scale = Math.min(
                1,
                MAX_DIMENSION / srcW,
                MAX_DIMENSION / srcH,
                COMPRESS_MAX_CANVAS_SIDE / srcW,
                COMPRESS_MAX_CANVAS_SIDE / srcH
            );

            let scaledPixels = srcW * srcH * scale * scale;
            if (scaledPixels > COMPRESS_MAX_CANVAS_PIXELS) {
                scale *= Math.sqrt(COMPRESS_MAX_CANVAS_PIXELS / scaledPixels);
            }

            const qualities = [0.92, 0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44, 0.38, 0.32, 0.26, 0.2];
            let best = null;
            let lastError = null;

            for (let round = 1; round <= COMPRESS_MAX_ROUNDS; round++) {
                const w = Math.max(1, Math.floor(srcW * scale));
                const h = Math.max(1, Math.floor(srcH * scale));

                if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
                    scale *= COMPRESS_SCALE_STEP;
                    continue;
                }

                if (w * h > COMPRESS_MAX_CANVAS_PIXELS) {
                    scale *= Math.sqrt(COMPRESS_MAX_CANVAS_PIXELS / (w * h)) * 0.98;
                    continue;
                }

                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;

                    const ctx = canvas.getContext("2d", {
                        alpha: true,
                        desynchronized: true,
                    });

                    if (!ctx) {
                        throw new Error("无法创建 Canvas 2D 上下文");
                    }

                    ctx.drawImage(img, 0, 0, w, h);

                    for (const q of qualities) {
                        const blob = await canvasToBlob(canvas, COMPRESS_OUTPUT_TYPE, q);

                        if (!best || blob.size < best.blob.size) {
                            best = { blob, width: w, height: h, quality: q, round };
                        }

                        if (blob.size <= targetBytes) {
                            return makeFileFromBlob(blob, file, w, h, q, round);
                        }
                    }
                } catch (err) {
                    lastError = err;
                }

                scale *= COMPRESS_SCALE_STEP;
            }

            if (best) {
                throw new Error(
                    `压缩 ${COMPRESS_MAX_ROUNDS} 轮后仍超过限制，最小结果 ${formatMB(best.blob.size)}，目标 ${formatMB(targetBytes)}`
                );
            }

            throw new Error(lastError ? lastError.message : "压缩失败，未能生成有效结果");
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function validateFiles() {
        const mode = getMode();
        const limitBytes = getUserLimitBytes();
        const autoCompress = getAutoCompress();
        const allowGifFirstFrame = getAllowGifFirstFrame();

        state.validFiles = [];
        state.validItems = [];
        state.invalidFiles = [];
        state.queue = [];
        state.currentIndex = 0;

        const files = sortFiles(state.files);

        if (!files.length) {
            alert("请先选择文件。");
            return false;
        }

        const hasZip = files.some(f => getExt(f) === "zip");
        const hasImage = files.some(f => {
            const ext = getExt(f);
            return IMAGE_RULES[ext] || (f.type && f.type.startsWith("image/"));
        });

        let actualMode = mode;

        if (mode === "auto") {
            if (hasZip && !hasImage) {
                actualMode = "zip";
            } else if (hasImage && !hasZip) {
                actualMode = "image";
            } else {
                alert("不要混合选择图片和 ZIP。请分开上传。");
                return false;
            }
        }

        state.activeMode = actualMode;

        log(`开始检查文件，模式：${actualMode === "zip" ? "ZIP" : "图片"}`);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ext = getExt(file);
            const displayName = getFileMeta(file)?.path || file.webkitRelativePath || file.name;

            setStatus(`正在检查 ${i + 1} / ${files.length}: ${displayName}`);
            live(`检查中 ${i + 1} / ${files.length}: ${displayName}`);

            if (actualMode === "zip") {
                if (ext !== "zip") {
                    state.invalidFiles.push([file, "不是 ZIP 文件"]);
                    continue;
                }

                if (file.size > MAX_UPLOAD_MB * MB) {
                    state.invalidFiles.push([file, "ZIP 超过 500 MB"]);
                    continue;
                }

                if (file.size > limitBytes) {
                    state.invalidFiles.push([file, "ZIP 超过你设置的单次上限"]);
                    continue;
                }

                state.validFiles.push(file);
                addValidPersistentItem(file, {
                    finalSize: file.size,
                    finalName: file.name,
                    compressed: false,
                });
                continue;
            }

            if (actualMode === "image") {
                const isAllowedImageExt = !!IMAGE_RULES[ext];
                const isImageCandidate =
                    isAllowedImageExt ||
                    (file.type && file.type.startsWith("image/"));

                if (!isImageCandidate) {
                    state.invalidFiles.push([file, "不是图片文件"]);
                    continue;
                }

                let size;

                try {
                    size = await loadImageSize(file);
                } catch (err) {
                    state.invalidFiles.push([file, "浏览器无法读取图片"]);
                    continue;
                }

                const siteSizeLimit = IMAGE_RULES[ext];
                const legalBySite =
                    isAllowedImageExt &&
                    file.size <= siteSizeLimit &&
                    size.width <= MAX_DIMENSION &&
                    size.height <= MAX_DIMENSION;

                const legalByUserLimit = file.size <= limitBytes;

                if (legalBySite && legalByUserLimit) {
                    state.validFiles.push(file);
                    addValidPersistentItem(file, {
                        finalSize: file.size,
                        finalName: file.name,
                        compressed: false,
                    });
                    continue;
                }

                const reasons = [];

                if (!isAllowedImageExt) {
                    reasons.push("格式不是 JPG/WebP/PNG/GIF");
                }

                if (isAllowedImageExt && file.size > siteSizeLimit) {
                    reasons.push(`${ext.toUpperCase()} 超过网站限制`);
                }

                if (file.size > limitBytes) {
                    reasons.push("超过你设置的单次上限");
                }

                if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
                    reasons.push(`分辨率超过 ${MAX_DIMENSION} x ${MAX_DIMENSION}`);
                }

                if (!autoCompress) {
                    state.invalidFiles.push([file, reasons.join("；")]);
                    continue;
                }

                if (ext === "gif" && !allowGifFirstFrame) {
                    state.invalidFiles.push([
                        file,
                        reasons.join("；") + "；GIF 不自动压缩，因为会丢失动画。"
                    ]);
                    continue;
                }

                const targetBytes = Math.floor(
                    Math.min(
                        limitBytes,
                        IMAGE_RULES.webp,
                        MAX_UPLOAD_MB * MB
                    ) * COMPRESS_SAFETY_RATIO
                );

                if (targetBytes <= 0) {
                    state.invalidFiles.push([file, "压缩目标大小无效"]);
                    continue;
                }

                try {
                    log(`尝试压缩：${displayName}，原大小 ${formatMB(file.size)}，原因：${reasons.join("；")}`);
                    live(`压缩中 ${i + 1} / ${files.length}: ${displayName}，目标 ${formatMB(targetBytes)}`);

                    const compressed = await compressImageFile(file, targetBytes);

                    if (
                        compressed.file.size <= targetBytes &&
                        compressed.width <= MAX_DIMENSION &&
                        compressed.height <= MAX_DIMENSION
                    ) {
                        state.validFiles.push(compressed.file);
                        addValidPersistentItem(file, {
                            finalSize: compressed.file.size,
                            finalName: compressed.file.name,
                            compressed: true,
                            targetBytes,
                            cachedFile: compressed.file,
                        });

                        log(
                            `压缩成功：${displayName} -> ${compressed.file.name}，` +
                            `${formatMB(file.size)} -> ${formatMB(compressed.file.size)}，` +
                            `${size.width}x${size.height} -> ${compressed.width}x${compressed.height}，` +
                            `第 ${compressed.round} 轮，质量 ${compressed.quality}`
                        );
                    } else {
                        state.invalidFiles.push([file, "压缩后仍不符合限制"]);
                    }
                } catch (err) {
                    state.invalidFiles.push([file, "压缩失败：" + err.message]);
                    log(`压缩失败：${displayName}，${err.message}`);
                }
            }
        }

        if (state.persistentMode) {
            buildQueueFromItems(actualMode, limitBytes);
            await savePersistentSession();
        } else {
            buildQueue(actualMode, limitBytes);
        }

        const validSize = state.validFiles.reduce((s, f) => s + f.size, 0);
        const invalidCount = state.invalidFiles.length;

        setStatus(
            `检查完成：有效 ${state.validFiles.length} 个，跳过 ${invalidCount} 个，队列 ${state.queue.length} 组，总大小 ${formatMB(validSize)}`
        );
        live(`检查完成：有效 ${state.validFiles.length} 个，跳过 ${invalidCount} 个，队列 ${state.queue.length} 组，总大小 ${formatMB(validSize)}`);

        log(`有效文件：${state.validFiles.length} 个`);
        log(`跳过文件：${invalidCount} 个`);
        log(`生成上传队列：${state.queue.length} 组`);

        if (invalidCount > 0) {
            log("被跳过的文件：");
            for (const [file, reason] of state.invalidFiles.slice(0, 50)) {
                log(`- ${file.webkitRelativePath || file.name}: ${reason}`);
            }
            if (invalidCount > 50) {
                log(`还有 ${invalidCount - 50} 个被跳过文件未显示。`);
            }
        }

        return state.queue.length > 0;
    }

    function buildQueue(mode, limitBytes) {
        const hardLimit = Math.min(limitBytes, MAX_UPLOAD_MB * MB);

        if (mode === "zip") {
            state.queue = state.validFiles.map(file => ({
                files: [file],
                bytes: file.size,
                label: file.webkitRelativePath || file.name,
            }));
            return;
        }

        const queue = [];
        let current = [];
        let currentBytes = 0;

        for (const file of state.validFiles) {
            const wouldExceedSize = currentBytes + file.size > hardLimit;
            const wouldExceedCount = current.length >= MAX_IMAGES_PER_BATCH;

            if (current.length > 0 && (wouldExceedSize || wouldExceedCount)) {
                queue.push({
                    files: current,
                    bytes: currentBytes,
                    label: `${current.length} images`,
                });
                current = [];
                currentBytes = 0;
            }

            current.push(file);
            currentBytes += file.size;
        }

        if (current.length > 0) {
            queue.push({
                files: current,
                bytes: currentBytes,
                label: `${current.length} images`,
            });
        }

        state.queue = queue;
    }


    function buildQueueFromItems(mode, limitBytes) {
        const hardLimit = Math.min(limitBytes, MAX_UPLOAD_MB * MB);

        if (mode === "zip") {
            state.queue = state.validItems.map(item => ({
                items: [item],
                bytes: item.finalSize,
                label: item.path || item.name,
            }));
            return;
        }

        const queue = [];
        let current = [];
        let currentBytes = 0;

        for (const item of state.validItems) {
            const size = item.finalSize || item.originalSize || 0;
            const wouldExceedSize = currentBytes + size > hardLimit;
            const wouldExceedCount = current.length >= MAX_IMAGES_PER_BATCH;

            if (current.length > 0 && (wouldExceedSize || wouldExceedCount)) {
                queue.push({
                    items: current,
                    bytes: currentBytes,
                    label: `${current.length} images`,
                });
                current = [];
                currentBytes = 0;
            }

            current.push(item);
            currentBytes += size;
        }

        if (current.length > 0) {
            queue.push({
                items: current,
                bytes: currentBytes,
                label: `${current.length} images`,
            });
        }

        state.queue = queue;
    }

    function putFilesIntoNativeInput(files) {
        const input = getUploadInput();
        if (!input) {
            throw new Error("找不到网页原本的 #uploadfiles 文件选择框。");
        }

        const dt = new DataTransfer();

        for (const file of files) {
            dt.items.add(file);
        }

        input.files = dt.files;

        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function waitForUploadFinish(beforeText, batch, index, total) {
        const button = getUploadButton();
        let lastText = getProgressText();
        let lastChangeTime = Date.now();
        let seenUploadStart = false;
        let lastLiveTime = 0;

        const startTime = Date.now();
        const timeoutMs = 1000 * 60 * 60 * 6;

        while (Date.now() - startTime < timeoutMs) {
            if (state.stopRequested) {
                throw new Error("用户停止了队列。");
            }

            const now = Date.now();
            const text = getProgressText();
            const busy = isUploadButtonBusy(button);

            if (text !== lastText) {
                lastText = text;
                lastChangeTime = now;
            }

            if (
                busy ||
                /上传中|Uploading|已处理|Processing|正在处理|正在完成|后端同步/i.test(text)
            ) {
                seenUploadStart = true;
            }

            if (now - lastLiveTime >= LIVE_UPDATE_INTERVAL_MS) {
                lastLiveTime = now;
                setStatus(getBatchLine(index, total, batch));
                live(`上传中：${extractUploadPercent(text)}`);
            }

            if (/失败|错误|Error|Failed|exceed|too large|不支持|超过|invalid/i.test(text)) {
                throw new Error("网页提示可能上传失败：" + text.replace(/\s+/g, " ").slice(0, 300));
            }

            const hasCompleteHint =
                /已添加\s*\d+\s*张/.test(text) ||
                /已处理\s*\d+\s*\/\s*\d+/.test(text) ||
                /added\s+\d+/i.test(text) ||
                /processed\s+\d+\s*\/\s*\d+/i.test(text);

            const stillBusyByText =
                /上传中|Uploading|正在处理|Processing|正在完成|后端同步/i.test(text);

            if (
                seenUploadStart &&
                hasCompleteHint &&
                !busy &&
                !stillBusyByText &&
                text !== beforeText &&
                now - lastChangeTime > 1200
            ) {
                return true;
            }

            await sleep(800);
        }

        throw new Error("等待上传完成超时。");
    }

    async function uploadOneBatch(batch, index, total) {
        const button = getUploadButton();

        if (!button) {
            throw new Error("找不到网页原本的 #uploadbutton 上传按钮。");
        }

        const line = getBatchLine(index, total, batch);
        log(`准备上传第 ${index + 1} / ${total} 组：${getBatchCount(batch)} 个文件，${formatMB(batch.bytes)}`);
        setStatus(line);
        live("上传中：等待开始");

        const beforeText = getProgressText();
        const uploadFiles = await materializeBatchFiles(batch);

        putFilesIntoNativeInput(uploadFiles);

        await sleep(600);

        if (state.persistentMode) {
            // 页面完成上传后会刷新；为了刷新后能接着下一组，
            // 这里必须在点击上传前先把恢复位置写成下一组。
            state.currentIndex = index + 1;
            await savePersistentSession();
        }

        button.click();

        log("已经点击网页的“开始上传”按钮。");

        try {
            await waitForUploadFinish(beforeText, batch, index, total);
        } catch (err) {
            // 如果没有发生页面刷新而是上传失败，则回退恢复位置，避免跳过本组。
            if (state.persistentMode) {
                state.currentIndex = index;
                await savePersistentSession();
            }
            throw err;
        }

        log(`第 ${index + 1} / ${total} 组上传完成。`);
        setStatus(`第 ${index + 1} / ${total} 组上传完成。`);
        live("上传中：100%");

        await sleep(1500);
    }

    async function startQueue() {
        if (state.running) {
            alert("队列已经在运行。");
            return;
        }

        if (!state.queue.length) {
            const ok = await validateFiles();
            if (!ok) return;
        }

        state.running = true;
        state.stopRequested = false;

        if (state.persistentMode) {
            await savePersistentSession();
        }

        try {
            for (let i = state.currentIndex; i < state.queue.length; i++) {
                if (state.stopRequested) break;

                state.currentIndex = i;

                const batch = state.queue[i];
                setStatus(getBatchLine(i, state.queue.length, batch));
                live("上传中：等待开始");

                await uploadOneBatch(batch, i, state.queue.length);
            }

            if (state.stopRequested) {
                setStatus(`已停止。下次会从第 ${state.currentIndex + 1} 组继续。`);
                live(`已停止。下次会从第 ${state.currentIndex + 1} 组继续。`);
                log("队列已停止。");
                if (state.persistentMode) {
                    await savePersistentSession();
                }
            } else {
                state.currentIndex = 0;
                setStatus("全部队列上传完成。");
                live("全部队列上传完成。");
                log("全部队列上传完成。");
                if (state.persistentMode) {
                    await clearPersistentSession();
                }
            }
        } catch (err) {
            setStatus("队列中断：" + err.message);
            live("队列中断：" + err.message);
            log("队列中断：" + err.message);
            alert("队列中断：\n" + err.message);
        } finally {
            state.running = false;
        }
    }

    function stopQueue() {
        state.stopRequested = true;
        setStatus("正在请求停止，会在当前上传结束或检测循环中停止。");
        live("已请求停止，会在当前上传结束或检测循环中停止。");
        log("已请求停止。");
    }

    async function clearQueue() {
        if (state.running) {
            alert("队列运行中，不能清空。");
            return;
        }

        state.files = [];
        state.validFiles = [];
        state.validItems = [];
        state.invalidFiles = [];
        state.queue = [];
        state.currentIndex = 0;
        state.persistentMode = false;
        state.restoredPersistentSession = false;

        const f1 = document.querySelector("#ehq-file");
        const f2 = document.querySelector("#ehq-folder");
        if (f1) f1.value = "";
        if (f2) f2.value = "";

        await clearPersistentSession();

        setStatus("已清空。");
        live("已清空。");
        log("已清空文件、队列和持久恢复状态。");
    }

    function setPanelMinimized(minimized) {
        const panel = document.querySelector("#ehq-panel");
        const ball = document.querySelector("#ehq-ball");

        if (!panel || !ball) return;

        panel.style.display = minimized ? "none" : "block";
        ball.style.display = minimized ? "flex" : "none";
        localStorage.setItem(PANEL_MINIMIZED_KEY, minimized ? "1" : "0");
    }

    function createPanel() {
        const panel = document.createElement("div");
        panel.id = "ehq-panel";
        panel.innerHTML = `
            <div class="ehq-head">
                <button id="ehq-minimize" title="最小化">—</button>
                <div class="ehq-title">EH 上传队列助手</div>
            </div>

            <div class="ehq-row">
                <label>模式：</label>
                <select id="ehq-mode">
                    <option value="auto">自动识别</option>
                    <option value="image">图片</option>
                    <option value="zip">ZIP</option>
                </select>
            </div>

            <div class="ehq-row">
                <label>每批上限：</label>
                <input id="ehq-limit" type="number" value="450" min="1" max="500" step="1">
                <span>MB，最大 500</span>
            </div>

            <div class="ehq-row">
                <label>
                    <input id="ehq-autocompress" type="checkbox" checked>
                    非法图片自动压缩为 WebP 后入队
                </label>
            </div>

            <div class="ehq-row">
                <label>
                    <input id="ehq-gif-first-frame" type="checkbox">
                    GIF 超限时转静态 WebP，只保留第一帧
                </label>
            </div>

            <div class="ehq-row">
                <label>
                    <input id="ehq-autostart" type="checkbox">
                    分组后自动开始队列
                </label>
            </div>

            <div class="ehq-row">
                <button id="ehq-choose-files">普通选择文件</button>
                <button id="ehq-choose-folder">普通选择文件夹</button>
            </div>

            <div class="ehq-row">
                <button id="ehq-persist-files">持久选择文件</button>
                <button id="ehq-persist-folder">持久选择文件夹</button>
            </div>

            <div class="ehq-row">
                <button id="ehq-check">检查并分组</button>
                <button id="ehq-start">开始队列</button>
                <button id="ehq-resume">继续持久队列</button>
                <button id="ehq-stop">停止</button>
                <button id="ehq-clear">清空</button>
            </div>

            <div id="ehq-status">等待选择文件。</div>
            <div id="ehq-live">实时状态：暂无</div>
            <pre id="ehq-log"></pre>

            <input id="ehq-file" type="file" multiple style="display:none">
            <input id="ehq-folder" type="file" multiple webkitdirectory directory style="display:none">
        `;

        const ball = document.createElement("div");
        ball.id = "ehq-ball";
        ball.title = "展开 EH 上传队列助手";
        ball.textContent = "EH";

        document.body.appendChild(panel);
        document.body.appendChild(ball);

        const style = document.createElement("style");
        style.textContent = `
            #ehq-panel {
                position: fixed;
                right: 12px;
                bottom: 12px;
                z-index: 999999;
                width: 370px;
                background: #eee8d8;
                color: #5a0000;
                border: 1px solid #9d8f7c;
                border-radius: 6px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, .25);
                padding: 10px;
                font-size: 13px;
                line-height: 1.45;
            }

            #ehq-panel button,
            #ehq-panel input,
            #ehq-panel select {
                font-size: 13px;
                margin: 2px;
            }

            .ehq-head {
                position: relative;
                min-height: 22px;
                margin-bottom: 6px;
            }

            #ehq-minimize {
                position: absolute;
                left: 0;
                top: 0;
                width: 24px;
                height: 22px;
                line-height: 18px;
                padding: 0;
                font-weight: bold;
                cursor: pointer;
            }

            .ehq-title {
                font-weight: bold;
                text-align: center;
                padding: 0 32px;
            }

            .ehq-row {
                margin: 5px 0;
            }

            #ehq-limit {
                width: 70px;
            }

            #ehq-status,
            #ehq-live {
                margin-top: 6px;
                padding: 5px;
                background: rgba(255,255,255,.45);
                border-radius: 4px;
                min-height: 20px;
            }

            #ehq-live {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                border: 1px solid rgba(140, 110, 90, .35);
            }

            #ehq-log {
                margin-top: 6px;
                height: 150px;
                overflow: auto;
                white-space: pre-wrap;
                background: rgba(255,255,255,.55);
                border: 1px solid #c8bdaa;
                padding: 5px;
                color: #400;
            }

            #ehq-ball {
                position: fixed;
                right: 0;
                bottom: 120px;
                z-index: 999999;
                width: 42px;
                height: 42px;
                border-radius: 999px 0 0 999px;
                background: #eee8d8;
                color: #5a0000;
                border: 1px solid #9d8f7c;
                border-right: none;
                box-shadow: 0 4px 16px rgba(0, 0, 0, .25);
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                cursor: pointer;
                user-select: none;
            }
        `;
        document.head.appendChild(style);

        const fileInput = document.querySelector("#ehq-file");
        const folderInput = document.querySelector("#ehq-folder");

        loadSettingsToPanel();
        bindSettingsSave();

        document.querySelector("#ehq-minimize").addEventListener("click", () => {
            setPanelMinimized(true);
        });

        ball.addEventListener("click", () => {
            setPanelMinimized(false);
        });

        document.querySelector("#ehq-choose-files").addEventListener("click", () => {
            fileInput.click();
        });

        document.querySelector("#ehq-choose-folder").addEventListener("click", () => {
            folderInput.click();
        });

        document.querySelector("#ehq-persist-files").addEventListener("click", async () => {
            try {
                await choosePersistentFiles();
            } catch (err) {
                if (err && err.name === "AbortError") return;
                alert("持久选择文件失败：\n" + (err.message || err));
            }
        });

        document.querySelector("#ehq-persist-folder").addEventListener("click", async () => {
            try {
                await choosePersistentFolder();
            } catch (err) {
                if (err && err.name === "AbortError") return;
                alert("持久选择文件夹失败：\n" + (err.message || err));
            }
        });

        fileInput.addEventListener("change", async () => {
            await clearPersistentSession();
            state.persistentMode = false;
            state.restoredPersistentSession = false;
            state.files = Array.from(fileInput.files || []);
            state.validFiles = [];
            state.validItems = [];
            state.invalidFiles = [];
            state.queue = [];
            state.currentIndex = 0;
            setStatus(`已普通选择 ${state.files.length} 个文件。普通选择不支持刷新续传。`);
            live(`已普通选择 ${state.files.length} 个文件。`);
            log(`已普通选择 ${state.files.length} 个文件。`);
        });

        folderInput.addEventListener("change", async () => {
            await clearPersistentSession();
            state.persistentMode = false;
            state.restoredPersistentSession = false;
            state.files = Array.from(folderInput.files || []);
            state.validFiles = [];
            state.validItems = [];
            state.invalidFiles = [];
            state.queue = [];
            state.currentIndex = 0;
            setStatus(`已普通选择文件夹中的 ${state.files.length} 个文件。普通选择不支持刷新续传。`);
            live(`已普通选择文件夹中的 ${state.files.length} 个文件。`);
            log(`已普通选择文件夹中的 ${state.files.length} 个文件。`);
        });

        document.querySelector("#ehq-check").addEventListener("click", async () => {
            const ok = await validateFiles();
            if (ok && getAutoStartAfterGroup()) {
                log("已启用“分组后自动开始队列”，即将开始上传。");
                await startQueue();
            }
        });

        document.querySelector("#ehq-start").addEventListener("click", () => {
            startQueue();
        });

        document.querySelector("#ehq-resume").addEventListener("click", () => {
            startQueue();
        });

        document.querySelector("#ehq-stop").addEventListener("click", () => {
            stopQueue();
        });

        document.querySelector("#ehq-clear").addEventListener("click", () => {
            clearQueue();
        });

        setPanelMinimized(localStorage.getItem(PANEL_MINIMIZED_KEY) === "1");

        restorePersistentSession();
    }

    createPanel();
})();
