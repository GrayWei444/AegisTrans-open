//
// VirtualDisplay.swift — CGVirtualDisplay binding
//
// Phase 2 §6.2 (2026-05-11): real impl, forked from BetterDummy MIT
// (https://github.com/waydabber/BetterDummy/blob/opensource/BetterDummy/Support/DummyManager.swift).
//
// Binding strategy:
//   The CGVirtualDisplay private CoreGraphics classes are surfaced via a
//   bridging header (Sources/AegisDisplayHelper/CGVirtualDisplay.h) wired
//   into this target through SwiftPM `-import-objc-header` (see Package.swift).
//   The Obj-C runtime resolves the @interface declarations against the live
//   CoreGraphics symbols at load time. Same pattern BetterDummy uses; survives
//   macOS 12 - 15.
//
// Process lifecycle:
//   The system-level virtual display lives for the lifetime of the Swift
//   strong reference held in `VirtualDisplayManager.state`, which equals the
//   lifetime of the helper process. main.swift blocks on a semaphore after
//   `enable` emits its JSON; SIGTERM (or SIGINT/SIGHUP) tears down the display
//   via ARC dealloc and exits cleanly. Electron's plugin tracks the spawned
//   helper PID and signals it to disable.

import Foundation
import CoreGraphics
import AppKit

enum DisplayResolution: String {
    case hd1080 = "1920x1080"
    case qhd1440 = "2560x1440"
    case uhd2160 = "3840x2160"

    var width: UInt32 {
        switch self {
        case .hd1080: return 1920
        case .qhd1440: return 2560
        case .uhd2160: return 3840
        }
    }

    var height: UInt32 {
        switch self {
        case .hd1080: return 1080
        case .qhd1440: return 1440
        case .uhd2160: return 2160
        }
    }
}

struct VirtualDisplayStatus {
    let supported: Bool
    let enabled: Bool
    let reason: String?
    let displayId: String?
    let resolution: DisplayResolution?

    static func notSupported(reason: String) -> VirtualDisplayStatus {
        VirtualDisplayStatus(
            supported: false, enabled: false,
            reason: reason, displayId: nil, resolution: nil
        )
    }

    static func disabledSupported() -> VirtualDisplayStatus {
        VirtualDisplayStatus(
            supported: true, enabled: false,
            reason: nil, displayId: nil, resolution: nil
        )
    }

    static func enabledOk(displayId: String, resolution: DisplayResolution) -> VirtualDisplayStatus {
        VirtualDisplayStatus(
            supported: true, enabled: true,
            reason: nil, displayId: displayId, resolution: resolution
        )
    }

    func asJSON() -> [String: Any] {
        var result: [String: Any] = [
            "supported": supported,
            "enabled": enabled
        ]
        if let reason = reason { result["reason"] = reason }
        if let displayId = displayId { result["displayId"] = displayId }
        if let resolution = resolution { result["resolution"] = resolution.rawValue }
        return result
    }
}

enum VirtualDisplayError: LocalizedError {
    case alreadyEnabled
    case privateApiUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .alreadyEnabled:
            return "Virtual display already enabled; call disable first."
        case .privateApiUnavailable(let detail):
            return "CGVirtualDisplay private API unavailable: \(detail)"
        }
    }
}

private struct VirtualDisplayState {
    let display: CGVirtualDisplay
    let resolution: DisplayResolution
    let displayId: String
}

/// Manages the lifecycle of the singleton AegisDisplay virtual screen.
///
/// State lives only for the duration of this process; CGVirtualDisplay is torn
/// down by macOS as soon as our strong reference deallocates. See the file-level
/// comment for the process-lifecycle caveat.
final class VirtualDisplayManager {
    static let shared = VirtualDisplayManager()
    private init() {}

    /// Identifies "our" virtual display when enumerating CGGetActiveDisplayList.
    static let virtualDisplayName = "AegisDisplay"

    private var state: VirtualDisplayState?

    func status() -> VirtualDisplayStatus {
        if let s = state {
            return .enabledOk(displayId: s.displayId, resolution: s.resolution)
        }
        return .disabledSupported()
    }

    func enable(resolution: DisplayResolution) throws -> VirtualDisplayStatus {
        if state != nil { throw VirtualDisplayError.alreadyEnabled }

        // 1. Build descriptor. Four-char tags ('AEGD' / 'AEGS') let downstream
        //    code identify the display by EDID-ish fields (BetterDummy uses
        //    'nild'/'parp'/'nidl'; we pick our own).
        let descriptor = CGVirtualDisplayDescriptor()
        descriptor.queue = DispatchQueue.global(qos: .userInteractive)
        descriptor.name = Self.virtualDisplayName
        descriptor.maxPixelsWide = resolution.width
        // Apple's runtime property is `maxPixelsHigh`, not `maxPixelsTall` — the
        // latter dispatches to a missing selector and crashes. Verified via
        // class_copyMethodList on macOS 15 (2026-05-11).
        descriptor.maxPixelsHigh = resolution.height
        let mmW = CGFloat(resolution.width) / 96.0 * 25.4
        let mmH = CGFloat(resolution.height) / 96.0 * 25.4
        descriptor.sizeInMillimeters = CGSize(width: mmW, height: mmH)
        descriptor.serialNum = 0x41454744 // 'AEGD'
        descriptor.productID = 0x41454744 // 'AEGD'
        descriptor.vendorID  = 0x41454753 // 'AEGS'

        // 2. Create the display. -initWithDescriptor: is where macOS actually
        //    registers the virtual screen.
        guard let display = CGVirtualDisplay(descriptor: descriptor) else {
            throw VirtualDisplayError.privateApiUnavailable(
                "-[CGVirtualDisplay initWithDescriptor:] returned nil — private API likely changed"
            )
        }

        // 3. Apply mode list. We expose a 1x mode at the requested resolution
        //    plus a half-size mode flagged hiDPI=1, so macOS shows the display
        //    as retina-capable in System Settings → Displays.
        let mode1x = CGVirtualDisplayMode(
            width: resolution.width,
            height: resolution.height,
            refreshRate: 60.0
        )
        let mode2x = CGVirtualDisplayMode(
            width: max(resolution.width / 2, 640),
            height: max(resolution.height / 2, 360),
            refreshRate: 60.0
        )
        let settings = CGVirtualDisplaySettings()
        settings.modes = [mode1x, mode2x]
        settings.hiDPI = 1

        // Swift bridges Obj-C `applySettings:` to `apply(_:)` (renamed in Swift 3);
        // calling the old name builds with an "obsoleted" error.
        guard display.apply(settings) else {
            throw VirtualDisplayError.privateApiUnavailable(
                "-[CGVirtualDisplay applySettings:] returned NO"
            )
        }

        // 4. Resolve CGDirectDisplayID. Zero means macOS hasn't assigned one
        //    yet — we still consider the call a success since the display
        //    object owns the system-level resource regardless.
        let displayId = display.displayID > 0
            ? String(format: "0x%08x", display.displayID)
            : "\(Self.virtualDisplayName)-\(resolution.rawValue)"

        state = VirtualDisplayState(
            display: display,
            resolution: resolution,
            displayId: displayId
        )
        return .enabledOk(displayId: displayId, resolution: resolution)
    }

    func disable() -> VirtualDisplayStatus {
        // Idempotent: a fresh helper process always has nil state, so calling
        // `disable` as a standalone CLI command (separate from the running
        // `enable` daemon) is a no-op rather than an error. Real teardown
        // happens when the enable-spawned helper receives SIGTERM and ARC
        // releases the CGVirtualDisplay → macOS removes the system display.
        state = nil
        return .disabledSupported()
    }
}
