//
// CGVirtualDisplay.h — bridging header for private CoreGraphics virtual display API
//
// Forked from BetterDummy v1.0.x OpenSource Edition, MIT (opensource branch:
// which declares the same private CoreGraphics surface via @interface forward
// declarations against the live Obj-C symbols. We only declare the bits we use
// (descriptor + mode + settings + display) — the private framework has more.
//
// Loaded by the AegisDisplayHelper Swift target via SwiftPM
// `-import-objc-header` flag (see Package.swift swiftSettings). The Obj-C
// runtime resolves these symbols at load time from CoreGraphics.framework;
// if Apple ever renames them, the binary will fail to load with a missing-
// class linker message rather than silently degrading.
//
// Verified shape: macOS 12 - 15.

#ifndef AegisDisplay_CGVirtualDisplay_h
#define AegisDisplay_CGVirtualDisplay_h

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

@interface CGVirtualDisplayDescriptor : NSObject
@property (nonatomic, strong, nullable) dispatch_queue_t queue;
@property (nonatomic, copy, nullable) NSString *name;
@property (nonatomic, assign) uint32_t maxPixelsWide;
@property (nonatomic, assign) uint32_t maxPixelsHigh;
@property (nonatomic, assign) CGSize sizeInMillimeters;
@property (nonatomic, assign) uint32_t serialNum;
@property (nonatomic, assign) uint32_t productID;
@property (nonatomic, assign) uint32_t vendorID;
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(uint32_t)width
                       height:(uint32_t)height
                  refreshRate:(double)refreshRate;
@property (nonatomic, readonly) uint32_t width;
@property (nonatomic, readonly) uint32_t height;
@property (nonatomic, readonly) double refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property (nonatomic, copy, nullable) NSArray<CGVirtualDisplayMode *> *modes;
@property (nonatomic, assign) uint32_t hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (nullable instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property (nonatomic, readonly) uint32_t displayID;
@end

NS_ASSUME_NONNULL_END

#endif /* AegisDisplay_CGVirtualDisplay_h */
