// Reads newline-delimited JSON commands on stdin and posts them as CGEvents.
// Kept as a separate process so the Node agent needs zero native modules.
//
// Commands:
//   {"t":"m","dx":1.5,"dy":-2}        relative move (becomes a drag if a button is held)
//   {"t":"d","b":"l"}                 button down   (b: "l" | "r")
//   {"t":"u","b":"l"}                 button up
//   {"t":"c","b":"l","n":2}           click n times (n optional, default 1)
//   {"t":"s","dx":0,"dy":40}          scroll, pixel units
//   {"t":"txt","s":"hello"}           type a unicode string
//   {"t":"key","k":"return","m":["cmd"]}  special key with modifiers
//   {"t":"ping"}                      liveness check, replies "pong" on stdout

import Foundation
import CoreGraphics

final class Injector {
    private var pos: CGPoint
    private var bounds: CGRect
    private var leftDown = false
    private var rightDown = false
    private let src = CGEventSource(stateID: .hidSystemState)

    private static let keys: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "escape": 53, "esc": 53, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "a": 0, "s": 1, "d": 2, "f": 3, "z": 6, "x": 7, "c": 8, "v": 9,
        "q": 12, "w": 13, "t": 17, "r": 15, "n": 45, "p": 35,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f11": 103, "f12": 111
    ]

    init() {
        bounds = Injector.desktopBounds()
        pos = CGEvent(source: nil)?.location
            ?? CGPoint(x: bounds.midX, y: bounds.midY)
    }

    // Union of every active display, so multi-monitor clamping works for free.
    private static func desktopBounds() -> CGRect {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        guard count > 0 else { return CGRect(x: 0, y: 0, width: 1440, height: 900) }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        var r = CGDisplayBounds(ids[0])
        for id in ids.dropFirst() { r = r.union(CGDisplayBounds(id)) }
        return r
    }

    private func flags(_ mods: [String]) -> CGEventFlags {
        var f: CGEventFlags = []
        for m in mods {
            switch m {
            case "cmd", "meta": f.insert(.maskCommand)
            case "shift": f.insert(.maskShift)
            case "alt", "option": f.insert(.maskAlternate)
            case "ctrl", "control": f.insert(.maskControl)
            case "fn": f.insert(.maskSecondaryFn)
            default: break
            }
        }
        return f
    }

    func move(dx: Double, dy: Double) {
        pos.x = min(max(pos.x + dx, bounds.minX), bounds.maxX - 1)
        pos.y = min(max(pos.y + dy, bounds.minY), bounds.maxY - 1)

        let type: CGEventType = leftDown ? .leftMouseDragged
            : (rightDown ? .rightMouseDragged : .mouseMoved)
        let btn: CGMouseButton = rightDown ? .right : .left

        guard let e = CGEvent(mouseEventSource: src, mouseType: type,
                              mouseCursorPosition: pos, mouseButton: btn) else { return }
        // Apps that read raw deltas (Blender, Figma, games) need these set explicitly.
        e.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
        e.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
        e.post(tap: .cghidEventTap)
    }

    func button(_ b: String, down: Bool) {
        let isRight = (b == "r")
        let type: CGEventType = isRight
            ? (down ? .rightMouseDown : .rightMouseUp)
            : (down ? .leftMouseDown : .leftMouseUp)
        guard let e = CGEvent(mouseEventSource: src, mouseType: type,
                              mouseCursorPosition: pos,
                              mouseButton: isRight ? .right : .left) else { return }
        e.post(tap: .cghidEventTap)
        if isRight { rightDown = down } else { leftDown = down }
    }

    func click(_ b: String, count: Int) {
        let isRight = (b == "r")
        let btn: CGMouseButton = isRight ? .right : .left
        let dt: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let ut: CGEventType = isRight ? .rightMouseUp : .leftMouseUp

        for i in 1...max(1, count) {
            for t in [dt, ut] {
                guard let e = CGEvent(mouseEventSource: src, mouseType: t,
                                      mouseCursorPosition: pos, mouseButton: btn) else { continue }
                // clickState is what makes the OS read two events as a double click.
                e.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                e.post(tap: .cghidEventTap)
            }
        }
    }

    func scroll(dx: Double, dy: Double) {
        guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel,
                              wheelCount: 2,
                              wheel1: Int32(dy.rounded()),
                              wheel2: Int32(dx.rounded()),
                              wheel3: 0) else { return }
        e.post(tap: .cghidEventTap)
    }

    // Unicode injection sidesteps keyboard-layout lookup entirely.
    func type(_ s: String) {
        for ch in s {
            let u = Array(String(ch).utf16)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            else { continue }
            down.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
            up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    func key(_ name: String, mods: [String]) {
        guard let code = Injector.keys[name.lowercased()] else { return }
        let f = flags(mods)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
        else { return }
        down.flags = f
        up.flags = f
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    func handle(_ o: [String: Any]) {
        guard let t = o["t"] as? String else { return }
        let dx = (o["dx"] as? Double) ?? 0
        let dy = (o["dy"] as? Double) ?? 0
        let b = (o["b"] as? String) ?? "l"

        switch t {
        case "m": move(dx: dx, dy: dy)
        case "d": button(b, down: true)
        case "u": button(b, down: false)
        case "c": click(b, count: (o["n"] as? Int) ?? 1)
        case "s": scroll(dx: dx, dy: dy)
        case "txt": if let s = o["s"] as? String { type(s) }
        case "key":
            if let k = o["k"] as? String { key(k, mods: (o["m"] as? [String]) ?? []) }
        case "bounds":
            // Re-read displays after a monitor is plugged or unplugged.
            bounds = Injector.desktopBounds()
        case "pos":
            // Reads the real system cursor, not the tracked value, so a caller
            // can tell whether posted events actually landed.
            let real = CGEvent(source: nil)?.location ?? pos
            print("pos \(Int(real.x)),\(Int(real.y))"); fflush(stdout)
        case "ping":
            print("pong"); fflush(stdout)
        default: break
        }
    }

    func run() {
        print("ready \(Int(bounds.width))x\(Int(bounds.height))")
        fflush(stdout)
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
            guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            handle(o)
        }
    }
}

@main
struct Main {
    static func main() {
        Injector().run()
    }
}
