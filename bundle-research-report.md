# Bundle Research Report

Everything learned from reverse-engineering the Kirka.io game bundle as served by Dawn
Client's `dawn-patch` pipeline. Tools live in `tools/bundle-decode/`; this is the
consolidated knowledge base — the raw working dump is `tools/bundle-decode/BUNDLE_FINDINGS.md`.

Bundle studied: `app.662a34fb.js`, cached at
`~/Library/Application Support/dawn-client/bundle-cache/`.

---

## 1. How dawn-patch works (the bundle cache pipeline)

- `src/main.js` registers a custom `dawn-patch://` protocol
  (`src/main.js:10`, privileges: `bypassCSP, secure, supportFetchAPI, standard, corsEnabled`).
- `session.defaultSession.webRequest.onBeforeRequest` (`src/main.js:402-407`) rewrites any
  `https://kirka.io/assets/js/app.<hash>.js` request to
  `dawn-patch://bundle/app.js?url=<original>`.
- The protocol handler (`src/main.js:191-240`):
  1. `_cacheGet(url)` — checks memory map, then disk
     (`<userData>/bundle-cache/<url filename>`, `src/main.js:129-136`).
  2. On miss: `fetch(url)` the real bundle, apply string patches, append
     `//# sourceURL=` + a `// dawn-patch: zoom=.. onGround=..` marker line.
  3. `_cacheSet(url, code)` — memory + disk (`src/main.js:137-140`).
  4. Serves with **`Cache-Control: public, max-age=31536000, immutable`**.
- **Cache invalidation pitfall**: the disk cache is keyed by URL filename and never expires.
  After ANY patch code change, the old patched bundle keeps being served until
  `~/Library/Application Support/dawn-client/bundle-cache/app.*.js` is deleted.
  This has bitten us once (dead `onGround` regex served from cache).

### Improvements available

- Include a patch version in the cache key or redirect URL (e.g.
  `dawn-patch://bundle/app.js?v=<PATCH_VERSION>`) so the disk cache invalidates on app
  upgrades without manual deletion.
- Patch status is only logged to the main-process console; expose `window.__patchMeta` to
  the renderer so the menu can show "bhop hook active" / warn when patterns don't match.
- Only `app.*.js` is intercepted today; the game also loads lazy `chunk-*` modules
  (hex-named, e.g. `chunk-6d6174726978` = `chunk-matrix`). Extend the URL filter if we
  ever need to patch physics/rendering chunks.

---

## 2. Bundle format (obfuscation)

- One giant minified file. `rg -c` counts lines (always 1) — use `rg -o -m` or the
  decode tools.
- **String table**: `var dqP=[...]` at byte 4801260, array ends 6567860
  (1,766,601 chars, 28,072 entries). Extract quote/escape-aware — a `]` inside a string
  literal breaks naive bracket matching.
- **Rotator IIFE** (bytes 0–336): rotates the table until a formula matches target
  `0x1e40c` (=123916). Simulate `c.push(c.shift())`; settles after **388** rotations.
- **Decoder offset**: `0xfd` (253). `lk(i)` = `c[i - 0xfd]`.
- **Per-scope aliases** all wrap the same `lk`: `dqO, cAH, daj, bX2, awR, dae, dao, d9V,
  djx, de1, bWG…`. Property accesses look like `iP[da8(0x55bf)]`; literals like
  `iP['wwNmMWnW']` appear only in some scopes.
- **`0x3e7` is ambiguous**: as a *number* = 999 (jump impulse); as a *string index* it
  decodes to a PNG data URI. Context matters.
- The bundle ships **duplicate copies** of big code regions (e.g. the movement tick
  exists in d9Z-scope at ~4346987 and da8-scope at ~4352206). Always verify uniqueness
  of a patch needle before relying on it.

## 3. Decoder tools (`tools/bundle-decode/`)

```
node tools/bundle-decode/decode-strings.js <bundle.js> strings.json matches.txt
node tools/bundle-decode/decode-idx.js strings.json 0x4484 0x55bf ...   # hex idx -> string
node tools/bundle-decode/show-ctx.js <bundle.js> "<needle>" [before] [after]
```

`decode-strings.js` extracts the table + rotator and dumps `strings.json` (28k entries)
plus `matches.txt` (all hex-decode calls found in the bundle, sorted, deduped). Tested
against the live bundle.

---

## 4. Player input state (per frame)

`player` = `state.game.player` (0x1b61); `player.input` (0x127a):

| idx | string | meaning |
|---|---|---|
| 0x6730 | `"WnmNwMwW"` | raw jump key held (current frame) |
| 0x4484 | `"wwWnNWmM"` | jump pressed = rising edge of held |
| 0x12e8 | `"WnmM"` | raw dash key held |
| 0x6c67 | `"wwWnNM"` | dash pressed = rising edge |
| 0x3276 | `"WwWNn"` | previous jump held state |
| 0x2d0d | `"WwWNwmn"` | previous dash held state |
| 0x2187 | `"WmMn"` | input sequence counter |
| 0x6afd | `"inputRing"` | ring buffer of past inputs (prediction replay) |
| 0x6627 | `"wNWmWwM"` | jump anti-spam counter |
| 0x3143 | `"WMnmwNwW"` | crouch input |
| 0x346a | `"WnwMNwWm"` | move x |
| 0x3136 | `"WnwMNwm"` | move y |
| 0x2d9c | `"scope"` | scope/aim input |
| 0x4a5 | `"wNWmMw"` | reset flag |
| 0x510 | `"WnwNMmw"` | reset flag |

