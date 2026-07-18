// Dawn Recorder — zero-overhead screen recorder for the Dawn Client.
//
// Architecture:
//   This is a STANDALONE process. It uses ScreenCaptureKit (the same capture
//   pipeline QuickTime uses) to sample the COMPOSITED output of the Dawn window
//   (or the chosen display). It does NOT live inside the Electron renderer/GPU
//   process, so it cannot compete with the game's WebGL for GPU time. Encoding
//   is done by VideoToolbox (hardware H.264) on the dedicated video-encode
//   engine, separate from the GPU rendering the game. Net effect on the game:
//   ~zero.
//
// Usage:
//   dawn-recorder                 -> run as a background daemon (global hotkey F9
//                                    toggles recording; menu bar shows state)
//   dawn-recorder --toggle        -> send SIGUSR1 to the running daemon (toggle)
//   dawn-recorder --start         -> send SIGUSR2 to force-start
//   dawn-recorder --stop          -> send SIGTERM to force-stop (keeps running)
//
// Env:
//   DAWN_REC_KEY   keycode for the global hotkey (default 101 = F9)
//   DAWN_REC_FPS   capture fps (default 60; lower = less overhead)
//   DAWN_REC_TARGET "window" (default, captures the Dawn Client window) or
//                   "display" (captures the main display)

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import CoreMedia
import AppKit
import Darwin

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
let recKeyCode: Int64 = { if let s = ProcessInfo.processInfo.environment["DAWN_REC_KEY"], let i = Int64(s) { return i }; return 101 }() // F9
let recFps: Int = { if let s = ProcessInfo.processInfo.environment["DAWN_REC_FPS"], let i = Int(s) { return i }; return 60 }()
let recTarget: String = ProcessInfo.processInfo.environment["DAWN_REC_TARGET"] ?? "window"
let outputDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Movies/clips")
let pidFile = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".dawn-recorder.pid")

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
var stream: SCStream?
var assetWriter: AVAssetWriter?
var videoInput: AVAssetWriterInput?
var isRecording = false
var didAddInput = false
var startCompletion: (() -> Void)?
var stopCompletion: (() -> Void)?
let streamQueue = DispatchQueue(label: "dawn.recorder.stream")

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("\(ts) [dawn-recorder] \(msg)\n".data(using: .utf8)!)
}

func ensureOutputDir() {
    try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
}

func writePid() {
    try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: pidFile, atomically: true, encoding: .utf8)
}

func readPid() -> pid_t? {
    guard let s = try? String(contentsOf: pidFile, encoding: .utf8),
          let pid = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    // verify it's alive
    if kill(pid, 0) == 0 { return pid }
    return nil
}

func newOutputURL() -> URL {
    let df = DateFormatter()
    df.dateFormat = "yyyyMMdd-HHmmss"
    return outputDir.appendingPathComponent("dawn-\(df.string(from: Date())).mp4")
}

