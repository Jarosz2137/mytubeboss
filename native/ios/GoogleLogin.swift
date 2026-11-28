// ---- MyTube Boss: in-app Google login (appended to AppDelegate.swift by scripts/patch-ios.sh) ----
// Opens Google's normal sign-in page in a fresh, private web view. When it lands back on
// music.youtube.com, we read the YouTube session cookies from that web view and hand them
// to the JS side. Nothing leaves the phone; the private web view is thrown away afterwards.
import WebKit
import Capacitor

class MTBBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        if bridge?.plugin(withName: "MTBEnergy") == nil { bridge?.registerPluginInstance(MTBEnergyPlugin()) }
        // Backup registration; the main one is GoogleLoginPlugin in packageClassList (patched in CI).
        if bridge?.plugin(withName: "GoogleLogin") == nil { bridge?.registerPluginInstance(GoogleLoginPlugin()) }
    }
}

@objc(GoogleLoginPlugin)
public class GoogleLoginPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GoogleLoginPlugin"
    public let jsName = "GoogleLogin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
    ]
    private var screen: GoogleLoginViewController?

    override public func load() {
        // Music video -> Picture-in-Picture automatically when the app is minimised.
        // JS run from native counts as a user gesture in WKWebView, so the page may start PiP.
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.bridge?.webView?.evaluateJavaScript("window.__mtbAutoPip && window.__mtbAutoPip()", completionHandler: nil)
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let vc = GoogleLoginViewController { cookie, error in
                if let cookie = cookie { call.resolve(["cookie": cookie]) }
                else { call.reject(error ?? "cancelled") }
                self.screen = nil
            }
            self.screen = vc
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .pageSheet
            self.bridge?.viewController?.present(nav, animated: true)
        }
    }
}

class GoogleLoginViewController: UIViewController, WKNavigationDelegate {
    private let done: (String?, String?) -> Void
    private var web: WKWebView!
    private var finished = false
    private var timer: Timer?

