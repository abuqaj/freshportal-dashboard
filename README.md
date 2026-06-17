# FreshPortal Dashboard

Dashboard do zarządzania produktami w FreshPortal — weryfikacja VBN, tworzenie produktów, upload zdjęć, synchronizacja katalogu.

## Funkcje

- **VBN Checker** — przepływ kart: Szukaj → Wyniki → Poprawianie → Gotowe. Wpisz numer VBN, sprawdź poprawność kodów wszystkich produktów, edytuj i zatwierdź poprawki inline (streaming SSE). Pasek postępu z rzeczywistym procentem (0–100) na podstawie etapów pipeline. AI (Claude Haiku) sugeruje poprawny kod VBN — nie proponuje kodu identycznego z obecnym; "overig" traktowany jako poprawny gdy brak konkretnej alternatywy.
- **Auto VBN Check** — przełącznik w VBN Checker, automatycznie sprawdza kody VBN nowo dodanych produktów co godzinę (APScheduler na Railway). Błędne kody automatycznie poprawiane. Skeleton ładowania blokuje interakcję do czasu załadowania statusu; potwierdzenie przed wyłączeniem.
- **Nowe produkty** — wpisz nazwę, system znajdzie podobne w DB (fuzzy search ≥80%). AI wykrywa duplikaty i sugeruje VBN. Podgląd różnicy nazwy (algorytm LCS) w bursztynowym boxie. Numer produktu weryfikowany przed kliknięciem "Utwórz". Kolor pre-selectowany z szablonu. Historia operacji zapisywana zawsze — także dla nieudanych prób (badge "failed").
- **Photo Uploader** — wrzuć zdjęcia, system dopasuje je do produktów (AND-ILIKE matching), przypisz jedno zdjęcie do wielu produktów (chipy + alternatywy). Matches ≥99% auto-selectowane.
- **Synchronizacja** — pełna synchronizacja katalogu (~44 tys. produktów) do Postgres. Split na dwie sesje Playwright po 130 stron, unika limitu sesji FreshPortal. Inkrementalna synchronizacja tylko zmienionych produktów.
- **TopBar** — live status: liczba produktów w DB, wskaźnik czy Railway jest online (zielona/szara kropka), spinner synchronizacji.
- **Historia** — logi operacji VBN fix, tworzenia produktów, photo upload, synchronizacji i Auto VBN z rozwijalnymi szczegółami. Paginacja (10 wpisów + "Załaduj więcej").
- **Wielojęzyczność** — UI i komunikaty backendu (w tym status fix VBN) w 4 językach: EN / NL / PL / ES.

## Architektura

```
Vercel (Next.js)          Railway (FastAPI + Playwright)       Neon (Postgres)
─────────────────         ──────────────────────────────       ───────────────
components  ──SSE────────▶  /vbn-check/stream                 products
            ──SSE────────▶  /vbn-fix/stream                   sync_log
            ──SSE────────▶  /product-search/stream            history
            ──SSE────────▶  /product-create/stream            settings
            ──SSE────────▶  /photo-upload/analyze/stream      vbn_auto_log
            ──POST───────▶  /photo-upload/execute
            ──POST───────▶  /product-ai-analyze
            ──GET────────▶  /vbn-name/:code
            ──GET────────▶  /vbn-search?q=...
            ──GET────────▶  /floricode/colors
            ──POST───────▶  /sync/run
            ──GET────────▶  /sync/status
            ──GET────────▶  /sync/history
            ──GET────────▶  /vbn-auto/status
            ──POST───────▶  /vbn-auto/toggle
            ──GET────────▶  /vbn-auto/history

/api/history  ◀──────────▶  Vercel Postgres (historia operacji)
```

Przeglądarka łączy się **bezpośrednio z Railway** (`NEXT_PUBLIC_RAILWAY_API_URL`). Vercel pośredniczy tylko przy zapisie/odczycie historii operacji.

## Struktura projektu

