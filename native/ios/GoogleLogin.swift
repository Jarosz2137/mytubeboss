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
        web = WKWebView(frame: view.bounds, configuration: cfg)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Google refuses sign-in inside "embedded" browsers; present as regular mobile Safari.
        web.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        web.navigationDelegate = self
        view.addSubview(web)
        let url = URL(string: "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F")!
        web.load(URLRequest(url: url))
        // Backup check: some redirects finish client-side without a didFinish.
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.check() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { check() }

    private func check() {
        guard !finished, let host = web.url?.host, host.hasSuffix("youtube.com") else { return }
        web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            let yt = cookies.filter { $0.domain.hasSuffix("youtube.com") }
            guard !self.finished, yt.contains(where: { $0.name == "SAPISID" }) else { return }
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
