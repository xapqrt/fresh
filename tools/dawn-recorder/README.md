# Dawn Recorder — zero-overhead screen recorder

A standalone ScreenCaptureKit recorder for the Dawn Client. It runs as its **own
background process** (menu-bar icon + global hotkey) and captures the *composited*
output of the Dawn window via ScreenCaptureKit, encoding with the hardware
VideoToolbox H.264 engine — a dedicated silicon block, separate from the GPU that
renders the game's WebGL. Because it never lives inside the Electron renderer, it
cannot compete with the game for GPU time: **~0 impact on 240fps gameplay.**

## Install / run
- The built app lives at `/Applications/Dawn Recorder.app`.
- A LaunchAgent (`~/Library/LaunchAgents/com.zvipexx.dawn-recorder.plist`) starts
  it at login and keeps it alive. Load once with:
    launchctl load ~/Library/LaunchAgents/com.zvipexx.dawn-recorder.plist
- On first run macOS prompts for **Screen Recording** permission — grant it once
  (System Settings ▸ Privacy & Security ▸ Screen Recording, enable "Dawn Recorder",
  restart the app).

## Recording
- Press **F9** anywhere (even while gaming) to start/stop. The menu-bar icon shows
  `● REC` while recording and `○` when idle.
- Or click the menu-bar icon → "Toggle Recording".
- Or from a shell / the game client:
    /Applications/Dawn\ Recorder.app/Contents/MacOS/dawn-recorder --toggle
    ... --start | --stop

## Output
- Clips are written to `~/Movies/clips/dawn-YYYYMMDD-HHMMSS.mp4` (H.264, hardware).

## Config (environment variables, set before launch)
- DAWN_REC_KEY    global hotkey keycode (default 101 = F9)
- DAWN_REC_FPS    capture fps (default 60; lower = less overhead)
- DAWN_REC_TARGET "window" (default, captures the Dawn Client window) or "display"

## Build (from source)
    cd tools/dawn-recorder
    swiftc -O main.swift -o dawn-recorder \
      -framework ScreenCaptureKit -framework AVFoundation -framework CoreGraphics \
      -framework CoreMedia -framework AppKit -framework CoreVideo
    cp dawn-recorder "/Applications/Dawn Recorder.app/Contents/MacOS/"
    codesign --force --deep --sign - "/Applications/Dawn Recorder.app"
