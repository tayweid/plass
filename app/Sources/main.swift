// Plass.app: a native window around Plass, with everything it needs inside.
//
// The page, the Typst compiler, the shaping sidecar and the fonts ride in
// the bundle (Contents/Resources/web, the vite build) and are served to a
// WKWebView from plass://app/. Nothing is downloaded at runtime, so PDF
// export never waits on the network. Mac only, on the knuth pattern:
// one Swift file, built by app/build.sh with swiftc alone.
//
// Development switches (a Finder launch has none of them):
//   PLASS_URL       load this address instead of the bundle (the vite dev
//                   server, whose window hooks — __audit, __fm — exist)
//   PLASS_SELFTEST  a JavaScript file run in the page once it loads; its
//                   result is printed to stdout and the app quits. The
//                   body runs as an async function with `args` in scope.
//   PLASS_ARGS      JSON handed to the self-test as `args`
//   PLASS_SELFTEST_OUT  write the self-test result to this file instead
//   PLASS_GRANT     a path granted at launch, as if chosen in a panel

import AppKit
import UniformTypeIdentifiers
import WebKit

let environment = ProcessInfo.processInfo.environment
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Plass.log")
let bundledWebRoot = Bundle.main.resourceURL?.appendingPathComponent("web")
let appScheme = "plass"
let appOrigin = "\(appScheme)://app"

func log(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let text = "[\(stamp)] Plass.app: \(line)\n"
    try? FileManager.default.createDirectory(
        at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let descriptor = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard descriptor >= 0 else { return }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    handle.write(text.data(using: .utf8)!)
}

// MARK: - WebKit features

/// Turn on WebKit features the exact layout needs but shipping WebKit
/// leaves off. Private API (WKPreferences._features and
/// _setEnabled:forFeature:, as Safari's Feature Flags pane uses) — fine for
/// an app installed outside the App Store.
///
/// SubpixelInlineLayoutEnabled: without it, macOS 26's WebKit floors every
/// line box to a whole pixel (a 24.984375px line-height lays 24px lines),
/// so paragraphs come out short of Typst's line pitch and the paginator
/// fits extra lines on every page. Newer WebKit (and Chrome) keep the
/// fraction.
let requiredFeatures = ["SubpixelInlineLayoutEnabled"]

func enableRequiredFeatures(_ preferences: WKPreferences) {
    let listSelector = NSSelectorFromString("_features")
    let setSelector = NSSelectorFromString("_setEnabled:forFeature:")
    guard (WKPreferences.self as AnyObject).responds(to: listSelector),
          preferences.responds(to: setSelector),
          let features = (WKPreferences.self as AnyObject).perform(listSelector)?.takeUnretainedValue() as? [NSObject],
          let method = class_getInstanceMethod(WKPreferences.self, setSelector)
    else {
        log("WebKit feature API unavailable; exact layout may be off")
        return
    }
    typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
    let setEnabled = unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)
    for key in requiredFeatures {
        guard let feature = features.first(where: { ($0.value(forKey: "key") as? String) == key }) else {
            log("WebKit feature \(key) not found; exact layout may be off")
            continue
        }
        setEnabled(preferences, setSelector, true, feature)
    }
}

// MARK: - Serving the page from the bundle

