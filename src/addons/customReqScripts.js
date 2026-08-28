// User scripts from the scripts folder are already loaded at preload time.
// Kept as a hook point for future request-level script features.
const customReqScripts = (settings) => {};

module.exports = { customReqScripts };
