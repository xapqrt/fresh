"use strict";

const STORAGE_KEYS = {
  nicknames: "nicknames",
  customizations: "juice-customizations",
  clans: "juice-clans",
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeParse = (value, fallback) => {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
};

/** Parse local customization data once and expose O(1) indexes for match UI. */
function createDataIndex(storage) {
  const cache = {
    nicknames: null,
    customizations: null,
    clans: null,
  };
  const parseCounts = { nicknames: 0, customizations: 0, clans: 0 };

  const read = (kind) => {
    if (cache[kind]) return cache[kind];
    if (kind === "nicknames") {
      const object = safeParse(storage.getItem(STORAGE_KEYS.nicknames) || "{}", {});
      const byShortId = new Map();
      const byOriginal = new Map();
      const byNickname = new Map();
      const replacementMap = new Map();
      for (const [shortId, value] of Object.entries(object && typeof object === "object" ? object : {})) {
        const entry = { ...value, shortId };
        byShortId.set(shortId, entry);
        if (entry.original) byOriginal.set(entry.original, entry);
        if (entry.nickname) byNickname.set(entry.nickname, entry);
        if (entry.original && entry.nickname) {
          const originalToken = `${entry.original}#${shortId}`;
          const nicknameToken = `${entry.nickname}#${shortId}`;
          replacementMap.set(originalToken, nicknameToken);
          replacementMap.set(nicknameToken, nicknameToken);
        }
      }
      const replacementPattern = replacementMap.size
        ? new RegExp([...replacementMap.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join("|"), "g")
        : null;
      cache[kind] = { object, byShortId, byOriginal, byNickname, replacementMap, replacementPattern };
    } else if (kind === "customizations") {
      const list = safeParse(storage.getItem(STORAGE_KEYS.customizations) || "[]", []);
      const normalized = Array.isArray(list) ? list : [];
      cache[kind] = {
        list: normalized,
        byShortId: new Map(normalized.filter((entry) => entry?.shortId).map((entry) => [String(entry.shortId), entry])),
      };
    } else {
      const list = safeParse(storage.getItem(STORAGE_KEYS.clans) || "[]", []);
      const normalized = Array.isArray(list) ? list : [];
      cache[kind] = {
        list: normalized,
        byClan: new Map(normalized.filter((entry) => entry?.clan).map((entry) => [String(entry.clan), entry])),
      };
    }
    parseCounts[kind]++;
    return cache[kind];
  };

  const kindForStorageKey = (key) => Object.entries(STORAGE_KEYS).find(([, value]) => value === key)?.[0] || null;

  return {
    nicknames: () => read("nicknames"),
    customizations: () => read("customizations"),
    clans: () => read("clans"),
    nickname: (shortId) => read("nicknames").byShortId.get(String(shortId)),
    customization: (shortId) => read("customizations").byShortId.get(String(shortId)),
    clan: (name) => read("clans").byClan.get(String(name)),
    findNickname(name) {
      const index = read("nicknames");
      return index.byOriginal.get(name) || index.byNickname.get(name);
    },
    replaceNicknames(text) {
      const index = read("nicknames");
      if (!index.replacementPattern) return String(text);
      index.replacementPattern.lastIndex = 0;
      return String(text).replace(index.replacementPattern, (token) => index.replacementMap.get(token) || token);
    },
    invalidate(key) {
      if (!key) {
        cache.nicknames = null;
        cache.customizations = null;
        cache.clans = null;
        return;
      }
      const kind = cache[key] !== undefined ? key : kindForStorageKey(key);
      if (kind) cache[kind] = null;
    },
    getStats: () => ({
      parseCounts: { ...parseCounts },
      loaded: Object.fromEntries(Object.entries(cache).map(([key, value]) => [key, Boolean(value)])),
    }),
  };
}

module.exports = { STORAGE_KEYS, createDataIndex, safeParse };
