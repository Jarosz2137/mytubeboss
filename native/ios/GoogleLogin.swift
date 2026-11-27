// ---- MyTube Boss: in-app Google login (appended to AppDelegate.swift by scripts/patch-ios.sh) ----
// Opens Google's normal sign-in page in a fresh, private web view. When it lands back on
// music.youtube.com, we read the YouTube session cookies from that web view and hand them
// to the JS side. Nothing leaves the phone; the private web view is thrown away afterwards.
import WebKit
import Capacitor

class MTBBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
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
