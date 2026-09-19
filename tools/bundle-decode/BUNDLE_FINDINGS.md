# Kirka bundle decode: jump / ground / bhop research

> **Superseded by `bundle-research-report.md` at the repo root** — this file is the raw
> working dump; keep edits there going forward.

Research dump from reverse-engineering `app.662a34fb.js` (bundle cached by dawn-patch at
`~/Library/Application Support/dawn-client/bundle-cache/`). The bundle is obfuscated with a
rotating string table + per-scope decoder aliases. This document records everything we found
about jump input, the real onGround state, and the game's native bhop system.

## Tools

```
node tools/bundle-decode/decode-strings.js <bundle.js> strings.json matches.txt
node tools/bundle-decode/decode-idx.js strings.json 0x4484 0x55bf ...   # hex idx -> string
node tools/bundle-decode/show-ctx.js <bundle.js> "<needle>" [before] [after]
```

## Decoder mechanics (verified)

- String table: `var dqP=[` at byte 4801260; array ends at byte 6567860 (1,766,601 chars,
  28,072 entries). Must be extracted quote/escape-aware — a `]` inside a string literal
  breaks naive balanced matching.
- Rotator: IIFE at bytes 0–336, ending `}(j,0x1e40c),`. Target `0x1e40c` = 123916.
  Rotation formula is `try{var d=(FORMULA);if(d===b)…}` — we extract the formula via regex,
  compile it with `new Function('lk','return '+src)`, then simulate `c.push(c.shift())`
  until the formula evaluates to the target. Settles after **388** rotations.
- Decoder offset: `0xfd` (253). `lk(i)` = `c[i - 0xfd]`.
- `0x3e7` as a *number* is 999 (jump impulse). `0x3e7` as a *string index* decodes to a
  PNG data URI — don't confuse the two.
- Per-scope decoder aliases: `dqO`, `cAH`, `daj`, `bX2`, `awR`, `dae`, `dao`, `d9V`, `djx`,
  `de1`, `bWG`… All wrap the same `lk`.
- Chunk names are hex-encoded: `chunk-6d6174726978` = `chunk-matrix`, `chunk-mousemove` =
  plain text. Some physics/rendering code lives in lazy `chunk-*` modules.
- Bundle is one giant line; `rg -c` counts lines (always 1), use `rg -o -m`.

## Player input state

Player object: `player` = `state.game.player` (idx 0x1b61). Input object: `player.input`
(0x127a). Fields (all string-table indices unless quoted):

| idx | string | meaning |
|---|---|---|
| 0x127a | `"input"` | player input object |
| 0x6730 | `"WnmNwMwW"` | raw jump key held (current frame) |
| 0x4484 | `"wwWnNWmM"` | jump pressed = rising edge of held |
| 0x12e8 | `"WnmM"` | raw dash key held |
| 0x6c67 | `"wwWnNM"` | dash pressed = rising edge |
| 0x3276 | `"WwWNn"` | previous jump held state |
| 0x2d0d | `"WwWNwmn"` | previous dash held state |
| 0x2187 | `"WmMn"` | input sequence counter (per-tick seq) |
| 0x6afd | `"inputRing"` | ring buffer of past input snapshots (replay) |
| 0x6627 | `"wNWmWwM"` | jump anti-spam counter |
| 0x3143 | `"WMnmwNwW"` | crouch input |
| 0x346a | `"WnwMNwWm"` | move x |
| 0x3136 | `"WnwMNwm"` | move y |
| 0x2d9c | `"scope"` | scope/aim input |
| 0x4a5 | `"wNWmMw"` | reset flag |
| 0x510 | `"WnwNMmw"` | reset flag |

Edge detection (input handler, byte ~3037194):
`X['wwWnNWmM'] = !!X['WnmNwMwW'] && !this['WwWNn']` then `this['WwWNn'] = X['WnmNwMwW']`.

Anti-spam (`wNWmWwM`, 0x6627): armed to 1 by the jump keydown handler
(`{'key':'wmMnWNWw', …}` = 0x1ae7); in the input tick, if counter >= 2 it clears the
reset/input flags (`wNWmMw`, `WnwNMmw`, `wNWmMWnw`, `scope`) and disarms. Net effect:
pressing jump 2x within ~2 ticks of each other gets the second press eaten. **Our catch-up
toggle loop (max 8 toggles/frame) can trip this on slow frames.**

## Real onGround state

Physics state object: `player['WwnWwMmN']` (0x1a0d). Fields:

| idx | string | meaning |
|---|---|---|
| 0x55bf | `"wwNmMWnW"` | **onGround flag** (the real one) |
| 0x2ad8 | `"wNWmwMWn"` | vertical velocity (vy) |
| 0x3d56 | `"wwWmM"` | previous onGround (edge detection) |
| 0x3ebb | `"WwWNmwn"` | in-air/velocity flag |
| 0x2b35 | `"wmMWw"` | secondary ground-ish flag |
| 0x19cc | `"wMnNWWwm"` | airtime accumulator (resets on ground) |
| 0x36b | `"WnmWMww"` | y position |
| 0x5492 | `"WwWNnMwm"` | last-ground y reference |

The Player class exposes a **public getter**: `player.wwNmMWnW` → `player.WwnWwMmN.wwNmMWnW`
(class def ~byte 4678533: `{'key':djx(0x55bf),'get':function(){return this[0x1a0d][0x55bf]}}`).

Ground flag is updated from BOTH:
1. Server snapshots: `predictedState['wwNmMWnW'] = !!serverState['wWWmNMwn']` (0x570b) —
   byte ~4373987.
2. Local landing prediction: byte ~4526348 (`this[0x55bf]=!0x0` on landing) — client-side
   interpolation of prev/next server states.

