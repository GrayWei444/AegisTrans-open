require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'AegisrdCapacitorAegisdisplay'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  # 本地 plugin（Capacitor 以 :path 引用），homepage／source 只是 podspec 必填欄位，不會被拿來下載
  s.homepage = 'https://localhost/aegis-display'
  s.author = package['author']
  s.source = { :git => 'https://localhost/aegis-display.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
  # 螢幕投放發送用 ReplayKit（系統 framework）；真正的 WebRTC PeerConnection 在 Broadcast
  # Upload Extension target（不在此 plugin），所以這裡不依賴 WebRTC pod。
  s.frameworks = 'ReplayKit'
end
