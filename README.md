# FreshFromSource Dashboard

Dashboard do zarządzania produktami w FreshPortal — weryfikacja VBN, tworzenie produktów, upload zdjęć, import dostaw Ecuador (DFG API), analiza sprzedaży webshopu.

## Funkcje

- **VBN Checker** — wpisz filtr VBN, sprawdź poprawność kodów, edytuj inline. Streaming SSE z paskiem postępu (0–100%). AI (Claude) sugeruje poprawny kod. Anulowanie w dowolnym momencie — zatrzymuje też połączenie z Anthropic API (brak dalszych kosztów tokenów).
- **Auto VBN Check** — przełącznik w VBN Checker, automatycznie sprawdza kody VBN nowo dodanych produktów (dziś i wczoraj) raz dziennie (APScheduler na Railway, harmonogram trwały w DB — przetrwa redeploy bez resetowania cyklu). Błędne kody automatycznie poprawiane.
- **Nowe produkty** — wpisz nazwę, system znajdzie podobne w DB (fuzzy search ≥80%). AI wykrywa duplikaty i sugeruje VBN. Podgląd różnicy nazwy (LCS). Numer produktu weryfikowany przed kliknięciem "Utwórz". Kolor pre-selectowany z szablonu.
- **Photo Uploader** — wrzuć zdjęcia, system dopasuje je do produktów (AND-ILIKE), przypisz jedno zdjęcie do wielu produktów (chipy + alternatywy). Matches ≥99% auto-selectowane. Anulowanie podczas analizy i uploadu.
- **Import dostawy (Ecuador)** — wgraj JSON/TXT dostawy (kilka formatów supplierów, w tym `.txt` z tą samą treścią). System parsuje faktury, dopasowuje produkty do lokalnej bazy `ecuador_products`, rozwiązuje growera/manufacturer_id (w tym sieć Pomarosa/Tessa po lokalizacji fizycznej boxa), pozwala ręcznie korygować dopasowania (wyszukiwarka produktów), edytować box weight inline z nawigacją strzałkami. Tworzy przesyłkę bezpośrednio przez **DFG BatchV1 REST API** (nie przez scraping) — sprawdza czy już istnieje, tworzy batch + stock entries, umożliwia retry pojedynczych linii. 4-etapowy wizard: Upload → Shipment (dostawca + klient) → Preview (dopasowania, edycja) → Done (log, linki do FreshPortal). Guided tour dla nowych użytkowników. Klient do faktury wybierany z nowoczesnego searchable-comboboxa, zasilanego z zarządzanej w Adminie listy klientów.
- **Analysis Tool (BI Sync)** — mirror danych webshopu FreshPortal (stock_entry / order_lines / invoice) do lokalnego Postgresa, do analiz sprzedaży/oferty online. Codzienny automatyczny sync (harmonogram trwały w DB, jak Auto VBN) + ręczny trigger do backfillu. Pierwsze wykresy (stock entries / order lines dziennie). Wciąż w budowie — czeka na pola `webshop_visible`/`available_from`/`available_until` od FreshPortal do pełnej analizy dostępności online.
- **Historia** — logi wszystkich operacji (VBN check, VBN fix, product create, photo upload, sync, Auto VBN, delivery import — z pełnym logiem request/response i statusem każdej linii) z nazwą użytkownika, rozwijalnymi szczegółami i paginacją.
- **Zarządzanie użytkownikami** — panel admina: konta i grupy uprawnień (RBAC), oraz zakładka **Customers** — lista klientów FreshPortal (DFG) z checkboxami "Used in delivery import" (+ zbiorcze zaznacz/odznacz wszystko), kontrolująca co widać w comboboxie klienta przy imporcie dostaw.
- **Multi-system** — admin wybiera system po zalogowaniu (stamgegevens / ecuador). Każdy system pokazuje tylko swoje moduły.
- **Wielojęzyczność** — UI i komunikaty backendu w 4 językach: EN / NL / PL / ES.
- **Nawigacja boczna** — po wejściu w moduł, po lewej stronie karty widoczne są kafelki pozostałych modułów (w kolorach huba) umożliwiające bezpośrednie przełączanie bez powrotu do huba.

## Systemy

| System | Dostępne moduły |
|--------|----------------|
| `stamgegevens` | VBN Checker, Nowe produkty, Photo Uploader, Historia, Admin |
| `ecuador` | Import dostawy, Analysis Tool, Historia, Admin |