Edge detection (input handler ~3037194):
`X['wwWnNWmM'] = !!X['WnmNwMwW'] && !this['WwWNn']`, then `this['WwWNn'] = X['WnmNwMwW']`.

**Anti-spam** (`wNWmWwM`): armed to 1 by the jump keydown handler (`wmMnWNWw` = 0x1ae7);
in the input tick, if counter ≥ 2 it clears reset/input flags and disarms. Pressing jump
2× within ~2 ticks gets the second press eaten. **Our catch-up toggle loop (max 8
toggles/frame) can trip this on slow frames.**

---

## 5. Real onGround state

Physics: `player['WwnWwMmN']` (0x1a0d):

| idx | string | meaning |
|---|---|---|
| 0x55bf | `"wwNmMWnW"` | **onGround flag (the real one)** |
| 0x2ad8 | `"wNWmwMWn"` | vertical velocity (vy) |
| 0x3d56 | `"wwWmM"` | previous onGround (edge detection) |
| 0x3ebb | `"WwWNmwn"` | in-air/velocity flag |
| 0x2b35 | `"wmMWw"` | secondary ground-ish flag |
| 0x19cc | `"wMnNWWwm"` | airtime accumulator (resets on ground) |
| 0x36b | `"WnmWMww"` | y position |
| 0x5492 | `"WwWNnMwm"` | last-ground y reference |

Public getter on the Player class (~4678533):
`player.wwNmMWnW` → `player.WwnWwMmN.wwNmMWnW`.

Ground updated from BOTH server snapshots (`predictedState['wwNmMWnW'] = !!serverState
['wWWmNMwn']`, 0x570b, ~4373987) and local landing prediction (4526348).

### The patch (src/main.js:222-228)

The old regex `/this\['onGround'\]/` matched nothing in the minified bundle — dead code
that silently disabled the ground hook. Fixed to patch the verified-unique literal site
(byte 4354766, inside the live da8-scope physics tick):

```
iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=this[da8(0x55bf)]
  -> iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=window.__onGround=!!this[da8(0x55bf)]
```

Verified: 1× occurrence, `node --check` passes on the patched bundle.
`window.__onGround` is now written every physics tick (0=false/1=true); consumed by
`src/preload/game/bhop.js` `_pollGround()`.

---

## 6. Game's own jump gate (movement tick `WmNMWww` = 0x7b7, ~4348619)

```
if (dt > 0 && !physics['WwWNmwn'] && input['wwWnNWmM']
    && (physics['wwNmMWnW'] || (vy < 0 && vy >= -0.15))   // real ground + coyote
    && !input['WnmM']['WmNnwWwM'])                        // not dash-locked
{
  physics['wNWmwMWn'] = 0x3e7;                            // vy = 999
  physics['WwWNmwn'] = true;                              // mark in-air
}
```

Air jumps rejected natively. Client prediction replays the input ring over physics
(`iP[0x7b7](fP)`, ~4376031) with `isReplaying` set.

## 7. Native bhop (the game has one built in)

Settings (`state.game.WwwMWNnm` = 0x3e3f): `bhop` (0x613b) **default ON**, multiplier
`wnNMwWmW` (0x669) default 1.5, UI slider 1–3.

Mechanics (~4348619): land while crouched + jump within 250ms → run speed ×
`iW * Math.max(1, min(slideSpeed, 1 + 0.15*hops))`. It is a **passive speed boost**, NOT
an auto-jump — it rewards exactly the crouch(shift)+jump timing our sim does.

Settings save/load: `localStorage` `createOptions` at 1284829; settings UI at 1897338.

---

## 8. Key byte offsets (bundle app.662a34fb.js)

| byte | what |
|---|---|
| 4801159 | `k` def (decoder function) |
| 4801260 | `var dqP=[` (string table) |
| 6567860 | string table end |
| 3032180 | jump keydown handler `wmMnWNWw` (arms anti-spam) |
| 3037194 | input edge handler (jump/dash pressed) |
| 4346987 / 4348619 | movement tick `WmNMWww` (jump gate + native bhop boost) |
| 4352206 | second copy of tick (da8-scope, live ground writer) |
| 4354766 | ground write site (patch anchor, unique 1×) |
| 4373987 | server snapshot → predicted state (onGround sync) |
| 4376031 | input-ring replay loop |
| 4526348 | local landing prediction |
| 4678533 | Player class def (getter `wwNmMWnW`) |
| 1284829 | settings save/load (`localStorage` `createOptions`) |
| 1897338 | settings UI (bhop toggle + multiplier slider) |

---

## 9. Patch status

- [x] `src/main.js` onGround patch FIXED (dead regex → unique literal anchor, syntax-verified)
- [x] `window.__onGround` written every physics tick, consumed by bhop `_pollGround()`
- [ ] Zoom patch (`f5['a'][hF]`) still dead (0 occurrences) but harmless — no consumer
- [ ] In-game verify `window.__onGround` toggles 0/1 on jump/land (delete bundle cache first!)