// ----------------------------------------------------------------------------
// Capture target selection
// ----------------------------------------------------------------------------
func pickContent() async throws -> (SCContentFilter, CGSize) {
    let available = try await SCShareableContent.current
    // 1) try to find the Dawn Client window
    if recTarget == "window",
       let dawnApp = available.applications.first(where: { $0.applicationName == "Dawn Client" }) {
        let filter = SCContentFilter(display: available.displays.first!,
                                     including: [dawnApp],
                                     exceptingWindows: [])
        let b = dawnApp.applicationName
        _ = b
        // use the first Dawn window's frame for sizing
        if let win = available.windows.first(where: { $0.owningApplication?.applicationName == "Dawn Client" }) {
            let f = win.frame
            return (filter, CGSize(width: f.width, height: f.height))
        }
        return (filter, CGSize(width: 1920, height: 1080))
    }
    // 2) fallback: main display (capture everything except nothing)
    guard let display = available.displays.first else { throw NSError(domain: "dawn", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let scale = NSScreen.main?.backingScaleFactor ?? 1.0
    return (filter, CGSize(width: CGFloat(display.width) * scale, height: CGFloat(display.height) * scale))
}

// ----------------------------------------------------------------------------
// Recording control
// ----------------------------------------------------------------------------
func startRecording() async {
    guard !isRecording else { log("already recording"); return }
    ensureOutputDir()
    let url = newOutputURL()
    // fetch capture target + dimensions first so the writer knows the frame size
    let content: (SCContentFilter, CGSize)
    do { content = try await pickContent() } catch { log("pickContent failed: \(error)"); return }
    let (filter, size) = content
    let w = max(2, Int(size.width))
    let h = max(2, Int(size.height))
    do {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
            // hardware encode is the default on macOS for h264 via VideoToolbox
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        assetWriter = writer
        videoInput = input
        didAddInput = false

        streamQueue.async {
            Task {
                do {
                    let cfg = SCStreamConfiguration()
                    cfg.width = w
                    cfg.height = h
                    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(recFps))
                    cfg.pixelFormat = kCVPixelFormatType_32BGRA
                    cfg.capturesAudio = false
                    cfg.showsCursor = true

                    let s = SCStream(filter: filter, configuration: cfg, delegate: nil)
                    let out = RecorderOutput()
                    try s.addStreamOutput(out, type: .screen, sampleHandlerQueue: streamQueue)
                    try await s.startCapture()
                    stream = s
                    isRecording = true
                    DispatchQueue.main.async { updateMenuBar() }
                    log("recording started -> \(url.path)")
                    startCompletion?(); startCompletion = nil
                } catch {
                    log("start failed: \(error)")
                    writer.cancelWriting()
                    assetWriter = nil; videoInput = nil
                    startCompletion?(); startCompletion = nil
                }
            }
        }
    } catch {
        log("AVAssetWriter init failed: \(error)")
    }
}

func stopRecording() {
    guard isRecording else { log("not recording"); return }
    isRecording = false
    DispatchQueue.main.async { updateMenuBar() }
    let writer = assetWriter
    let s = stream
    let outURL: URL? = writer?.outputURL
    streamQueue.async {
        Task {
            do { try await s?.stopCapture() } catch { log("stopCapture err: \(error)") }
            stream = nil
            // give the writer a moment to flush the last buffers
            try? await Task.sleep(nanoseconds: 400_000_000)
            writer?.finishWriting {
                if let u = outURL, let w = writer {
                    let ok = w.status == .completed
                    let sz = (try? FileManager.default.attributesOfItem(atPath: u.path)[.size] as? Int) ?? 0
                    log("recording stopped. completed=\(ok) bytes=\(sz) -> \(u.path)")
                }
                assetWriter = nil; videoInput = nil; didAddInput = false
                stopCompletion?(); stopCompletion = nil
            }
        }
    }
}

func toggleRecording() {
    if isRecording { stopRecording() }
    else { Task { await startRecording() } }
}

// ----------------------------------------------------------------------------
// Stream output
// ----------------------------------------------------------------------------
class RecorderOutput: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let writer = assetWriter, let input = videoInput else { return }
        if sampleBuffer.numSamples == 0 { return }
        if writer.status == .unknown {
            // need to start a session with the first buffer's timing
            if !writer.startWriting() { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)
        }
        if !didAddInput {
            if writer.canAdd(input) { writer.add(input); didAddInput = true }
            else { log("cannot add input"); return }
        }
        if input.isReadyForMoreMediaData {
            input.append(sampleBuffer)
        }
    }
}

// ----------------------------------------------------------------------------
// Menu bar (lightweight status indicator)
// ----------------------------------------------------------------------------
class MenuTarget: NSObject {
    @objc func toggle() { toggleRecording() }
    @objc func quit() { stopRecording(); NSApplication.shared.terminate(nil) }
}
let menuTarget = MenuTarget()