Admin po zalogowaniu wybiera system. Użytkownicy bez uprawnienia `admin:manage` trafiają bezpośrednio do modułów (bez wyboru systemu).

## Formaty JSON dostawy

| Format | Wykrywanie | Źródło |
|--------|-----------|--------|
| 1/2 | klucz `"invoices"` | Elite / Ecoroses / Alissroses — `invoices[]/boxes[]/products[]`, pola angielskie |
| 3 | klucz `"id_factura"` lub `"detalles"` | Bloomingacres / FreshFromSource — pojedynczy obiekt faktury, pola hiszpańskie, `detalles[]/productos[]` |
| 4 (fallback) | klucz `"detalle"` (bez `invoices`/`id_factura`) | Format per-etiqueta — jeden wiersz na fizyczny box |

Akceptowane rozszerzenia pliku: `.json` i `.txt` (ten sam format, tylko inne rozszerzenie u niektórych dostawców). Mapowania: QB → QBE (typ skrzynki). Ceny w USD.

## Architektura

```
Vercel (Next.js)          Railway (FastAPI + Playwright)       Neon (Postgres)
─────────────────         ──────────────────────────────       ───────────────
components  ──SSE────────▶  /vbn-check/stream                 products
            ──SSE────────▶  /vbn-fix/stream                   ecuador_products
            ──SSE────────▶  /product-search/stream            fp_suppliers
            ──SSE────────▶  /product-create/stream            dfg_customers
            ──SSE────────▶  /photo-upload/analyze/stream      delivery_import_log
            ──SSE────────▶  /photo-upload/execute/stream      bi_stock_entry_dim/daily
            ──POST───────▶  /product-ai-analyze               bi_order_lines
            ──POST───────▶  /delivery/parse                   bi_invoice_customer
            ──POST───────▶  /delivery/api/check                sync_log / bi_sync_log
            ──POST───────▶  /delivery/api/create               users / user_groups
            ──POST───────▶  /delivery/api/retry                settings
            ──POST───────▶  /bi-sync/run
            ──GET────────▶  /bi-sync/charts
            ──GET────────▶  /dfg-customers
            ──POST───────▶  /cancel/{token}
            ──GET────────▶  /vbn-name/:code
            ──GET────────▶  /vbn-search?q=...
            ──GET────────▶  /floricode/colors
            ──POST───────▶  /sync/run
            ──POST───────▶  /sync/ecuador/run
            ──GET────────▶  /vbn-auto/status
            ──POST───────▶  /vbn-auto/toggle

/api/auth   ◀──────────── Auth.js v5 (JWT, 2h session)
/api/log    ◀──────────── zapis operacji do Neon
/api/history◀──────────── odczyt historii z Neon
/api/admin  ◀──────────── zarządzanie użytkownikami/grupami
```

Przeglądarka łączy się **bezpośrednio z Railway** (`NEXT_PUBLIC_RAILWAY_API_URL`). `FetchAuthPatch` automatycznie wstrzykuje `Authorization: Bearer <token>` do każdego `fetch()` kierowanego na Railway. Vercel pośredniczy przy uwierzytelnianiu, historii operacji i zarządzaniu użytkownikami (osobne endpointy `/api/admin/*` w Next.js, na tej samej bazie Neon).

Import dostawy i BI Sync **nie używają Playwright** — to bezpośrednie wywołania REST API FreshPortal (DFG BatchV1 API, BI Sync API), osobna autoryzacja bearer-tokenem (`DFG_API_KEY`, `BI_SYNC_API_KEY`) niezależna od loginu/hasła używanego przez Playwright-owe moduły (VBN, produkty, zdjęcia).

## Autoryzacja

Dostęp oparty na **grupach uprawnień (RBAC)**:

| Uprawnienie | Funkcja |
|-------------|---------|
| `vbn:check` | VBN Checker — sprawdzanie kodów |
| `vbn:fix` | VBN Checker — naprawa kodów w FreshPortal |
| `products:create` | Tworzenie nowych produktów |
| `photos:upload` | Photo Uploader |
| `delivery:import` | Import dostawy Ecuador (DFG API) |
| `admin:manage` | Panel admina (użytkownicy, grupy, klienci DFG), synchronizacja, Analysis Tool, debug |

