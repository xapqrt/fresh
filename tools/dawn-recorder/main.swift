import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin

// MARK: - Configuration
enum Config {
    static let outputDir = (NSString(string: "~/Movies/clips") as String)
    static let fifoPath = "/tmp/dawn-recorder-\(getuid()).fifo"
    static let fps = max(1, min(240, Int(ProcessInfo.processInfo.environment["DAWN_REC_FPS"] ?? "") ?? 60))
    static let targetMode = ProcessInfo.processInfo.environment["DAWN_REC_TARGET"] ?? "window"
    static let hotkeyCode = Int(ProcessInfo.processInfo.environment["DAWN_REC_KEY"] ?? "") ?? 101
    static let windowName = "Dawn Client"
}

// MARK: - Screen Recorder
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let captureQueue = DispatchQueue(label: "com.dawn.recorder.capture", qos: .userInitiated)
    private let writerQueue = DispatchQueue(label: "com.dawn.recorder.writer", qos: .utility)
    private let lock = NSLock()

    private var _isRecording = false
    private var _isPaused = false
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var firstBuffer = true
    private var frameCount = 0

    var isRecording: Bool { lock.withLock { _isRecording } }
    var isPaused: Bool { lock.withLock { _isPaused } }

    var onStatusChange: ((Bool) -> Void)?

    func start() {
        lock.withLock {
            guard !_isRecording else { return }
            _isRecording = true
        }

        captureQueue.async { [weak self] in
            self?._setupCapture()
        }
    }

    func stop() {
        let shouldStop = lock.withLock {
            guard _isRecording else { return false }
            _isRecording = false
            return true
        }
        guard shouldStop else { return }

        DispatchQueue.main.async { [weak self] in
            self?.onStatusChange?(false)
        }

        writerQueue.async { [weak self] in
            guard let self = self else { return }
            let s = self.stream
            self.stream = nil

            s?.stopCapture { [weak self] error in
                if let error = error {
                    print("[DawnRecorder] stopCapture error: \(error.localizedDescription)")
                }
                self?._finalizeRecording()
            }
        }
    }

    func toggle() {
        if isRecording { stop() } else { start() }
    }

    private func _setupCapture() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self = self else { return }

            if let error = error {
                print("[DawnRecorder] getShareableContent error: \(error.localizedDescription)")
                print("[DawnRecorder] Screen Recording permission may not be granted.")
                self._abortRecording()
                return
            }

            guard let content = content else {
                print("[DawnRecorder] No shareable content")
                self._abortRecording()
                return
            }

            var filter: SCContentFilter?

            if Config.targetMode == "window" {
                if let win = content.windows.first(where: { $0.title == Config.windowName }) {
                    print("[DawnRecorder] Targeting window: \"\(win.title ?? "unknown")\"")
                    filter = SCContentFilter(desktopIndependentWindow: win)
                } else {
                    print("[DawnRecorder] Window \"\(Config.windowName)\" not found, using display")
                }
            }

            if filter == nil, let display = content.displays.first {
                filter = SCContentFilter(display: display, excludingWindows: [])
                print("[DawnRecorder] Targeting display \(display.displayID)")
            }

            guard let filter = filter else {
                print("[DawnRecorder] No capture target")
                self._abortRecording()
                return
            }

            let config = SCStreamConfiguration()
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(Config.fps))
            config.showsCursor = false
            config.queueDepth = 3

            let s = SCStream(filter: filter, configuration: config, delegate: self)
            self.stream = s
            self.firstBuffer = true
            self.frameCount = 0
            self.writer = nil
            self.videoInput = nil

            do {
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.captureQueue)
            } catch {
                print("[DawnRecorder] addStreamOutput failed: \(error.localizedDescription)")
                self._abortRecording()
                return
            }

            self.captureQueue.async {
                s.startCapture { [weak self] error in
                    if let error = error {
                        print("[DawnRecorder] startCapture error: \(error.localizedDescription)")
                        self?._abortRecording()
                    } else {
                        print("[DawnRecorder] Capture started")
                        DispatchQueue.main.async {
                            self?.onStatusChange?(true)
                        }
                    }
                }
            }
        }
    }

    private func _abortRecording() {
        lock.withLock { _isRecording = false; _isPaused = false }
        stream = nil
        writer = nil
        videoInput = nil
        firstBuffer = true
        DispatchQueue.main.async { [weak self] in
            self?.onStatusChange?(false)
        }
    }

    /// Pause/resume the live capture without finalizing the file. While paused
    /// we simply drop incoming frames (SCStream has no public pause API in this
    /// SDK), so the clip stays a single continuous movie with a gap.
    func pause() {
        guard isRecording, !isPaused else { return }
        lock.withLock { _isPaused = true }
        print("[DawnRecorder] Paused")
    }

    func resume() {
        guard isRecording, isPaused else { return }
        lock.withLock { _isPaused = false }
        print("[DawnRecorder] Resumed")
    }

    private func _finalizeRecording() {
        defer {
            self.stream = nil
            self.writer = nil
            self.videoInput = nil
            self.firstBuffer = true
            self.frameCount = 0
        }

        guard let videoInput = videoInput, let writer = writer else {
            print("[DawnRecorder] No recording to finalize")
            return
        }

        // CRITICAL: AVAssetWriter aborts the whole process (uncatchable Obj-C
        // exception) if finishWriting is called when status != .writing. If the
        // session never started (no frames written -> status .unknown) we must
        // NOT call finishWriting; just discard the empty file instead.
        guard writer.status == .writing else {
            print("[DawnRecorder] Writer status \(writer.status.rawValue) (not .writing) — discarding empty file")
            try? FileManager.default.removeItem(at: writer.outputURL)
            return
        }

        videoInput.markAsFinished()

        writer.finishWriting {
            if writer.status == .completed {
                let size = (try? FileManager.default.attributesOfItem(atPath: writer.outputURL.path))?[.size] as? UInt64 ?? 0
                print("[DawnRecorder] Saved: \(writer.outputURL.lastPathComponent) (\(size) bytes)")
                if size < 1024 {
                    print("[DawnRecorder] Clip too small (\(size) bytes) — discarding")
                    try? FileManager.default.removeItem(at: writer.outputURL)
                }
            } else {
                print("[DawnRecorder] finishWriting failed: \(writer.error?.localizedDescription ?? "unknown")")
                try? FileManager.default.removeItem(at: writer.outputURL)
            }
        }
    }

    // MARK: - SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, CMSampleBufferDataIsReady(sampleBuffer) else { return }

        guard lock.withLock({ _isRecording }) else { return }

        if firstBuffer {
            firstBuffer = false

            guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }

            let dims = CMVideoFormatDescriptionGetDimensions(formatDesc)
            let w = max(2, (Int(dims.width) + 1) & ~1)
            let h = max(2, (Int(dims.height) + 1) & ~1)

            var colorProps: [String: String] = [:]
            if let ext = CMFormatDescriptionGetExtensions(formatDesc) as NSDictionary? {
                if let v = ext[kCMFormatDescriptionExtension_YCbCrMatrix] as? String {
                    colorProps[AVVideoYCbCrMatrixKey] = v
                }
                if let v = ext[kCMFormatDescriptionExtension_TransferFunction] as? String {
                    colorProps[AVVideoTransferFunctionKey] = v
                }
                if let v = ext[kCMFormatDescriptionExtension_ColorPrimaries] as? String {
                    colorProps[AVVideoColorPrimariesKey] = v
                }
            }

            var videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: w,
                AVVideoHeightKey: h,
            ]
            if !colorProps.isEmpty {
                videoSettings[AVVideoColorPropertiesKey] = colorProps
            }

            let df = DateFormatter()
            df.dateFormat = "yyyyMMdd-HHmmss"
            let fileName = "dawn-\(df.string(from: Date())).mp4"

            do {
                try FileManager.default.createDirectory(atPath: Config.outputDir, withIntermediateDirectories: true)
            } catch {
                print("[DawnRecorder] Failed to create output dir: \(error.localizedDescription)")
            }

            let fileURL = URL(fileURLWithPath: "\(Config.outputDir)/\(fileName)")

            guard let writer = try? AVAssetWriter(url: fileURL, fileType: .mp4) else {
                print("[DawnRecorder] Failed to create AVAssetWriter")
                return
            }

            let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
            input.expectsMediaDataInRealTime = true

            guard writer.canAdd(input) else {
                print("[DawnRecorder] AVAssetWriter cannot add input")
                return
            }
            writer.add(input)

            guard writer.startWriting() else {
                print("[DawnRecorder] AVAssetWriter.startWriting failed: \(writer.error?.localizedDescription ?? "unknown")")
                return
            }

            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)

            self.writer = writer
            self.videoInput = input

            print("[DawnRecorder] Recording \(w)x\(h) H.264 to \(fileName)")
        }

        // While paused we drop frames so the clip stays continuous (gap).
        if isPaused { return }

        guard let input = videoInput, let writer = writer,
              writer.status == .writing, input.isReadyForMoreMediaData else { return }

        if input.append(sampleBuffer) {
            frameCount += 1
            if frameCount % 60 == 0 {
                print("[DawnRecorder] Frames: \(frameCount)")
            }
        } else {
            print("[DawnRecorder] append failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
    }

    // MARK: - SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[DawnRecorder] Stream stopped: \(error.localizedDescription)")
        if isRecording {
            stop()
        }
    }
}

