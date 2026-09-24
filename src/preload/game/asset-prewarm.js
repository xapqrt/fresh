"use strict";

const ASSET_PATTERN = /\.(?:png|jpe?g|webp|gif|svg|mp3|ogg|wav|m4a)(?:[?#]|$)/i;
const AUDIO_PATTERN = /\.(?:mp3|ogg|wav|m4a)(?:[?#]|$)/i;
const HOT_PATTERN = /weapon|gun|rifle|pistol|knife|hit|kill|crosshair|hud|icon|shot|reload|sound/i;

const boundedOption = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
};

const estimateEntryBytes = (entry) => {
  const measured = Number(entry?.decodedBodySize) || Number(entry?.transferSize);
  if (measured > 0) return measured;
  return AUDIO_PATTERN.test(entry?.name || entry?.url || "") ? 512 * 1024 : 256 * 1024;
};

function selectPrewarmCandidates(entries = [], extras = [], options = {}) {
  const maxBytes = boundedOption(options.maxBytes, 12 * 1024 * 1024);
  const maxCount = Math.floor(boundedOption(options.maxCount, 24));
  const seen = new Set();
  const candidates = [];
  const add = (url, entry = null, priority = 0) => {
    if (!url || !ASSET_PATTERN.test(url) || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      bytes: estimateEntryBytes(entry || { name: url }),
      audio: AUDIO_PATTERN.test(url),
      priority: priority + (HOT_PATTERN.test(url) ? 100 : 0),
    });
  };
  for (const entry of entries) add(entry?.name || entry?.url, entry, 0);
  for (const url of extras) add(url, null, 50);
  candidates.sort((a, b) => b.priority - a.priority || a.bytes - b.bytes);

  const selected = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxCount || bytes + candidate.bytes > maxBytes) continue;
    selected.push(candidate);
    bytes += candidate.bytes;
  }
  return { candidates: selected, estimatedBytes: bytes, skipped: candidates.length - selected.length };
}

function createAssetPrewarmer(options = {}) {
  const windowObject = options.windowObject || globalThis.window;
  const documentObject = options.documentObject || globalThis.document;
  const maxBytes = boundedOption(options.maxBytes, 12 * 1024 * 1024);
  const maxCount = Math.floor(boundedOption(options.maxCount, 24));
  const timeoutMs = boundedOption(options.timeoutMs, 4000);
  const ImageClass = options.ImageClass || windowObject?.Image;
  const AudioClass = options.AudioClass || windowObject?.Audio;
  const requestIdle = options.requestIdle || windowObject?.requestIdleCallback?.bind(windowObject) || ((callback) => setTimeout(callback, 120));
  const cancelIdle = options.cancelIdle || windowObject?.cancelIdleCallback?.bind(windowObject) || clearTimeout;

  let generation = 0;
  let idleHandle = null;
  let active = false;
  let activeGeneration = null;
  let cancelCurrent = null;
  let complete = false;
  const stats = {
    runs: 0,
    warmed: 0,
    failed: 0,
    skipped: 0,
    estimatedBytes: 0,
    cancelled: 0,
    active: false,
  };

  const sourceExtras = () => {
    const result = new Set(options.extraUrls?.() || []);
    documentObject?.querySelectorAll?.("img[src]").forEach((image) => {
      if (image.currentSrc || image.src) result.add(image.currentSrc || image.src);
    });
    return [...result];
  };

  const warmOne = (candidate, runGeneration) => new Promise((resolve) => {
    if (runGeneration !== generation) return resolve(false);
    let asset;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelCurrent === cancelThis) cancelCurrent = null;
      try {
        asset.onload = null;
        asset.onerror = null;
        asset.oncanplaythrough = null;
        asset.onloadeddata = null;
        if (candidate.audio) asset.pause?.();
      } catch (error) {}
      resolve(ok);
    };
    const cancelThis = () => {
      try {
        asset?.pause?.();
        asset?.removeAttribute?.("src");
        if (asset && "src" in asset) asset.src = "";
      } catch (error) {}
      finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    cancelCurrent = cancelThis;
    try {
      if (candidate.audio && AudioClass) {
        asset = new AudioClass();
        asset.preload = "auto";
        asset.oncanplaythrough = () => finish(true);
        asset.onloadeddata = () => finish(true);
        asset.onerror = () => finish(false);
        asset.src = candidate.url;
        asset.load?.();
      } else if (ImageClass) {
        asset = new ImageClass();
        asset.decoding = "async";
        asset.onload = () => finish(true);
        asset.onerror = () => finish(false);
        asset.src = candidate.url;
        if (typeof asset.decode === "function") asset.decode().then(() => finish(true), () => {});
      } else {
        finish(false);
      }
    } catch (error) {
      finish(false);
    }
  });

  const run = async (runGeneration) => {
    if (runGeneration !== generation || documentObject?.visibilityState === "hidden") return;
    active = true;
    activeGeneration = runGeneration;
    stats.active = true;
    stats.runs++;
    const entries = windowObject?.performance?.getEntriesByType?.("resource") || [];
    const selection = selectPrewarmCandidates(entries, sourceExtras(), { maxBytes, maxCount });
    stats.estimatedBytes = selection.estimatedBytes;
    stats.skipped += selection.skipped;
    // Sequential decode keeps transient memory bounded by one asset in addition
    // to the browser's normal HTTP/decoded-resource cache.
    for (const candidate of selection.candidates) {
      if (runGeneration !== generation || documentObject?.visibilityState === "hidden") break;
      const warmed = await warmOne(candidate, runGeneration);
      if (runGeneration !== generation || documentObject?.visibilityState === "hidden") break;
      if (warmed) stats.warmed++;
      else stats.failed++;
    }
    if (runGeneration === generation && documentObject?.visibilityState !== "hidden") complete = true;
    if (activeGeneration === runGeneration) {
      active = false;
      activeGeneration = null;
      stats.active = false;
    }
  };

  const start = () => {
    if (complete || active || idleHandle !== null) return false;
    generation++;
    const runGeneration = generation;
    if (idleHandle !== null) cancelIdle(idleHandle);
    idleHandle = requestIdle(() => {
      idleHandle = null;
      void run(runGeneration);
    }, { timeout: 1500 });
    return true;
  };

  const cancel = () => {
    generation++;
    const hadPending = idleHandle !== null;
    const wasActive = active;
    if (hadPending) cancelIdle(idleHandle);
    idleHandle = null;
    cancelCurrent?.();
    cancelCurrent = null;
    if (wasActive) stats.cancelled++;
    if (wasActive || hadPending) complete = false;
    active = false;
    activeGeneration = null;
    stats.active = false;
  };

  return { start, cancel, resume: start, getStats: () => ({ ...stats, complete }) };
}

module.exports = { createAssetPrewarmer, selectPrewarmCandidates };
