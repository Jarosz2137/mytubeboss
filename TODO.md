# Egzey MyTube Boss — TODO

Kolejność dowolna, zapisane po sesji 26.11.2026.

## 1. Offline
- Przycisk „Pobierz” przy utworze, albumie i playliście.
- Zapis do pamięci telefonu: SABR i tak ściąga cały plik (`sabrAudioChunks`), wystarczy go zapisać (Capacitor Filesystem / IndexedDB).
- Zakładka „Pobrane” w Bibliotece; przy odtwarzaniu najpierw sprawdzać lokalny plik.

## 2. Więcej designu w samej apce (nie w playerze)
- Główna, Szukaj, Biblioteka i strony albumu/wykonawcy dostają ten sam klimat co player: synthwave, kolory z okładek, więcej animacji.
- Lepsze kafelki, nagłówki sekcji, puste stany, ekrany ładowania (szkielety zamiast kropek).

## 3. Teksty piosenek
- `yt.music.getLyrics(videoId)` już jest w bibliotece.
- Przycisk w playerze, panel z tekstem; jeśli YouTube da wersję zsynchronizowaną — podświetlanie linijek w rytm.

## 4. Łatwe dodawanie moich piosenek
- „Dodaj do playlisty” (wybór z moich playlist) z każdego utworu: przytrzymanie / menu „…”.
- Tworzenie nowej playlisty z poziomu apki.
- Szybkie „♥” na liście utworów (polubienie już działa w playerze).

## 5. Normalniejsze logowanie
- Zamiast wklejania cookies: okienko z logowaniem Google w apce (WebView), które samo przechwytuje cookies i je odświeża.

## 6. Aktualizacje „w locie” zamiast przebudowywania — ZROBIONE (wymaga jednorazowej konfiguracji, README)
- Apka sama pobiera nową wersję interfejsu i logiki (paczka web) i podmienia ją po restarcie — bez GitHub Actions → iloader → Importuj IPA.
- Opcje: `@capgo/capacitor-updater` w trybie ręcznym (paczki zip z GitHub Releases, za darmo, bez serwera) albo własny mini-updater.
- GitHub Actions przy każdym pushu buduje `dist.zip` + plik z numerem wersji; apka przy starcie sprawdza i ściąga.
- Nadal wymaga przebudowy tylko zmiana natywna (nowa wtyczka, uprawnienia, ikona). Odświeżanie podpisu co 7 dni zostaje.

## 7. Puls okładki do beatu
- Jest wersja beta (przycisk BEAT w playerze, analiza basu przez Web Audio). Sprawdzić na telefonie, czy nie psuje grania w tle.

## Znane / odłożone
- Przeciąganie odtwarzacza w górę z mini-paska nie działa na telefonie (w emulatorze działa). Stuknięcie otwiera — na razie zostaje.
- Podpis darmowym Apple ID: co 7 dni Mac → iloader → Importuj IPA. SideStore nie loguje się (błąd 401) — do sprawdzenia nowszej wersji.
