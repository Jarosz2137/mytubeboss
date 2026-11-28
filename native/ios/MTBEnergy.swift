import Foundation
import UIKit
import Capacitor
import Darwin

@objc(MTBEnergyPlugin)
public class MTBEnergyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MTBEnergyPlugin"
    public let jsName = "MTBEnergy"
    public let pluginMethods = [CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise)]
    private var observers: [NSObjectProtocol] = []
    private var previousCPU: Double?
    private var previousTime: TimeInterval?
    public override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            UIDevice.current.isBatteryMonitoringEnabled = true
            for name in [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.notifyListeners("change", data: self?.state() ?? [:])
                })
            }
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    private func state() -> [String: Any] {
        let p = ProcessInfo.processInfo
        let thermal: String
        switch p.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }
        let d = UIDevice.current
        let battery: String
        switch d.batteryState {
        case .unplugged: battery = "unplugged"
        case .charging: battery = "charging"
        case .full: battery = "full"
        default: battery = "unknown"
        }
        return ["thermal": thermal, "lowPower": p.isLowPowerModeEnabled, "batteryLevel": Double(d.batteryLevel), "batteryState": battery]
    }
    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var data = self.state()
            var usage = rusage()
            if getrusage(RUSAGE_SELF, &usage) == 0 {
                let cpu = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec)/1e6 + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec)/1e6
                let now = ProcessInfo.processInfo.systemUptime
                if let old = self.previousCPU, let time = self.previousTime, now > time {
                    data["hostCPUPercent"] = max(0, (cpu-old)/(now-time)*100)
                }
                self.previousCPU = cpu; self.previousTime = now
            }
            var info = task_vm_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let result = withUnsafeMutablePointer(to: &info) { ptr in
                ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
            }
            if result == KERN_SUCCESS { data["hostFootprintMB"] = Double(info.phys_footprint)/1048576 }
            call.resolve(data)
        }
    }
}