Tokeny JWT podpisane wspólnym `AUTH_SECRET` (Next.js ↔ Railway). Railway weryfikuje token przy każdym żądaniu. **Brak `AUTH_SECRET` = tryb dev (wszystkie uprawnienia) — niebezpieczne na produkcji.**

Konta blokowane po 5 błędnych próbach logowania (15 minut).

## Anulowanie operacji AI

Wszystkie wywołania Claude API obsługują **prawdziwe anulowanie po stronie serwera**:
1. Frontend generuje `cancel_token` (UUID) i wysyła go z requestem
2. Kliknięcie "Anuluj": przerywa fetch + wysyła `POST /cancel/{token}` do Railway
3. Railway ustawia `threading.Event` → funkcja AI wychodzi ze streamu Anthropic → połączenie HTTP do Anthropic zamknięte → brak dalszych tokenów

Dotyczy: `ai_suggest_vbn_for_checker` (VBN Checker) i `ai_analyze_product` (kreator produktów).

## Struktura projektu

```
src/
  app/
    page.tsx                      — hub z kafelkami, wybór systemu, nawigacja boczna
    login/page.tsx                — strona logowania (z opcją pokaż/ukryj hasło)
    layout.tsx                    — layout z SystemProvider, favicon = app/icon.png
    icon.png                      — favicon (konwencja Next.js App Router)
    api/
      auth/[...nextauth]/route.ts — Auth.js handler
      log/route.ts                — zapis operacji (username z sesji)
      history/route.ts            — odczyt historii operacji
      admin/                      — zarządzanie użytkownikami i grupami (CRUD)
  components/
    VbnChecker.tsx                — VBN Checker + Auto VBN + cancel
    ProductCreator.tsx            — kreator produktów + AI analiza + cancel
    PhotoUploader.tsx             — photo upload + analiza + cancel
    HistoryTab.tsx                — historia operacji, w tym pełny log delivery-import
    DeliveryImporter.tsx          — import dostawy: parser wielu formatów, wizard, DFG API, searchable customer picker
    DeliveryTour.tsx              — guided tour dla modułu importu dostaw
    AnalysisTool.tsx               — BI Sync: trigger synca, wykresy, log ostatniego runu
    AdminTab.tsx                  — użytkownicy / grupy / klienci DFG (checkboxy "used in delivery import")
    FetchAuthPatch.tsx            — wstrzyknięcie Bearer token do window.fetch (żądania do Railway)
    LanguageSwitcher.tsx
  contexts/
    SystemContext.tsx             — wybór systemu (stamgegevens / ecuador), localStorage
  lib/
    auth.ts                       — Auth.js config (JWT, RBAC)
    auth-db.ts                    — operacje na użytkownikach w Neon
    db.ts                         — logOperation, getHistory
    systems.ts                    — definicje systemów FreshPortal
    types.ts
    i18n.ts                       — tłumaczenia EN / NL / PL / ES

python/
  api_server.py                   — FastAPI: endpointy + SSE + APScheduler (hourly Ecuador sync, daily BI sync, daily/toggleable Auto VBN)
  auth_middleware.py              — weryfikacja JWT, require_permission / require_any_permission, CORS
  scraper_fp.py                   — Playwright: FreshPortal login, pobieranie, inline edit VBN
  scraper_vbn.py                  — Floricode API: weryfikacja VBN, wyszukiwanie, kolory
  scraper_catalogue.py            — Playwright: lista dostawców FreshPortal (do pickera w imporcie dostaw)
  scraper_fust.py                 — Playwright: tabela opakowań (fust) FreshPortal
  verifier.py                     — reguły weryfikacji VBN + AI z cancel_event
  product_creator.py              — fuzzy search + kopiowanie szablonu
  ai_helper.py                    — Claude AI: streaming + cancel_event
  photo_matcher.py                — AND-ILIKE matching zdjęć do produktów
  photo_uploader.py                — upload zdjęć przez Playwright
  parser_delivery.py              — parser JSON/TXT dostaw (kilka formatów) + normalizacja pól + rozwiązywanie growera
  delivery_product_match.py       — dopasowanie linii dostawy do ecuador_products (zastępuje stare dopasowanie po katalogu dostawcy)
  dfg_api_client.py               — klient DFG BatchV1 REST API (auth, check/create/retry batch) — zastępuje Playwright-owy scraper_delivery.py
  bi_sync.py                      — codzienny/ręczny sync BI (stock_entry/order_lines/invoice) do mirror tables
  bi_sync_client.py               — klient BI Sync API (auth, pobieranie i parsowanie eksportu CSV z ZIP)
  sync.py                         — pełna i inkrementalna synchronizacja katalogu stamgegevens + Ecuador
  db.py                           — Postgres: upsert, search, historia, settings, BI mirror tables, dfg_customers
  i18n.py                         — tłumaczenia backendu (EN/NL/PL/ES)
  config.py                       — konfiguracja z env vars
  requirements.txt
```