/// plass://app/<path> → Contents/Resources/web/<path>.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    private static let contentTypes: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon",
        "woff": "font/woff", "woff2": "font/woff2", "otf": "font/otf", "ttf": "font/ttf",
        "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var relative = url.path
        if relative.isEmpty || relative == "/" { relative = "/index.html" }
        let requested = String(relative.dropFirst())
        let inBundle = root.appendingPathComponent(requested).standardizedFileURL
        let source: URL? = inBundle.path.hasPrefix(root.path + "/") ? inBundle : nil
        guard let file = source, let data = FileManager.default.contents(atPath: file.path) else {
            log("not in bundle: \(relative)")
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }
        let type = AppSchemeHandler.contentTypes[(requested as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Files on the page's behalf

/// Paths the writer handed to Plass: files and folders chosen in a panel or
/// opened from Finder. The page may read and write inside these and nowhere
/// else. Kept across launches, so recents and a window's own file reopen
/// without asking again (as Chrome's persisted permissions do).
enum Grants {
    private static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Plass/grants.json")
    private static let limit = 400
    private static var roots: [String] = {
        guard let data = try? Data(contentsOf: url),
              let list = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return [] }
        return list
    }()

    /// Fold "." and ".." and nothing else. Foundation's standardizing also
    /// drops a leading /private — but only for paths that exist, so a new
    /// file and its granted folder would come out spelled differently.
    static func normalize(_ path: String) -> String {
        var parts: [Substring] = []
        for part in path.split(separator: "/") {
            if part == "." { continue }
            if part == ".." { _ = parts.popLast(); continue }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }

    static func add(_ path: String) {
        let path = normalize(path)
        roots.removeAll { $0 == path }
        roots.insert(path, at: 0)
        if roots.count > limit { roots.removeLast(roots.count - limit) }
        save()
    }

    static func replace(_ old: String, with new: String) {
        let old = normalize(old)
        guard roots.contains(old) else { return }
        roots = roots.map { $0 == old ? normalize(new) : $0 }
        save()
    }

    static func allows(_ path: String) -> Bool {
        let path = normalize(path)
        return roots.contains { path == $0 || path.hasPrefix($0 == "/" ? "/" : $0 + "/") }
    }

    private static func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: roots) else { return }
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

/// One reply per request. Failures carry a DOMException name, which the
/// page rethrows as-is: the file manager tells a vanished file
/// (NotFoundError) from other failures by it.
enum FileOps {
    static let maxReadBytes = 256 * 1024 * 1024

    typealias Reply = [String: Any]

    static func failure(_ name: String, _ message: String) -> Reply {
        ["error": ["name": name, "message": message]]
    }

    private static func modified(_ path: String) -> Int {
        let date = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        return Int((date ?? Date()).timeIntervalSince1970 * 1000)
    }

    private static func granted(_ value: Any?) -> (String?, Reply?) {
        guard let raw = value as? String, raw.hasPrefix("/") else {
            return (nil, failure("TypeError", "path must be absolute"))
        }
        let path = Grants.normalize(raw)
        guard Grants.allows(path) else {
            return (nil, failure("NotAllowedError", "Plass was not given access to \((path as NSString).lastPathComponent)"))
        }
        return (path, nil)
    }

    private static func kind(_ path: String) -> String? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return nil }
        return isDirectory.boolValue ? "directory" : "file"
    }

    static func permission(_ body: [String: Any]) -> Reply {
        guard let raw = body["path"] as? String else { return ["granted": false] }
        return ["granted": Grants.allows(raw)]
    }

    static func stat(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        guard let kind = kind(path) else {
            return failure("NotFoundError", "\((path as NSString).lastPathComponent) was not found")
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int ?? 0
        return ["kind": kind, "size": size, "modified": modified(path)]
    }

    static func read(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        let name = (path as NSString).lastPathComponent
        guard kind(path) == "file" else { return failure("NotFoundError", "\(name) was not found") }
        guard let data = FileManager.default.contents(atPath: path) else {
            return failure("NotReadableError", "\(name) could not be read")
        }
        if data.count > maxReadBytes { return failure("NotReadableError", "\(name) is too large") }
        return ["data": data.base64EncodedString(), "size": data.count, "modified": modified(path)]
    }

    static func write(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        let name = (path as NSString).lastPathComponent
        guard let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) else {
            return failure("TypeError", "data must be base64")
        }
        if kind(path) == "directory" { return failure("TypeMismatchError", "\(name) is a folder") }
        guard kind((path as NSString).deletingLastPathComponent) == "directory" else {
            return failure("NotFoundError", "the folder holding \(name) was not found")
        }
        do {
            // .atomic stages beside the destination and renames into place.
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            return failure("NoModificationAllowedError", "\(name) could not be saved: \(error.localizedDescription)")
        }
        return ["size": data.count, "modified": modified(path)]
    }

    /// A folder's child by name (getFileHandle / getDirectoryHandle).
    static func child(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        let name = (path as NSString).lastPathComponent
        let wanted = body["kind"] as? String == "directory" ? "directory" : "file"
        if let existing = kind(path) {
            return existing == wanted ? ["path": path] : failure("TypeMismatchError", "\(name) is not a \(wanted)")
        }
        guard body["create"] as? Bool == true else { return failure("NotFoundError", "\(name) was not found") }
        do {
            if wanted == "directory" {
                try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
            } else if !FileManager.default.createFile(atPath: path, contents: Data()) {
                return failure("NoModificationAllowedError", "\(name) could not be created")
            }
        } catch {
            return failure("NoModificationAllowedError", "\(name) could not be created: \(error.localizedDescription)")
        }
        return ["path": path]
    }

    static func list(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        guard kind(path) == "directory",
              let names = try? FileManager.default.contentsOfDirectory(atPath: path)
        else { return failure("NotFoundError", "\((path as NSString).lastPathComponent) was not found") }
        let entries: [[String: String]] = names.sorted().compactMap { name in
            guard let k = kind((path as NSString).appendingPathComponent(name)) else { return nil }
            return ["name": name, "kind": k]
        }
        return ["entries": entries]
    }

    static func rename(_ body: [String: Any]) -> Reply {
        let (path, problem) = granted(body["path"])
        guard let path = path else { return problem! }
        let name = (body["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if name.isEmpty || name == "." || name == ".." || name.contains("/") {
            return failure("TypeError", "name must be a file name, not a path")
        }
        let target = ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(name)
        guard kind(path) != nil else { return failure("NotFoundError", "\((path as NSString).lastPathComponent) was not found") }
        if target != path && kind(target) != nil { return failure("InvalidModificationError", "\(name) already exists") }
        do {
            if target != path { try FileManager.default.moveItem(atPath: path, toPath: target) }
        } catch {
            return failure("NoModificationAllowedError", "could not rename: \(error.localizedDescription)")
        }
        Grants.replace(path, with: target)
        return ["path": target]
    }
}

// MARK: - A document window

final class DocumentWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandlerWithReply
{
    let window: NSWindow
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?
    private var selfTestStarted = false
    /// The file the page says this window shows (native-fs announceDocument).
    private(set) var documentPath: String?
    private static let fileQueue = DispatchQueue(label: "io.tayweid.plass.files")

    init(url: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        enableRequiredFeatures(configuration.preferences)
        // macOS predictive text would draw ghost words inside the lines the
        // page lays out, and a Tab could accept them into the document.
        if #available(macOS 14.0, *) { configuration.allowsInlinePredictions = false }
        if let webRoot = bundledWebRoot {
            configuration.setURLSchemeHandler(AppSchemeHandler(root: webRoot), forURLScheme: appScheme)
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        super.init()

        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "plass")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.delegate = self
        window.title = "Plass"
        window.setFrameAutosaveName("PlassDocument")
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 640, height: 420)
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self = self, let title = view.title, !title.isEmpty else { return }
            self.window.title = title
        }
        webView.load(URLRequest(url: url))
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: the page's file requests (src/native-fs.ts)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void)
    {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return replyHandler(FileOps.failure("TypeError", "malformed request"), nil)
        }
        let disk: ((([String: Any]) -> FileOps.Reply))? = {
            switch type {
            case "permission": return FileOps.permission
            case "stat": return FileOps.stat
            case "read": return FileOps.read
            case "write": return FileOps.write
            case "child": return FileOps.child
            case "list": return FileOps.list
            case "rename": return FileOps.rename
            default: return nil
            }
        }()
        if let operation = disk {
            // Disk work off the main thread, one request at a time, so a
            // write and the watcher's stat never interleave.
            DocumentWindow.fileQueue.async {
                let result = operation(body)
                DispatchQueue.main.async { replyHandler(result, nil) }
            }
            return
        }
        switch type {
        case "openPanel":
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = body["multiple"] as? Bool ?? false
            let extensions = body["extensions"] as? [String] ?? []
            let types = extensions.compactMap { UTType(filenameExtension: $0) }
            if !types.isEmpty { panel.allowedContentTypes = types }
            present(panel, startIn: body["startIn"]) { answer in
                guard answer == .OK else { return replyHandler(["cancelled": true], nil) }
                panel.urls.forEach { Grants.add($0.path) }
                replyHandler(["paths": panel.urls.map { $0.path }], nil)
            }
        case "savePanel":
            let panel = NSSavePanel()
            panel.nameFieldStringValue = body["suggestedName"] as? String ?? ""
            panel.canCreateDirectories = true
            present(panel, startIn: body["startIn"]) { answer in
                guard answer == .OK, let url = panel.url else { return replyHandler(["cancelled": true], nil) }
                Grants.add(url.path)
                replyHandler(["path": url.path], nil)
            }
        case "folderPanel":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Choose"
            present(panel, startIn: body["startIn"]) { answer in
                guard answer == .OK, let url = panel.url else { return replyHandler(["cancelled": true], nil) }
                Grants.add(url.path)
                replyHandler(["path": url.path], nil)
            }
        case "document":
            documentPath = (body["path"] as? String).map(Grants.normalize)
            window.representedURL = documentPath.map { URL(fileURLWithPath: $0) }
            replyHandler([:], nil)
        default:
            replyHandler(FileOps.failure("NotSupportedError", "unknown request \(type)"), nil)
        }
    }

    private func present(_ panel: NSSavePanel, startIn: Any?, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let path = startIn as? String { panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true) }
        panel.beginSheetModal(for: window, completionHandler: completion)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("load failed: \(error.localizedDescription)")
    }

    /// The page's process died (memory, a WebKit crash): say so, and bring
    /// the page back rather than leave a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("web content process ended for \(documentPath ?? "an untitled window"); reloading")
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("loaded \(webView.url?.absoluteString.prefix(120) ?? "?")")
        guard !selfTestStarted, let path = environment["PLASS_SELFTEST"] else { return }
        selfTestStarted = true
        runSelfTest(path)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void)
    {
        // <a download> (the page's save and export fallbacks) becomes a
        // native download, saved where the writer says.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Links out of the page go to the default browser; only our own
        // origin (or the dev server) renders here.
        if let url = navigationAction.request.url, let host = url.host,
           url.scheme?.hasPrefix("http") == true, !(host == "127.0.0.1" || host == "localhost") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void)
    {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { answer in
            guard answer == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // the panel already confirmed replacing it
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        log("download failed: \(error.localizedDescription)")
    }

    // MARK: page dialogs — without these WebKit answers them silently
    // (confirm() returns false, <input type=file> never opens).

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void)
    {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { answer in
            completionHandler(answer == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void)
    {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void)
    {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { answer in completionHandler(answer == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void)
    {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { answer in
            completionHandler(answer == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // window.open ("New document") becomes one of our windows.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView?
    {
        if let url = navigationAction.request.url {
            (NSApp.delegate as? AppDelegate)?.openWindow(url: url)
        }
        return nil
    }

    // MARK: self-test

    private func runSelfTest(_ path: String) {
        guard let body = try? String(contentsOfFile: path, encoding: .utf8) else {
            print(#"{"error":"cannot read PLASS_SELFTEST"}"#)
            exit(2)
        }
        let argsJSON = environment["PLASS_ARGS"] ?? "null"
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8), options: [.fragmentsAllowed])) ?? NSNull()
        webView.callAsyncJavaScript(
            body, arguments: ["args": args], in: nil, in: .page
        ) { result in
            var text: String
            var status: Int32 = 0
            switch result {
            case .success(let value):
                if let string = value as? String { text = string }
                else if JSONSerialization.isValidJSONObject(value),
                        let data = try? JSONSerialization.data(withJSONObject: value),
                        let string = String(data: data, encoding: .utf8) { text = string }
                else { text = String(describing: value) }
            case .failure(let error):
                text = #"{"error":\#(String(reflecting: "\(error)"))}"#
                status = 1
            }
            if let out = environment["PLASS_SELFTEST_OUT"] {
                try? text.write(toFile: out, atomically: true, encoding: .utf8)
            } else {
                print(text)
            }
            exit(status)
        }
    }

    func windowWillClose(_ notification: Notification) {
        // The content controller holds its handler strongly.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "plass", contentWorld: .page)
        (NSApp.delegate as? AppDelegate)?.forget(self)
    }
}

// MARK: - The application

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [DocumentWindow] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let grant = environment["PLASS_GRANT"], grant.hasPrefix("/") { Grants.add(grant) }
        if environment["PLASS_URL"] == nil,
           bundledWebRoot.map({ FileManager.default.fileExists(atPath: $0.appendingPathComponent("index.html").path) }) != true {
            let alert = NSAlert()
            alert.messageText = "This build of Plass.app does not carry the page"
            alert.informativeText = "app/build.sh copies the vite build into the bundle."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        // Files arriving at launch (a Finder double-click) land just before
        // or after this; open the empty window only if none did.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
            if windows.isEmpty { openWindow(url: startURL()) }
        }
    }

    private func open(_ path: String) {
        if let showing = windows.first(where: { $0.documentPath == path }) {
            showing.window.makeKeyAndOrderFront(nil)
        } else {
            openWindow(url: startURL(open: path))
        }
    }

    /// Finder opens (double-click, Open With, a drop on the Dock icon). A
    /// file already showing in a window just comes forward; any other gets
    /// a window of its own. Opening a file grants Plass access to it.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL {
            let path = Grants.normalize(url.path)
            Grants.add(path)
            open(path)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openWindow(url: startURL()) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func startURL(open path: String? = nil) -> URL {
        let base = environment["PLASS_URL"].flatMap(URL.init(string:)) ?? URL(string: "\(appOrigin)/")!
        guard let path = path, var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        components.queryItems = (components.queryItems ?? []).filter { $0.name != "new" } + [URLQueryItem(name: "open", value: path)]
        return components.url ?? base
    }

    func openWindow(url: URL) {
        let controller = DocumentWindow(url: url)
        if let last = windows.last?.window {
            controller.window.cascadeTopLeft(from: NSPoint(x: last.frame.minX, y: last.frame.maxY))
        }
        windows.append(controller)
    }

    func forget(_ controller: DocumentWindow) {
        windows.removeAll { $0 === controller }
    }

    @objc func newWindow(_ sender: Any?) {
        openWindow(url: startURL())
    }

    @objc func showLog(_ sender: Any?) {
        NSWorkspace.shared.open(logURL)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Plass", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Show Log", action: #selector(showLog(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Plass", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Plass", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // ⌘N and ⌘O belong to the page (its own shortcuts); the menu offers
        // only what the page cannot do itself.
        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        // Without an Edit menu, ⌘C/⌘V/⌘Z never reach the web view.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