```
src/
  app/
    page.tsx                      — thin shell: nawigacja, language switcher, routing zakładek
    api/
      history/route.ts            — zapis i odczyt historii z Vercel Postgres
  components/
    VbnChecker.tsx                — VBN Checker: sprawdzanie, naprawa inline, Auto VBN toggle
    ProductCreator.tsx            — Nowe produkty: search, AI analiza, formularz, synchronizacja
    PhotoUploader.tsx             — Photo Uploader: drop zone, review, upload do FreshPortal
    HistoryTab.tsx                — Historia: podzakładki Operacje / Sync runs / Auto VBN + paginacja
    LanguageSwitcher.tsx          — przełącznik języka (EN/NL/PL/ES)
  lib/
    types.ts                      — wspólne typy TypeScript (VbnResult, HistoryRow, SyncRun, …)
    i18n.ts                       — tłumaczenia UI we wszystkich 4 językach
    db.ts                         — klient Vercel Postgres (getHistory, logOperation)

python/
  api_server.py                   — FastAPI: wszystkie endpointy HTTP + SSE + APScheduler (Auto VBN)
  scraper_fp.py                   — Playwright: logowanie FreshPortal, pobieranie/edycja produktów
  scraper_vbn.py                  — Floricode API: weryfikacja VBN, wyszukiwanie, lista kolorów
  verifier.py                     — reguły weryfikacji VBN + AI sugestie przez ai_helper
  product_creator.py              — fuzzy search produktów + kopiowanie szablonu w FreshPortal
  ai_helper.py                    — Claude AI: analiza duplikatów, sugestie VBN, sprawdzanie VBN
  photo_matcher.py                — dopasowywanie zdjęć do produktów (AND-ILIKE na DB)
  photo_uploader.py               — upload zdjęć do FreshPortal przez Playwright
  sync.py                         — pełna i inkrementalna synchronizacja katalogu
  db.py                           — Postgres: upsert produktów, search, sync log, historia, settings
  i18n.py                         — tłumaczenia komunikatów backendowych (EN/NL/PL/ES)
  config.py                       — konfiguracja z env vars
  requirements.txt
```

## Lokalne uruchomienie

```bash
# 1. Zależności Node (frontend)
npm install

# 2. Zależności Python (backend)
pip install -r python/requirements.txt
playwright install chromium

# 3. Zmienne środowiskowe
cp .env.example .env.local
# Uzupełnij wartości w .env.local

# 4. Backend (Railway API lokalnie)
cd python
python api_server.py
# Nasłuchuje na http://localhost:8000

# 5. Frontend (w osobnym terminalu)
npm run dev
# Otwórz http://localhost:3000
```

Ustaw `NEXT_PUBLIC_RAILWAY_API_URL=http://localhost:8000` w `.env.local`.

## Zmienne środowiskowe

| Zmienna | Gdzie | Opis |
|---------|-------|------|
| `FRESHPORTAL_URL` | Railway | URL instancji FreshPortal, np. `https://fp042100.freshportal.nl` |
| `FRESHPORTAL_USERNAME` | Railway | Login FreshPortal |
| `FRESHPORTAL_PASSWORD` | Railway | Hasło FreshPortal |
| `FLORICODE_USERNAME` | Railway | Client ID Floricode (OAuth2 client credentials) |
| `FLORICODE_PASSWORD` | Railway | Client Secret Floricode |
| `ANTHROPIC_API_KEY` | Railway | Claude AI — sugestie VBN, wykrywanie duplikatów, pisownia |
| `POSTGRES_URL` | Railway + Vercel | Connection string Neon Postgres (wspólna DB) |
| `NEXT_PUBLIC_RAILWAY_API_URL` | Vercel | Publiczny URL Railway API |

> **Uwaga dot. Floricode**: endpoint `/FLC/Color` (lista kolorów) wymaga osobnego poziomu dostępu API. Jeśli jest niedostępny (401), system automatycznie wraca do listy kolorów z tabeli `products` w DB.

## Deploy

### Railway (backend Python)