var statusItem: NSStatusItem?
func setupMenuBar() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem = item
    updateMenuBar()
    let menu = NSMenu()
    let toggle = NSMenuItem(title: "Toggle Recording (F9)", action: #selector(MenuTarget.toggle), keyEquivalent: "")
    toggle.target = menuTarget
    let quit = NSMenuItem(title: "Quit", action: #selector(MenuTarget.quit), keyEquivalent: "q")
    quit.target = menuTarget
    menu.addItem(toggle); menu.addItem(quit)
    item.menu = menu
}
func updateMenuBar() {
    if let b = statusItem?.button {
        b.title = isRecording ? "● REC" : "○"
        b.toolTip = isRecording ? "Dawn Recorder: recording — press F9 to stop" : "Dawn Recorder: idle — press F9 to record"
    }
}

// ----------------------------------------------------------------------------
// Global hotkey (CGEvent tap)
// ----------------------------------------------------------------------------
func setupHotkey() {
    let mask = (1 << CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                      place: .headInsertEventTap,
                                      options: .defaultTap,
                                      eventsOfInterest: CGEventMask(mask),
                                      callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
        if type == .keyDown {
            let kc = event.getIntegerValueField(.keyboardEventKeycode)
            let wanted = Int64(UserDefaults.standard.integer(forKey: "recKeyCode"))
            if kc == wanted { toggleRecording() }
        }
        return Unmanaged.passRetained(event)
    }, userInfo: nil) else {
        log("failed to create hotkey tap (need Accessibility permission)")
        return
    }
    UserDefaults.standard.set(recKeyCode, forKey: "recKeyCode")
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    log("hotkey tap active (keycode \(recKeyCode))")
}

// ----------------------------------------------------------------------------
// IPC: named pipe (FIFO) — robust control from `dawn-recorder --toggle` etc.
//      (BSD signals are unreliable inside a Cocoa run loop, so we use a FIFO)
// ----------------------------------------------------------------------------
let fifoPath = NSTemporaryDirectory() + "dawn-rec-control"

func setupControlFIFO() {
    unlink(fifoPath)
    mkfifo(fifoPath, 0o600)
    DispatchQueue.global(qos: .utility).async {
        while true {
            let fd = open(fifoPath, O_RDONLY)
            guard fd >= 0 else { sleep(1); continue }
            var buf = [CChar](repeating: 0, count: 1)
            let n = read(fd, &buf, 1)
            close(fd)
            guard n == 1 else { continue }
            switch buf[0] {
            case 0x74: toggleRecording()                  // 't'
            case 0x73: if !isRecording { Task { await startRecording() } }  // 's'
            case 0x78: if isRecording { stopRecording() }  // 'x'
            default: break
            }
        }
    }
    log("control FIFO ready at \(fifoPath)")
}

// ----------------------------------------------------------------------------
// Remote control (for --toggle / --start / --stop)
// ----------------------------------------------------------------------------
func remoteControl(_ kind: String) {
    guard readPid() != nil else {
        log("no running daemon found"); exit(2)
    }
    // open for write (non-blocking so we don't hang if reader disappeared)
    let fd = open(fifoPath, O_WRONLY | O_NONBLOCK)
    guard fd >= 0 else { log("cannot open control FIFO (daemon not ready?)"); exit(3) }
    let byte: CChar = (kind == "start") ? 0x73 : (kind == "stop" ? 0x78 : 0x74)
    write(fd, [byte], 1)
    close(fd)
    log("sent \(kind) to daemon")
    exit(0)
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
let args = CommandLine.arguments
if args.contains("--toggle") { remoteControl("toggle") }
else if args.contains("--start") { remoteControl("start") }
else if args.contains("--stop") { remoteControl("stop") }

// Running as daemon
writePid()
setupControlFIFO()
setupMenuBar()
setupHotkey()

// Accessibility prompt (one-time)
let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
_ = AXIsProcessTrustedWithOptions(opts)

log("dawn-recorder daemon started (pid \(ProcessInfo.processInfo.processIdentifier))")
NSApplication.shared.run()
