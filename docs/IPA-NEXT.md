# Plan na następny IPA (przy odnowieniu podpisu, ok. 4.12.2026)

Cel: jeden IPA, w którym są wszystkie potrzebne zmiany natywne, a cała logika steruje nimi z części
webowej, żeby dalsze poprawki szły przez OTA.

## 1. Natywny odtwarzacz teledysków + automatyczne okienko (główny punkt)

**Problem:** w WKWebView iOS nie pozwala włączyć PiP przy wyjściu z apki z wideo w oknie (brak gestu
użytkownika; `autopictureinpicture` działa tylko z pełnego ekranu). YouTube używa natywnego
odtwarzacza z `canStartPictureInPictureAutomaticallyFromInline = true`.

**Rozwiązanie:** wtyczka `MTBVideo` (Swift) = AVPlayer + AVPlayerLayer w UIView położonym NAD
webview, w miejscu ramki wideo z HTML, + AVPictureInPictureController z automatycznym startem.

Polecenia z JS:
- `load({ url, startAt })` — URL HLS (już go mamy: `hlsUrl(id)` / teledysk-odpowiednik)
- `setFrame({ x, y, w, h, radius, visible })` — JS mierzy `.np-video` / `.vpop` (getBoundingClientRect)
  i wysyła przy zmianie układu, przewijaniu, obrocie
- `play()`, `pause()`, `seek({ time })`, `stop()`
- `startPip()` (ręczny przycisk), `fullscreen()`

Zdarzenia do JS:
- `time` { current, duration } co ~250 ms → suwak w playerze
- `state` { playing, buffering, ended, error }
- `pip` { active }

Ekran blokady: przy natywnym wideo `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` ustawiane natywnie
(tytuł/artysta/okładka przekazywane z JS w `load`), bo Media Session z WebKit tu nie obejmuje AVPlayera.

Zmiany w JS (przez OTA, po instalacji IPA):
- `player.js`: tryb „Teledysk” → jeśli `MTBVideo` dostępny, gra natywnie; `<video>` tylko jako zapas
- przełączanie Utwór ↔ Teledysk od tej samej sekundy (jak teraz)
- wyjście z trybu teledysku → `stop()`, wraca `<audio>`

Ryzyka / do sprawdzenia:
- nakładanie warstwy na webview przy przewijaniu i zwijaniu playera (animacja) — w razie problemów
  wideo tylko w pełnym playerze + okienko, bez pływania w środku apki
- część teledysków ma tylko SABR, bez HLS → wtedy zostaje obecny `<video>` (bez auto-PiP)

## 2. Drobne natywne rzeczy, skoro i tak jest IPA

- **Usunięcie starego `GoogleLoginPlugin`** (zastąpiony przez `MTBBrowser`, logika w JS) — mniej kodu.
- **`MTBBrowser.eval({ js })`** — uruchomienie skryptu na bieżącej stronie w okienku logowania
  (na wypadek kolejnych ekranów Google do obejścia, bez nowego IPA).
- **Haptyka/ikona:** nic do zmiany.
- **Wersja natywna w JS** (`MTBApp.info()` → numer buildu IPA), żeby w Bibliotece było widać, który IPA
  jest wgrany, a nie tylko wersję OTA.

## 3. Test po instalacji (lista dla Michała)

1. Logowanie Google działa jak teraz.
2. Teledysk w playerze gra; zwinięcie playera → okienko; wyjście z apki **bez zwijania** → okienko
   samo wyskakuje (to jest cel).
3. Ekran blokady przy teledysku: tytuł, okładka, pauza/następny.
4. Powrót z teledysku do trybu Utwór gra od tej samej sekundy.

## 4. Kolejność prac

1. Wtyczka `MTBVideo` + rejestracja w `packageClassList` (`scripts/patch-ios-after-sync.sh`).
2. Integracja w `player.js` / `App.jsx` za flagą „jest natywny odtwarzacz” (stare IPA dalej działają).
3. Build w Actions, sprawdzenie, że się kompiluje; OTA z integracją może wyjść wcześniej (bez IPA
   po prostu jej nie użyje).
4. Michał wgrywa IPA przy odnowieniu podpisu.
