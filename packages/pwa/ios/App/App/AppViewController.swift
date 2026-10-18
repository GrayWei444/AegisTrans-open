//
//  AppViewController.swift
//  AegisTrans iOS — app 內自訂 Capacitor plugin 的註冊點。
//
//  ⚠️ Capacitor 8 對「app target 內」的自訂 plugin **不會自動註冊**（自動註冊只適用
//  Pod 安裝的 plugin package）。CAPBridgedPlugin 只是提供 method 表，bridge 要靠
//  capacitorDidLoad() 裡 registerPluginInstance 手動掛——漏掛的症狀是 JS 端
//  「"X" plugin is not implemented on ios」（2026-07-20 IapPlugin 實錘）。
//  Main.storyboard 的 view controller custom class 必須指到本類。
//

import UIKit
import Capacitor

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(IapPlugin())
        bridge?.registerPluginInstance(AegisFileStreamPlugin())
    }
}
