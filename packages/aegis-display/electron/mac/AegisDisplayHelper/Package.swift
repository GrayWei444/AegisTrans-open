// swift-tools-version: 5.9
//
// AegisDisplayHelper — macOS CLI helper that creates / destroys virtual displays
// via Apple's private CGVirtualDisplay API. Spawned by the Capacitor Electron main
// process (../../src/plugin.ts) over JSON RPC on stdin/stdout.
//
// Phase 2 §6.2 (2026-05-11): CGVirtualDisplay binding wired via bridging header
// (Sources/AegisDisplayHelper/CGVirtualDisplay.h, forked from BetterDummy MIT).
// SwiftPM can't ship a real bridging header for executable targets, so we feed
// it through swiftc's `-import-objc-header` via `swiftSettings.unsafeFlags`.
// `unsafeFlags` marks the target as un-publishable; that's fine — this is the
// app, nothing depends on it.

import PackageDescription

let package = Package(
    name: "AegisDisplayHelper",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "AegisDisplayHelper", targets: ["AegisDisplayHelper"])
    ],
    targets: [
        .executableTarget(
            name: "AegisDisplayHelper",
            path: "Sources/AegisDisplayHelper",
            swiftSettings: [
                .unsafeFlags([
                    "-import-objc-header",
                    "Sources/AegisDisplayHelper/CGVirtualDisplay.h"
                ])
            ],
            linkerSettings: [
                // CGVirtualDisplayCreate lives in CoreGraphics
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Foundation"),
                .linkedFramework("AppKit")
            ]
        )
    ]
)
