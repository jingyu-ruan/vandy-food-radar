import Foundation
import CoreText
import CoreGraphics

// Use native font outlines so the exported SVG needs no installed font.
let font = CTFontCreateWithName("HelveticaNeue-Medium" as CFString, 30, nil)
let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Vandy Food Radar", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
func n(_ value: CGFloat) -> String { String(format: "%.3f", Double(value)) }
var paths = ""
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let count = CTRunGetGlyphCount(run)
    var glyphs = [CGGlyph](repeating: 0, count: count)
    var positions = [CGPoint](repeating: .zero, count: count)
    CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
    CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
    for i in 0..<count {
        guard let path = CTFontCreatePathForGlyph(font, glyphs[i], nil) else { continue }
        var d = ""
        let origin = positions[i]
        path.applyWithBlock { ptr in
            let e = ptr.pointee
            func p(_ pointIndex: Int) -> String { "\(n(e.points[pointIndex].x + origin.x + 82)) \(n(42 - e.points[pointIndex].y))" }
            switch e.type {
            case .moveToPoint: d += "M\(p(0))"
            case .addLineToPoint: d += "L\(p(0))"
            case .addQuadCurveToPoint: d += "Q\(p(0)) \(p(1))"
            case .addCurveToPoint: d += "C\(p(0)) \(p(1)) \(p(2))"
            case .closeSubpath: d += "Z"
            @unknown default: break
            }
        }
        paths += "<path d=\"\(d)\"/>\n"
    }
}
let width = Int(ceil(CTLineGetTypographicBounds(line, nil, nil, nil))) + 94
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let mark = try String(contentsOf: dir.appendingPathComponent("vfr-mark.svg"), encoding: .utf8)
let bodyStart = mark.range(of: "  <g")!.lowerBound
let bodyEnd = mark.range(of: "</svg>")!.lowerBound
let markBody = String(mark[bodyStart..<bodyEnd])
let svg = """
<svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="64" viewBox="0 0 \(width) 64" fill="none">
<title>Vandy Food Radar</title>
<desc>V-shaped cutlery and radar symbol with an outlined wordmark.</desc>
\(markBody)
<g fill="#1C1C1C">\(paths)</g>
</svg>

"""
try svg.write(to: dir.appendingPathComponent("vfr-logo.svg"), atomically: true, encoding: .utf8)
try svg.replacingOccurrences(of: "#1C1C1C", with: "#F5F5F7").write(to: dir.appendingPathComponent("vfr-logo-dark.svg"), atomically: true, encoding: .utf8)
try mark.replacingOccurrences(of: "#1C1C1C", with: "#F5F5F7").write(to: dir.appendingPathComponent("vfr-mark-dark.svg"), atomically: true, encoding: .utf8)
print("Exported outlined wordmarks at \(width) × 64")
