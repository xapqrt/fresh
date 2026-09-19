// The preload script re-executes on every navigation, but the renderer
// process (and its require cache) persists — so module state here survives
// page loads. Static menu assets are read from disk once per session instead
// of on every navigation.
const _navCache = new Map();

const navCacheGet = (key) => _navCache.get(key);
const navCacheSet = (key, value) => { _navCache.set(key, value); };

module.exports = { navCacheGet, navCacheSet };