// MARK: - App Delegate
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let recorder = Recorder()
    private var eventTap: CFMachPort?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        setupFIFOReader()
        setupHotkey()

        recorder.onStatusChange = { [weak self] recording in
            self?.updateStatusBar(recording)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if recorder.isRecording {
            recorder.stop()
        }
        unlink(Config.fifoPath)
    }

    private func buildMenu() {
        let menu = NSMenu()

        let start = NSMenuItem(title: "Start Recording", action: #selector(toggleRecording), keyEquivalent: "")
        start.target = self
        menu.addItem(start)

        let pause = NSMenuItem(title: "Pause Recording", action: #selector(pauseRecording), keyEquivalent: "p")
        pause.target = self
        menu.addItem(pause)

        let open = NSMenuItem(title: "Open Clips Folder", action: #selector(openClipsFolder), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        updateStatusBar(false)
    }

    private func updateStatusBar(_ recording: Bool) {
        guard let btn = statusItem.button else { return }
        let items = statusItem.menu?.items ?? []

        if recording {
            btn.attributedTitle = NSAttributedString(string: "\u{25CF} Rec", attributes: [
                .foregroundColor: NSColor.red,
                .font: NSFont.menuBarFont(ofSize: 12)
            ])
            items[0].title = "Stop Recording"
            items[1].title = recorder.isPaused ? "Resume Recording" : "Pause Recording"
            items[1].isEnabled = true
        } else {
            btn.title = "\u{25CB}"
            items[0].title = "Start Recording"
            items[1].title = "Pause Recording"
            items[1].isEnabled = false
        }
        items[2].title = "Open Clips Folder"
    }

    @objc private func toggleRecording() {
        recorder.toggle()
    }

    @objc private func pauseRecording() {
        if recorder.isPaused { recorder.resume() } else { recorder.pause() }
        updateStatusBar(recorder.isRecording)
    }

    @objc private func openClipsFolder() {
        let clips = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Movies/clips")
        try? FileManager.default.createDirectory(at: clips, withIntermediateDirectories: true)
        NSWorkspace.shared.open(clips)
    }

    private func setupFIFOReader() {
        unlink(Config.fifoPath)
        mkfifo(Config.fifoPath, 0o644)

        DispatchQueue(label: "com.dawn.recorder.fifo", qos: .background).async { [weak self] in
            guard let self = self else { return }

            // Persistent BLOCKING reader. The client opens O_WRONLY (blocking),
            // so it waits for this reader to be connected. We keep one fd open
            // and read in a loop; reopen only after the writer closes (EOF).
            while true {
                let fd = open(Config.fifoPath, O_RDONLY)
                if fd < 0 {
                    Thread.sleep(forTimeInterval: 0.5)
                    continue
                }
                var byte: UInt8 = 0
                while read(fd, &byte, 1) == 1 {
                    print("[DawnRecorder] FIFO cmd: \(Character(UnicodeScalar(byte)))")
                    let b = byte
                    DispatchQueue.main.async {
                        switch b {
                        case UInt8(ascii: "t"): self.recorder.toggle()
                        case UInt8(ascii: "s"): self.recorder.start()
                        case UInt8(ascii: "S"): self.recorder.stop()
                        default: break
                        }
                    }
                }
                close(fd) // writer closed; loop to reopen
            }
        }
    }

    private func setupHotkey() {
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)

        let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: hotkeyCallback,
            userInfo: Unmanaged.passUnretained(recorder).toOpaque()
        )

        guard let tap = tap else {
            print("[DawnRecorder] Hotkey tap not available (keyboard shortcut disabled)")
            return
        }
        eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        // A global session tap only receives events if the process is trusted for
        // Accessibility. Without it the tap exists but stays DISABLED and the
        // hotkey silently does nothing. Prompt ONCE (only when not already
        // trusted) so we don't spam the permission dialog on every launch.
        if !CGEvent.tapIsEnabled(tap: tap) {
            print("[DawnRecorder] Hotkey disabled: Accessibility permission not granted")
            if !AXIsProcessTrusted() {
                let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                AXIsProcessTrustedWithOptions(opts)
                print("[DawnRecorder] Requesting Accessibility permission — please grant it and restart Dawn Recorder")
            }
        } else {
            print("[DawnRecorder] Hotkey F9 installed (keycode \(Config.hotkeyCode))")
        }
    }
}