    init(done: @escaping (String?, String?) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Zaloguj przez Google"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent() // fresh every time -> easy account switching
        cfg.mediaTypesRequiringUserActionForPlayback = .all // nothing (no video, no ad) plays by itself
        web = WKWebView(frame: view.bounds, configuration: cfg)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Google refuses sign-in inside "embedded" browsers; present as regular mobile Safari.
        web.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        web.navigationDelegate = self
        view.addSubview(web)
        // Cover shown once Google sign-in is done, so YouTube's own site never appears.
        cover.frame = view.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.05, alpha: 1)
        cover.isHidden = true
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        spinner.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.text = "Łączę z YouTube…"
        label.textColor = .white
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(spinner); cover.addSubview(label)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: cover.centerYAnchor, constant: -16),
            label.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
        ])
        view.addSubview(cover)
        let url = URL(string: "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F")!
        // Skip the EU cookie-consent page (it never finished loading here and blocked the redirect).
        setConsentCookies { self.web.load(URLRequest(url: url)) }
        // Backup check: some redirects finish client-side without a didFinish.
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.check() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { check() }

    private var sentToYouTube = false
    private let cover = UIView()
    private var handoffTries = 0
    // Google's passive sign-in for YouTube: copies the Google session to youtube.com (SetSID).
    private let youtubeHandoff = URL(string: "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&uilel=3&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F")!
    private var consentRetries = 0

    private func setConsentCookies(_ then: @escaping () -> Void) {
        let store = web.configuration.websiteDataStore.httpCookieStore
        let expires = Date().addingTimeInterval(60 * 60 * 24 * 365)
        var cookies: [HTTPCookie] = []
        for domain in [".youtube.com", ".google.com"] {
            for (name, value) in [("SOCS", "CAI"), ("CONSENT", "PENDING+987")] {
                if let c = HTTPCookie(properties: [.domain: domain, .path: "/", .name: name, .value: value, .secure: "TRUE", .expires: expires]) { cookies.append(c) }
            }
        }
        let group = DispatchGroup()
        for c in cookies { group.enter(); store.setCookie(c) { group.leave() } }
        group.notify(queue: .main, execute: then)
    }

    private func check() {
        guard !finished, let url = web.url, let host = url.host else { return }
        if host == "consent.youtube.com" || host == "consent.google.com" {
            // Consent page slipped through: set the cookie again and go straight to YouTube Music.
            guard consentRetries < 3 else { return }
            consentRetries += 1
            cover.isHidden = false
            setConsentCookies { self.web.load(URLRequest(url: self.youtubeHandoff)) }
            return
        }
        if !host.hasSuffix("youtube.com") {
            // Signed in, but Google parked us on one of its own pages (security checkup,
            // account page, …) instead of following `continue`: go to YouTube Music ourselves.
            let onSignInFlow = host == "accounts.google.com" && (url.path.contains("signin") || url.path.contains("ServiceLogin") || url.path.contains("challenge"))
            guard host.hasSuffix("google.com"), !onSignInFlow, !sentToYouTube else { return }
            web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                let signedIn = cookies.contains { $0.domain.hasSuffix("google.com") && ($0.name == "SAPISID" || $0.name == "SID") }
                guard signedIn, !self.sentToYouTube else { return }
                self.sentToYouTube = true
                self.cover.isHidden = false
                self.setConsentCookies { self.web.load(URLRequest(url: self.youtubeHandoff)) }
            }
            return
        }
        web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            let yt = cookies.filter { $0.domain.hasSuffix("youtube.com") }
            guard !self.finished else { return }
            if !yt.contains(where: { $0.name == "SAPISID" }) {
                // On YouTube but not signed in there yet: if Google is signed in, run the handoff.
                let googleIn = cookies.contains { $0.domain.hasSuffix("google.com") && ($0.name == "SAPISID" || $0.name == "SID") }
                if googleIn && self.handoffTries < 2 && !self.web.isLoading {
                    self.handoffTries += 1
                    self.cover.isHidden = false
                    self.web.load(URLRequest(url: self.youtubeHandoff))
                }
                return
            }
            self.finished = true
            // one value per name, preferring the shared ".youtube.com" domain
            var byName: [String: HTTPCookie] = [:]
            for c in yt { if byName[c.name] == nil || c.domain == ".youtube.com" { byName[c.name] = c } }
            let header = byName.values.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            self.close { self.done(header, nil) }
        }
    }

    @objc private func cancel() {
        guard !finished else { return }
        finished = true
        close { self.done(nil, "cancelled") }
    }

    private func close(_ then: @escaping () -> Void) {
        timer?.invalidate()
        DispatchQueue.main.async { self.navigationController?.dismiss(animated: true, completion: then) ?? then() }
    }
}

