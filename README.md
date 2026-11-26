# Egzey MyTube Boss 🎧

Własny player YouTube Music bez reklam: okładki w wysokiej jakości, strony wykonawców, albumy, playlisty z twojego konta, przełącznik Utwór ↔ Teledysk, kolejka, automatyczne radio na końcu kolejki, lock screen / Dynamic Island.

Bez serwera i bez bazy. Telefon gada bezpośrednio z YouTube'em (youtubei.js). Tylko do użytku prywatnego.

## Test w przeglądarce (Windows, bez Maca)

```bash
npm install
npm run dev
```

Otwórz adres, który wypisze Vite. W trybie dev zapytania do YouTube'a lecą przez lokalne proxy w `vite.config.js`, żeby obejść CORS. Teledyski w Chrome lecą w 360p, bo Chrome nie umie HLS. Na iPhonie idzie HLS do 1080p.

## iPhone przez Maca (Xcode)

```bash
npm install
npm run ios:init     # build + dodaje projekt iOS + włącza audio w tle
npm run ios:open     # otwiera Xcode
```

W Xcode: App → Signing & Capabilities → wybierz swój Team (Apple ID), podepnij iPhone'a i kliknij ▶.
Po zmianach w kodzie: `npm run ios:sync` i znowu ▶.

## iPhone bez Maca (GitHub + SideStore)

1. Wrzuć repo na GitHuba (najlepiej prywatne).
2. Zakładka **Actions** → „Build iOS (unsigned IPA)” → **Run workflow**.
3. Po kilku minutach pobierz `MyTubeBoss-ipa` z Artifacts, rozpakuj i otwórz `.ipa` w SideStore na telefonie. SideStore sam to podpisze i będzie odświeżał co 7 dni.

## Logowanie

Biblioteka → „Zaloguj przez YouTube”. Apka pokazuje kod, który wpisujesz na `google.com/device`. Tokeny zostają tylko w telefonie.

## Jak coś przestanie grać

YouTube co jakiś czas zmienia swoje wewnętrzne API. Wtedy:

```bash
npm i youtubei.js@latest
```

i budujesz od nowa. W `src/yt.js` → `audioUrl()` jest lista klientów (`IOS`, `ANDROID_VR`, `TV`, `WEB`), które apka próbuje po kolei. Jak jeden padnie, możesz zmienić kolejność.

## Struktura

- `src/yt.js`: cała gadka z YouTube'em (sesja, logowanie, wyszukiwarka, albumy, streamy)
- `src/player.js`: silnik odtwarzania, kolejka, radio, Media Session (lock screen)
- `src/App.jsx`: UI
- `src/styles.css`: wygląd
- `scripts/patch-ios.sh`: włącza audio w tle w projekcie iOS
- `.github/workflows/ios.yml`: budowanie `.ipa` w chmurze

## Roadmapa (v2)

- pobieranie offline (utwory / albumy / playlisty)
- widget na ekran główny (WidgetKit)
- teksty piosenek (`yt.music.getLyrics` już jest w bibliotece)