// MARK: - Hotkey Callback
private func hotkeyCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .keyDown {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if keyCode == Int64(Config.hotkeyCode), let refcon = refcon {
            let recorder = Unmanaged<Recorder>.fromOpaque(refcon).takeUnretainedValue()
            recorder.toggle()
        }
    }
    return Unmanaged.passUnretained(event)
}

// MARK: - Main
private func main() {
    let args = CommandLine.arguments

    if args.contains("--toggle") || args.contains("-t") {
        sendCommand("t")
        return
    }
    if args.contains("--start") || args.contains("-s") {
        sendCommand("s")
        return
    }
    if args.contains("--stop") || args.contains("-S") {
        sendCommand("S")
        return
    }

    // Single-instance guard: hold an exclusive lock on a lock file. If another
    // instance is already running (e.g. user double-clicked the app again, or
    // launchd KeepAlive relaunched it), this open/flock fails and we exit so we
    // never have two daemons fighting over the FIFO / menu bar. flock is
    // auto-released when the process dies, so it's crash-safe.
    let lockPath = NSHomeDirectory() + "/Library/Application Support/dawn-client/recorder.lock"
    try? FileManager.default.createDirectory(at: URL(fileURLWithPath: (lockPath as NSString).deletingLastPathComponent), withIntermediateDirectories: true)
    let lockFD = open(lockPath, O_RDWR | O_CREAT, 0o644)
    if lockFD >= 0 {
        if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
            // Another instance holds the lock.
            let fd2 = open(Config.fifoPath, O_WRONLY | O_NONBLOCK)
            if fd2 >= 0 { close(fd2) } // ping the running instance so it stays awake
            print("[DawnRecorder] Already running — exiting this instance.")
            exit(0)
        }
    }

    setbuf(__stdoutp, nil)
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

private func sendCommand(_ cmd: String) {
    let fd = open(Config.fifoPath, O_WRONLY)
    if fd < 0 {
        print("Dawn Recorder is not running.")
        return
    }
    var byte = cmd.utf8.first!
    write(fd, &byte, 1)
    close(fd)
}

main()