## Lokalne uruchomienie

```bash
# 1. Zależności Node
npm install

# 2. Zależności Python
pip install -r python/requirements.txt
playwright install chromium

# 3. Zmienne środowiskowe
cp .env.example .env.local
# Uzupełnij wartości

# 4. Backend
cd python && python api_server.py   # http://localhost:8000

# 5. Frontend (osobny terminal)
npm run dev                          # http://localhost:3000
```

Ustaw `NEXT_PUBLIC_RAILWAY_API_URL=http://localhost:8000` w `.env.local`.

## Zmienne środowiskowe

### Railway (backend)

| Zmienna | Wymagana | Opis |
|---------|----------|------|
| `AUTH_SECRET` | **TAK** | Klucz JWT współdzielony z Next.js — identyczny po obu stronach. Brak = tryb dev (pełny dostęp) |
| `FRESHPORTAL_URL` | **TAK** | URL FreshPortal stamgegevens, np. `https://fp042100.freshportal.nl` |
| `FRESHPORTAL_USERNAME` | **TAK** | Login FreshPortal stamgegevens |
| `FRESHPORTAL_PASSWORD` | **TAK** | Hasło FreshPortal stamgegevens |
| `ECUADOR_FP_URL` | nie | URL FreshPortal Ecuador. Domyślnie `https://850255.freshportal.nl` |
| `ECUADOR_FP_USERNAME` | nie | Login FreshPortal Ecuador — brak = fallback na `FRESHPORTAL_USERNAME` |
| `ECUADOR_FP_PASSWORD` | nie | Hasło FreshPortal Ecuador — brak = fallback na `FRESHPORTAL_PASSWORD` |
| `DFG_API_KEY` | tak (import dostawy) | Klucz do DFG BatchV1 REST API (tworzenie przesyłek) |
| `DFG_API_BASE_URL` | nie | Domyślnie `https://850255-api.freshportal.com` |
| `BI_SYNC_API_KEY` | tak (Analysis Tool) | Klucz do BI Sync export API |
| `BI_SYNC_API_BASE_URL` | nie | Domyślnie `https://850255-api.freshportal.com` |
| `POSTGRES_URL` | **TAK** | Connection string Neon Postgres |
| `ALLOWED_ORIGINS` | **TAK** | CORS — domeny oddzielone przecinkiem, np. `https://twoja-app.vercel.app`. Brak = `*` |
| `FLORICODE_USERNAME` | tak | Client ID Floricode (OAuth2) |
| `FLORICODE_PASSWORD` | tak | Client Secret Floricode |
| `ANTHROPIC_API_KEY` | tak | Claude AI — sugestie VBN, wykrywanie duplikatów |

### Vercel (frontend)

| Zmienna | Wymagana | Opis |
|---------|----------|------|
| `AUTH_SECRET` | **TAK** | Identyczny jak na Railway |
| `NEXTAUTH_URL` | **TAK** | Publiczny URL, np. `https://twoja-app.vercel.app` |
| `NEXT_PUBLIC_RAILWAY_API_URL` | **TAK** | Publiczny URL Railway API |
| `POSTGRES_URL` | **TAK** | Connection string Neon Postgres (ta sama DB) |
| `ADMIN_DEFAULT_PASSWORD` | tak | Hasło konta admin przy pierwszym seedzie. Brak = `"admin"` — **zmień natychmiast** |

## Deploy

### Railway (backend)