## Game's own jump (movement tick `WmNMWww` = 0x7b7, byte ~4348619)

```
if (dt > 0 && !physics['WwWNmwn'] && input['wwWnNWmM']           // jump pressed
    && (physics['wwNmMWnW']                                      // onGround
        || (vy < 0 && vy >= -0.15))                              // tiny coyote window
    && !input['WnmM']['WmNnwWwM'])                               // not dash-locked
{
  physics['wNWmwMWn'] = 0x3e7;   // vy = 999 = jump impulse
  physics['WwWNmw'] = 0x3e7;
  ... crouch-jump 85% height if crouching ...
  physics['WwWNmwn'] = true;     // mark in-air
}
```

Air jumps are rejected natively — the game already behaves like a "real onGround" jump gate.
Client-side prediction replays the input ring over physics (`iP[0x7b7](fP)` in the replay
loop, byte ~4376031) with `isReplaying` set, and server reconciliation follows.

## Native bhop (the game has one built in!)

Settings (`state.game.WwwMWNnm` = 0x3e3f):

| idx | string | meaning |
|---|---|---|
| 0x613b | `"bhop"` | bhop toggle, **default ON (0x1)** |
| 0x669 | `"wnNMwWmW"` | bhop multiplier, default **1.5** (UI slider 1–3) |

Movement tick ground branch (byte ~4348619):
```
if (onGround) {
  if (wNWmWMwn && input['WMnmwNwW'] && airtime < 0.25) {   // crouch + just landed
    iV = settings['wWMnwNm'] ?? 1.5;                        // slide speed
    if (!wNwMWWm) {
      hopCount++;                                            // 0x5577 / 0x3c3 'Wwnm'
      wnNMwWmW = Math.min(iV, 1 + 0.15 * hopCount);          // grows per chain jump
      wNWmWMwn = true;
    }
    iW = 2 - airtime / 0.25 * 0x14 * 0.1;                    // decay from landing
    speed *= iW * Math.max(1, wnNMwWmW);                     // ★ the bhop boost
  }
} else {
  wnNMwWmW = 1;                                              // reset in air
  hopCount = 0;
}
```

So the native "bhop" is: land while crouched, jump within 250ms, and your run speed gets
multiplied by up to `2 × max(1, 1 + 0.15×hops)` (capped by the 1–3 slider, default 1.5).
It is a **passive speed boost** — it does NOT auto-press jump. It rewards exactly the
crouch(shift) + jump(space/Q) timing window our bhop simulates.

## Implication for our bhop

- Our blind-pulse bhop already rides the game's native ground gate (air jumps ignored),
  so pulses fired in the air are simply wasted, not harmful — except:
- The anti-spam counter (`wNWmWwM`) eats a jump if 2 presses land within ~2 ticks.
- Native bhop boost rewards landing-crouch-jump chains; timing pulses to the *real* landing
  edge (rising edge of `player.wwNmMWnW`) would eliminate wasted pulses and maximize the
  native boost window (airtime < 0.25s).

## Key byte offsets (bundle app.662a34fb.js)

| byte | what |
|---|---|
| 4801159 | `k` def (decoder function) |
| 4801260 | `var dqP=[` (string table) |
| 6567860 | string table end |
| 3032180 | jump keydown handler `wmMnWNWw` (arms anti-spam) |
| 3037194 | input edge handler (jump/dash pressed) |
| 4346987 / 4348619 | movement tick `WmNMWww` (jump gate + native bhop boost) |
| 4352206 | second copy of tick (da8-scope, live ground writer) |
| 4354766 | **ground write site**: `iP[da8(0x3d56)]=iP[da8(0x55bf)],iP[da8(0x55bf)]=this[da8(0x55bf)]` (unique, 1×) |
| 4373987 | server snapshot → predicted state (onGround sync) |
| 4376031 | input-ring replay loop |
| 4526348 | local landing prediction |
| 4678533 | Player class def (getter `wwNmMWnW`) |
| 1284829 | settings save/load (`localStorage` `createOptions`) |
| 1897338 | settings UI (bhop toggle + multiplier slider) |

## Patch status

- [x] `src/main.js` onGround patch FIXED (was dead: old regex `/this\['onGround'\]/` matched
      nothing in the minified bundle). Now patches the unique literal site
      `iP[da8(0x55bf)]=this[da8(0x55bf)]` → `iP[da8(0x55bf)]=window.__onGround=!!this[da8(0x55bf)]`
      (byte 4354766, verified 1× occurrence, `node --check` passes on patched bundle).
- [x] `window.__onGround` is now written every physics tick with the real ground flag
      (0=false/1=true), consumed by `src/preload/game/bhop.js` `_pollGround()`.
- [ ] Zoom patch (`f5['a'][hF]`) still dead (0 occurrences) but harmless — no consumer of
      `__f5`/`__zoomInstance`; leave as-is.
- [!] dawn-patch serves a disk cache keyed by URL filename with `max-age=31536000, immutable` —
      **delete `~/Library/Application Support/dawn-client/bundle-cache/app.*.js` after any
      patch change** or the old patched bundle is served.

## Status / next steps

- [x] Decoder + tools committed
- [x] Map input state, ground state, jump gate, native bhop
- [x] Fix dead onGround patch (unique literal site, syntax-verified)
- [ ] Delete dawn-client bundle cache, rebuild app, in-game verify `window.__onGround`
      toggles 0/1 on jump/land
- [ ] Verify anti-spam counter interaction with our pulse cadence (measure in game)
- [ ] Decide: P1 real-onGround hook = poll `player.wwNmMWnW` rising edge, fire pulse on
      landing; or rely on native bhop alone
