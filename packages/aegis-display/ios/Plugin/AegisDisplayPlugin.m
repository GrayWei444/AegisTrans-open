//
//  AegisDisplayPlugin.m
//  Capacitor plugin 註冊 — 把 Swift @objc method 暴露給 Capacitor bridge。
//  plugin 名 "AegisDisplay" 必須與 JS 端 registerPlugin('AegisDisplay') 一致。
//
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(AegisDisplayPlugin, "AegisDisplay",
    // 虛擬螢幕 / 擷取（iOS 回 not-supported）
    CAP_PLUGIN_METHOD(captureScreen, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getVirtualDisplayStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(enableVirtualDisplay, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disableVirtualDisplay, CAPPluginReturnPromise);
    // 螢幕投放發送
    CAP_PLUGIN_METHOD(startScreenSend, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(setScreenSendRemoteDescription, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addScreenSendIceCandidate, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopScreenSend, CAPPluginReturnPromise);
)
