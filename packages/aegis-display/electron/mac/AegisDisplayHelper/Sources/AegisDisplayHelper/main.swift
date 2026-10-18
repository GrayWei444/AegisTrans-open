//
// AegisDisplayHelper main.swift — CLI entrypoint
//
// JSON RPC contract (called by ../../../src/plugin.ts via child_process.spawn):
//
//   ./AegisDisplayHelper status
//     → stdout JSON: { "supported": bool, "enabled": bool, "reason"?: string,
//                       "displayId"?: string, "resolution"?: string }
//     → exit 0 always (status query never fails)
//
//   ./AegisDisplayHelper enable --resolution 2560x1440
//     → stdout JSON: { "supported": true, "enabled": true, "displayId": "...",
//                       "resolution": "2560x1440" } (flushed immediately)
//     → process BLOCKS on a runloop until SIGTERM/SIGINT/SIGHUP, then tears
//        down the CGVirtualDisplay and exits 0. The system-level display lives
//        for the helper's lifetime; the Electron plugin (../../src/plugin.ts)
//        tracks the spawned PID and sends SIGTERM to "disable".
//
//   ./AegisDisplayHelper disable
//     → stdout JSON: { "supported": true, "enabled": false }
//     → exit 0. This is a no-op in a fresh helper process (no shared state with
//        the running `enable` daemon). It exists for CLI symmetry; real
//        teardown happens via SIGTERM to the enable PID.
//
// Resolution profiles allowed: 1920x1080, 2560x1440, 3840x2160 (validated by
// the Electron plugin before spawn; helper trusts the input).

import Foundation
import Dispatch

// ─── Global state (must precede the switch — main.swift is lexical-order;
//     vars declared below their use would not yet be initialized) ─────────────

/// DispatchSourceSignal needs a strong ref to keep firing — stash them here.
private var signalSources: [DispatchSourceSignal] = []

/// Released when any of the watched signals fires; main thread waits on this.
let cleanupSemaphore = DispatchSemaphore(value: 0)

// ─── Argument parsing ────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
    emitError("usage: AegisDisplayHelper <status|enable|disable> [--resolution WxH]")
    exit(2)
}

let subcommand = args[1]
var flags: [String: String] = [:]
var i = 2
while i < args.count {
    let arg = args[i]
    if arg.hasPrefix("--"), i + 1 < args.count {
        let key = String(arg.dropFirst(2))
        flags[key] = args[i + 1]
        i += 2
    } else {
        i += 1
    }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

let manager = VirtualDisplayManager.shared

switch subcommand {
case "status":
    let status = manager.status()
    emitJSON(status.asJSON())
    exit(0)

case "enable":
    guard let resolutionStr = flags["resolution"],
          let resolution = DisplayResolution(rawValue: resolutionStr) else {
        emitError("--resolution required (1920x1080|2560x1440|3840x2160)")
        exit(2)
    }
    do {
        let status = try manager.enable(resolution: resolution)
        emitJSON(status.asJSON())
    } catch {
        emitError("enable failed: \(error.localizedDescription)")
        exit(1)
    }
    // The CGVirtualDisplay strong ref must outlive the process. Block the main
    // thread on a semaphore; the signal handler (DispatchSource on .global())
    // tears down the display and signals the semaphore. Tried first:
    //   • RunLoop.main.run()  — returns immediately in a CLI (no NSApp = no
    //     scheduled runloop sources, so the loop has nothing to wait on).
    //   • dispatchMain()      — blocks but DispatchSource on .main queue is
    //     never serviced in our process layout; pending SIGHUP from job
    //     control kills us before any source fires.
    // Semaphore is the simplest "block until any of these signals" primitive
    // that does not depend on runloop wiring.
    installSignalCleanup()
    cleanupSemaphore.wait()
    exit(0)

case "disable":
    let status = manager.disable()
    emitJSON(status.asJSON())
    exit(0)

default:
    emitError("unknown subcommand '\(subcommand)' (expected status|enable|disable)")
    exit(2)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func emitJSON(_ obj: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        emitError("failed to encode JSON: \(error.localizedDescription)")
        exit(1)
    }
}

func emitError(_ msg: String) {
    FileHandle.standardError.write(Data("AegisDisplayHelper: \(msg)\n".utf8))
}

/// Install SIGTERM/SIGINT/SIGHUP handlers that tear down the virtual display
/// and signal the main-thread semaphore. `signal(_:SIG_IGN)` first so the
/// default action (process termination) doesn't pre-empt the DispatchSource.
/// The dispatch source runs on a background queue so it does not depend on a
/// runloop / dispatchMain on the main thread.
func installSignalCleanup() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        source.setEventHandler {
            _ = VirtualDisplayManager.shared.disable()
            cleanupSemaphore.signal()
        }
        source.resume()
        signalSources.append(source)
    }
}
