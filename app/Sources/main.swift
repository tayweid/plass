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

import AppKit
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
        let file = root.appendingPathComponent(String(relative.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"),
              let data = FileManager.default.contents(atPath: file.path)
        else {
            log("not in bundle: \(relative)")
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }
        let type = AppSchemeHandler.contentTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
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

// MARK: - A document window

final class DocumentWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate
{
    let window: NSWindow
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?
    private var selfTestStarted = false

    init(url: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        enableRequiredFeatures(configuration.preferences)
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

    // MARK: navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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
            switch result {
            case .success(let value):
                if let text = value as? String { print(text) }
                else if JSONSerialization.isValidJSONObject(value),
                        let data = try? JSONSerialization.data(withJSONObject: value),
                        let text = String(data: data, encoding: .utf8) { print(text) }
                else { print(String(describing: value)) }
                exit(0)
            case .failure(let error):
                print(#"{"error":\#(String(reflecting: "\(error)"))}"#)
                exit(1)
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
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
        openWindow(url: startURL())
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openWindow(url: startURL()) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func startURL() -> URL {
        if let override = environment["PLASS_URL"], let url = URL(string: override) { return url }
        return URL(string: "\(appOrigin)/")!
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