1. Utwórz nowy projekt na [railway.app](https://railway.app)
2. Połącz repo `abuqaj/freshportal-dashboard`
3. Railway wykryje `Dockerfile` automatycznie (`railway.toml` ustawia builder na Dockerfile)
4. Dodaj zmienne środowiskowe
5. Deploy — serwis będzie dostępny pod wygenerowanym URL Railway

### Vercel (frontend Next.js)

1. Importuj repo na [vercel.com/new](https://vercel.com/new)
2. Dodaj zmienne środowiskowe: `NEXT_PUBLIC_RAILWAY_API_URL`, `POSTGRES_URL`
3. Deploy

## Endpointy Railway API

| Endpoint | Metoda | Opis |
|----------|--------|------|
| `/health` | GET | Healthcheck |
| `/vbn-check/stream` | POST | SSE: sprawdzenie VBN (`{ vbn: "595" }`) |
| `/vbn-fix/stream` | POST | SSE: naprawa VBN (`{ fixes: [{product_id, new_vbn}] }`) |
| `/vbn-name/:code` | GET | Oficjalna nazwa kodu VBN z Floricode |
| `/vbn-search` | GET | Wyszukiwanie kodów VBN po nazwie (`?q=rosa tros&limit=15`) |
| `/product-search/stream` | POST | SSE: wyszukiwanie podobnych produktów w DB (`{ name, lang }`) |
| `/product-number-suggest` | GET | Sprawdź dostępność numeru i zwróć wolny wariant (`?number=ROECAT&name=...`) |
| `/product-create/stream` | POST | SSE: kopiowanie produktu jako szablon (`{ template_id, new_name, product_number, lang, vbn_code, color_id }`) |
| `/product-ai-analyze` | POST | Analiza duplikatów i sugestia VBN przez Claude AI (`{ name, candidates, preferred_vbn }`) |
| `/photo-upload/analyze/stream` | POST | SSE: dopasowanie zdjęć do produktów w DB |
| `/photo-upload/execute` | POST | Upload zdjęć do FreshPortal (potwierdzone przypisania) |
| `/floricode/colors` | GET | Lista kolorów z Floricode API (fallback: DB) |
| `/floricode/colors/refresh` | GET | Wyczyść cache i ponów pobieranie kolorów |
| `/sync/run` | POST | Uruchom pełną synchronizację katalogu |
| `/sync/status` | GET | Status bieżącej synchronizacji |
| `/sync/history` | GET | Historia ostatnich synchronizacji z logami |
| `/vbn-auto/status` | GET | Status Auto VBN (enabled, lastRun, nextRun) |
| `/vbn-auto/toggle` | POST | Włącz/wyłącz Auto VBN (`{ enabled: bool }`) |
| `/vbn-auto/history` | GET | Historia uruchomień Auto VBN (`?limit&offset`) |
| `/debug/fp` | GET | Diagnostyka połączenia z FreshPortal |
| `/debug/colour-table` | GET | Podgląd tabeli kolorów VBN z Floricode |

## VBN Checker — jak działa AI

Weryfikacja każdego produktu przebiega przez reguły deterministyczne, a AI (`ai_suggest_vbn_for_checker`) wywoływane jest dla przypadków wymagających sugestii:

1. **Brak VBN** — AI sugeruje właściwy kod na podstawie nazwy produktu
2. **VBN nie znaleziony w Floricode** — AI sugeruje zastępczy kod
3. **Preserved/Bleached/Dried** — reguła determinuje VBN 2712 lub bardziej szczegółowy
4. **Colour treated** — wyszukiwanie Floricode + AI fallback dla kleurbehandeld VBN
5. **Spray/Non-spray mismatch** — AI weryfikuje i sugeruje właściwy typ
6. **Ambiguity** — AI porównuje holenderskie tłumaczenie nazwy z oficjalną nazwą VBN

Reguły ochronne:
- AI musi zwrócić konkretny `proposed_vbn` żeby oznaczenie ERROR było aktywne (zasada "overig") — brak lepszego kodu = produktd traktowany jako poprawny
- Proponowany VBN nigdy nie jest identyczny z obecnym (guard w `verifier.py`)

AI używa kontekstu `_VBN_CONTEXT`: tłumaczenie EN→NL (Spray→Tros, Large-flowered→Grootbloemig), kody kategorii (580, 595, 2712, 15126, 16128), reguły origin prefix (Ec/Col/Ke = kraj, nie część nazwy odmiany).

## Pasek postępu VBN Check

Pipeline `/vbn-check/stream` emituje `{ type: "status", message, progress }` gdzie `progress` (0–100) odzwierciedla rzeczywisty etap:

| Etap | Progress |
|------|----------|
| Logowanie / inicjalizacja | 5% |
| Wynik z DB (cache hit) | 15% |
| Pobieranie VBN (i/N produktów) | 10–72% |
| Weryfikacja w Floricode | 75% |
| Analiza reguł + AI | 88% |
| Pobieranie nazw proponowanych kodów | 93% |

## Tworzenie nowego produktu — flow

1. Wpisz nazwę (np. `Rosa Ec Athena`) → **Szukaj podobnych**
2. Backend przeszukuje lokalną DB (AND-ILIKE, typo-resistant), wyniki ≥80% jako szablony
3. AI (`/product-ai-analyze`) sprawdza duplikaty i sugeruje VBN — działa równolegle
4. Kliknij **Kopiuj jako szablon** — kolor z szablonu pre-selectowany automatycznie; w tle: sprawdzenie numeru produktu (`/product-number-suggest`)
5. Potwierdź dane (nazwa, numer, VBN, kolor, język) → **Utwórz produkt**
6. Backend otwiera formularz kopiowania w FreshPortal, wypełnia pola przez Shadow DOM (Angular `fps-input`/`fps-select`), zapisuje i weryfikuje wynik

## Synchronizacja katalogu

Pełna synchronizacja (~44 tys. produktów) podzielona na 2 sesje Playwright (1–130 i 131–koniec), każda z osobnym logowaniem, aby ominąć limit stron per-sesja FreshPortal. Każda synchronizacja zapisuje pełny log statusów do tabeli `sync_log.messages` (JSONB) dostępny w zakładce Historia.

Inkrementalna synchronizacja (`/sync/run` po pierwszej pełnej) pobiera tylko produkty zmienione od ostatniego udanego synca.

## Dopasowywanie zdjęć do produktów

`photo_matcher.py` używa jednego zapytania AND-ILIKE na nazwę pliku (zamiast 10–15 zapytań n-gram), co daje ~10–15× przyspieszenie. Wyniki scorowane przez `_similarity()` z `product_creator.py`. Matches ≥99% auto-selectowane jako chipy; kolejne 2 proponowane jako alternatywy. Jedno zdjęcie można przypisać do wielu produktów jednocześnie.