// ---- Generic in-app browser: all login logic lives in JS (ships via OTA), native only executes commands ----
@objc(MTBBrowserPlugin)
public class MTBBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MTBBrowserPlugin"
    public let jsName = "MTBBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]
    private var screen: MTBBrowserViewController?

    @objc func open(_ call: CAPPluginCall) {
        let urlString = call.getString("url") ?? ""
        let ua = call.getString("userAgent")
        let title = call.getString("title") ?? ""
        // JS to run at document start on every page (sent from JS, so it can change via OTA)
        let scripts = (call.getArray("scripts", String.self) ?? [])
        guard let url = URL(string: urlString) else { call.reject("bad url"); return }
        DispatchQueue.main.async {
            let vc = MTBBrowserViewController(start: url, userAgent: ua, scripts: scripts, onNav: { [weak self] u in
                self?.notifyListeners("nav", data: ["url": u])
            }, onClose: { [weak self] in
                self?.notifyListeners("closed", data: [:])
                self?.screen = nil
            })
            vc.title = title
            self.screen = vc
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .pageSheet
            self.bridge?.viewController?.present(nav, animated: true)
            call.resolve()
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let u = URL(string: call.getString("url") ?? "") else { call.reject("bad url"); return }
        DispatchQueue.main.async { self.screen?.web?.load(URLRequest(url: u)); call.resolve() }
    }

    @objc func getCookies(_ call: CAPPluginCall) {
        let suffix = call.getString("domain") ?? ""
        DispatchQueue.main.async {
            guard let store = self.screen?.web?.configuration.websiteDataStore.httpCookieStore else { call.resolve(["cookies": []]); return }
            store.getAllCookies { cookies in
                let list = cookies.filter { suffix.isEmpty || $0.domain.hasSuffix(suffix) }.map { ["name": $0.name, "value": $0.value, "domain": $0.domain] }
                call.resolve(["cookies": list, "url": self.screen?.web?.url?.absoluteString ?? ""])
            }
        }
    }

    @objc func setCookies(_ call: CAPPluginCall) {
        let items = call.getArray("cookies", JSObject.self) ?? []
        DispatchQueue.main.async {
            guard let store = self.screen?.web?.configuration.websiteDataStore.httpCookieStore else { call.resolve(); return }
            let group = DispatchGroup()
            let expires = Date().addingTimeInterval(60 * 60 * 24 * 365)
            for it in items {
                guard let d = it["domain"] as? String, let n = it["name"] as? String, let v = it["value"] as? String,
                      let c = HTTPCookie(properties: [.domain: d, .path: "/", .name: n, .value: v, .secure: "TRUE", .expires: expires]) else { continue }
                group.enter(); store.setCookie(c) { group.leave() }
            }
            group.notify(queue: .main) { call.resolve() }
        }
    }

    @objc func cover(_ call: CAPPluginCall) {
        let show = call.getBool("show") ?? true
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async { self.screen?.setCover(show, text: text); call.resolve() }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let vc = self.screen
            self.screen = nil
            vc?.closeQuietly { call.resolve() }
            if vc == nil { call.resolve() }
        }
    }
}

class MTBBrowserViewController: UIViewController, WKNavigationDelegate {
    private let start: URL
    private let userAgent: String?
    private let scripts: [String]
    private let onNav: (String) -> Void
    private let onClose: () -> Void
    var web: WKWebView?
    private let coverView = UIView()
    private let coverLabel = UILabel()
    private var quiet = false

    init(start: URL, userAgent: String?, scripts: [String], onNav: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        self.start = start; self.userAgent = userAgent; self.scripts = scripts; self.onNav = onNav; self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        for js in scripts {
            cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        let w = WKWebView(frame: view.bounds, configuration: cfg)
        w.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        w.customUserAgent = userAgent ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        w.navigationDelegate = self
        view.addSubview(w)
        web = w
        coverView.frame = view.bounds
        coverView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        coverView.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.05, alpha: 1)
        coverView.isHidden = true
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white; spinner.startAnimating()
        spinner.translatesAutoresizingMaskIntoConstraints = false
        coverLabel.textColor = .white
        coverLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        coverLabel.translatesAutoresizingMaskIntoConstraints = false
        coverView.addSubview(spinner); coverView.addSubview(coverLabel)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: coverView.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: coverView.centerYAnchor, constant: -16),
            coverLabel.centerXAnchor.constraint(equalTo: coverView.centerXAnchor),
            coverLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
        ])
        view.addSubview(coverView)
        w.load(URLRequest(url: start))
    }

    func setCover(_ show: Bool, text: String) { coverLabel.text = text; coverView.isHidden = !show }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { onNav(webView.url?.absoluteString ?? "") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onNav(webView.url?.absoluteString ?? "") }

    @objc private func cancel() { navigationController?.dismiss(animated: true) { self.onClose() } }
    func closeQuietly(_ then: @escaping () -> Void) {
        quiet = true
        if let nav = navigationController { nav.dismiss(animated: true, completion: then) } else { then() }
    }
}