1. Utwórz projekt na [railway.app](https://railway.app) i połącz repo
2. Railway wykryje `Dockerfile` automatycznie (`railway.toml`)
3. Ustaw zmienne środowiskowe (tabela Railway powyżej)
4. Deploy

### Vercel (frontend)

1. Importuj repo na [vercel.com/new](https://vercel.com/new)
2. Ustaw zmienne środowiskowe (tabela Vercel powyżej)
3. Deploy

## Endpointy Railway API

Pełna, żywa lista jest w `python/api_server.py` (`@app.get/post/put/delete`) — poniżej pogrupowany przegląd najważniejszych.

| Endpoint | Metoda | Uprawnienie | Opis |
|----------|--------|-------------|------|
| `/health` | GET | — | Healthcheck |
| `/cancel/{token}` | POST | (dowolne) | Zatrzymaj trwające wywołanie Anthropic AI |
| `/vbn-check/stream` | POST | `vbn:check` | SSE: sprawdzenie VBN (`{ vbn, lang, cancel_token }`) |
| `/vbn-fix/stream` | POST | `vbn:fix` | SSE: naprawa VBN (`{ fixes: [{product_id, new_vbn}], lang }`) |
| `/vbn-name/{code}` | GET | `vbn:check` | Oficjalna nazwa kodu VBN |
| `/vbn-search` | GET | `vbn:check` | Wyszukiwanie kodów VBN (`?q=rosa tros&limit=15`) |
| `/vbn-auto/status` `/toggle` `/history` `/run-now` | GET/POST | `vbn:check` / `admin:manage` | Auto VBN check — status, włącz/wyłącz, historia, ręczne odpalenie |
| `/product-search/stream` | POST | `products:create` | SSE: wyszukiwanie podobnych produktów |
| `/product-number-suggest` | GET | `products:create` | Wolny numer produktu |
| `/product-create/stream` | POST | `products:create` | SSE: kopiowanie produktu jako szablon |
| `/product-ai-analyze` | POST | `products:create` | AI: duplikaty + sugestia VBN (`{ name, candidates, preferred_vbn, cancel_token }`) |
| `/photo-upload/analyze/stream` | POST | `photos:upload` | SSE: dopasowanie zdjęć |
| `/photo-upload/execute/stream` | POST | `photos:upload` | SSE: upload zdjęć do FreshPortal |
| `/floricode/colors` `/refresh` | GET | `products:create` / `admin:manage` | Lista kolorów / wyczyść cache |
| `/delivery/parse` | POST | `admin:manage` / `delivery:import` | Parsuj JSON/TXT dostawy → linie + dopasowania + grower |
| `/delivery/product-search` | POST | `admin:manage` / `delivery:import` | Live wyszukiwanie w `ecuador_products` (modal ręcznej korekty dopasowania) |
| `/delivery/api/check` | POST | `admin:manage` / `delivery:import` | Sprawdź czy przesyłka (batch) już istnieje w DFG |
| `/delivery/api/create` | POST | `admin:manage` / `delivery:import` | Utwórz przesyłkę + stock entries przez DFG BatchV1 API |
| `/delivery/api/retry` | POST | `admin:manage` / `delivery:import` | Dodaj/popraw pojedyncze linie w istniejącym batchu |
| `/delivery/import-log` | GET/POST | `admin:manage` / `delivery:import` | Historia importów dostaw (log request/response + status per linia) |
| `/dfg-customers` | GET | `admin:manage` / `delivery:import` | Lista klientów DFG z flagą `used_in_delivery_import` |
| `/dfg-customers/set-flag` `/set-all-flags` | POST | `admin:manage` | Włącz/wyłącz klienta (pojedynczo / zbiorczo) w Adminie |
| `/bi-sync/run` | POST | `admin:manage` | Ręczne uruchomienie synca BI (backfill na wybraną datę) |
| `/bi-sync/history` | GET | `admin:manage` | Historia runów BI sync + statystyki tabel |
| `/bi-sync/charts` | GET | `admin:manage` | Zagregowane serie dzienne (stock_entries, order_lines) do wykresów |
| `/bi-sync/debug-pull` | GET | `admin:manage` | Debug: podgląd surowych tabel z eksportu BI Sync |
| `/catalogue/suppliers` | GET | `admin:manage` | Lista dostawców FreshPortal (picker w imporcie dostaw) |
| `/catalogue/{supplier_id}/matches` | GET/PUT/DELETE | `admin:manage` | Cache zatwierdzonych dopasowań produktów per dostawca |
| `/fust/sync` `/list` | POST/GET | `admin:manage` | Synchronizacja i lista opakowań (fust) FreshPortal |
| `/sync/run` | POST | `admin:manage` | Uruchom synchronizację stamgegevens |
| `/sync/ecuador/run` `/history` | POST/GET | `admin:manage` | Synchronizacja katalogu `ecuador_products` |
| `/sync/status` `/history` | GET | `admin:manage` | Status / historia synchronizacji stamgegevens |
| `/user/flag/{name}` | GET/POST | (zalogowany) | Per-user flagi UI (np. czy pokazano guided tour) |
| `/debug/*` | GET/POST | `admin:manage` | Diagnostyka FreshPortal / kolumny VBN — do developmentu |

## Import dostawy — flow

1. **Upload** — wgraj JSON/TXT lub wklej tekst. System wykrywa format (patrz tabela wyżej) i parsuje faktury.
2. **Shipment** — wybór/potwierdzenie dostawcy FreshPortal (auto-dopasowanie po nazwie + ręczny picker), przypisanie klienta do faktury z searchable-comboboxa (zasilanego z listy zarządzanej w Adminie → zakładka Customers).
3. **Preview** — tabela linii dostawy z automatycznie dopasowanymi produktami z `ecuador_products` (fuzzy/floricode/cache matching). Linie bez dopasowania oznaczone do ręcznej korekty (modal z live-wyszukiwarką, ze spinnerem i komunikatem błędu odróżnionym od "brak wyników"). Box Weight edytowalny inline, z nawigacją strzałkami między wierszami. Growerzy sieci Pomarosa/Tessa rozwiązywani po fizycznej lokalizacji boxa, niezależnie od nazwy firmy handlowej na fakturze.
4. **Import** — kliknięcie "Importuj" tworzy przesyłkę przez DFG BatchV1 API (check → create, z retry dla pojedynczych nieudanych linii). Po zakończeniu: podsumowanie z linkami do przesyłki i faktury we FreshPortal, pełny log request/response (zapisany też do Historii) + przycisk "Zacznij od nowa" (bez potwierdzenia na tym etapie).

Guided tour prowadzi nowego użytkownika przez wszystkie 4 etapy na przykładowych danych.

## VBN Checker — jak działa AI

Reguły deterministyczne, AI tylko dla przypadków niejednoznacznych:

1. **Brak VBN** → AI sugeruje kod na podstawie nazwy
2. **VBN nie znaleziony w Floricode** → AI sugeruje zastępczy
3. **Preserved/Bleached/Dried** → 2712 lub bardziej szczegółowy (deterministyczne)
4. **Colour treated** → Floricode search + AI fallback
5. **Spray/Non-spray mismatch** → AI weryfikuje i sugeruje właściwy typ
6. **Ogólna ambiwalencja** → AI porównuje holenderskie tłumaczenie z oficjalną nazwą VBN

Zasada "overig": AI musi zwrócić konkretny `proposed_vbn` żeby produkt był ERROR — brak lepszego kodu = OK.

## Tworzenie produktu — flow

1. Nazwa → **Szukaj** → AND-ILIKE na DB, wyniki ≥80% jako szablony; AI równolegle: duplikaty + VBN
2. Kliknij szablon → kolor pre-selectowany, numer weryfikowany
3. Potwierdź → Playwright wypełnia formularz kopiowania w FreshPortal (Shadow DOM)

## Synchronizacja

**Stamgegevens** — pełna: 2 sesje Playwright (1–130 i 131–koniec), osobne logowanie. Logi w `sync_log.messages` (JSONB). Inkrementalna: tylko produkty zmienione od ostatniego udanego synca. Odpalana też co godzinę automatycznie (APScheduler).

**Ecuador** (`ecuador_products`) — osobna synchronizacja katalogu produktów Ecuador, używana przez dopasowywanie linii w imporcie dostaw.

**BI Sync** (Analysis Tool) — codzienna automatyczna synchronizacja `stock_entry`/`order_lines`/`invoice` z eksportu BI Sync API do lokalnych mirror tables, z harmonogramem trwałym w bazie (przetrwa redeploy bez utraty rytmu, analogicznie do Auto VBN check). Filtrowane do `stock_entry_type_id` 4/5 (offer / limited offer — realne oferty webshopu) i `order_lines` dla klienta referencyjnego OZ-Hami Direct Sales (customer_id=12).
