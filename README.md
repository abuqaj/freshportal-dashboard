# FreshFromSource Dashboard

Dashboard do zarządzania produktami w FreshPortal — weryfikacja VBN, tworzenie produktów, upload zdjęć, import dostaw Ecuador, synchronizacja katalogu.

## Funkcje

- **VBN Checker** — wpisz filtr VBN, sprawdź poprawność kodów, edytuj inline. Streaming SSE z paskiem postępu (0–100%). AI (Claude Haiku) sugeruje poprawny kod. Anulowanie w dowolnym momencie — zatrzymuje też połączenie z Anthropic API (brak dalszych kosztów tokenów).
- **Auto VBN Check** — przełącznik w VBN Checker, automatycznie sprawdza kody VBN nowo dodanych produktów (dziś i wczoraj) raz dziennie (APScheduler na Railway). Błędne kody automatycznie poprawiane. Re-login przy wygaśnięciu sesji FreshPortal, powrót do listy produktów po każdej poprawce.
- **Nowe produkty** — wpisz nazwę, system znajdzie podobne w DB (fuzzy search ≥80%). AI wykrywa duplikaty i sugeruje VBN. Podgląd różnicy nazwy (LCS). Numer produktu weryfikowany przed kliknięciem "Utwórz". Kolor pre-selectowany z szablonu.
- **Photo Uploader** — wrzuć zdjęcia, system dopasuje je do produktów (AND-ILIKE), przypisz jedno zdjęcie do wielu produktów (chipy + alternatywy). Matches ≥99% auto-selectowane. Anulowanie podczas analizy i uploadu.
- **Import dostawy** — wgraj JSON dostawy z FreshPortal Ecuador (3 obsługiwane formaty). System parsuje faktury, dopasowuje produkty do katalogu dostawcy, umożliwia ręczne korygowanie dopasowań w oknie modalnym (z atrybutami: długość, st/bos, opakowanie). Tworzy przesyłkę w FreshPortal i dodaje produkty do batch. 4-etapowy stepper: Upload → Przegląd → Import → Produkty.
- **Synchronizacja katalogu** — synchronizuje katalog dostawcy FreshPortal Ecuador do lokalnej bazy danych, używany przy dopasowywaniu produktów w imporcie dostaw.
- **Synchronizacja** — pełna synchronizacja katalogu (~44 tys. produktów) do Postgres lub inkrementalna (tylko zmiany od ostatniego synca). Split na dwie sesje Playwright po 130 stron.
- **Historia** — logi wszystkich operacji (VBN check, VBN fix, product create, photo upload, sync, Auto VBN, delivery import) z nazwą użytkownika, rozwijalnymi szczegółami i paginacją.
- **Zarządzanie użytkownikami** — panel admina: tworzenie kont, przypisywanie grup uprawnień, blokowanie kont.
- **Multi-system** — admin wybiera system po zalogowaniu (stamgegevens / ecuador). Każdy system pokazuje tylko swoje moduły.
- **Wielojęzyczność** — UI i komunikaty backendu w 4 językach: EN / NL / PL / ES.
- **Nawigacja boczna** — po wejściu w moduł, po lewej stronie karty widoczne są kafelki pozostałych modułów (w kolorach huba) umożliwiające bezpośrednie przełączanie bez powrotu do huba.

## Systemy

| System | Dostępne moduły |
|--------|----------------|
| `stamgegevens` | VBN Checker, Nowe produkty, Photo Uploader, Historia, Admin |
| `ecuador` | Import dostawy, Synchronizacja katalogu, Historia, Admin |

Admin po zalogowaniu wybiera system. Użytkownicy bez uprawnienia `admin:manage` trafiają bezpośrednio do modułów (bez wyboru systemu).

## Formaty JSON dostawy

| Format | Wykrywanie | Źródło |
|--------|-----------|--------|
| 1/2 | `"invoices"` w JSON | Elite / Alissroses — `invoices[]/boxes[]/products[]`, pola angielskie |
| 3 | `"id_factura"` w JSON | Bloomingacres / FreshFromSource — pojedynczy obiekt faktury, pola hiszpańskie, `detalles[]/productos[]` |

Mapowania: QB → QBE (typ skrzynki), ceny wyświetlane w USD.

## Architektura

```
Vercel (Next.js)          Railway (FastAPI + Playwright)       Neon (Postgres)
─────────────────         ──────────────────────────────       ───────────────
components  ──SSE────────▶  /vbn-check/stream                 products
            ──SSE────────▶  /vbn-fix/stream                   sync_log
            ──SSE────────▶  /product-search/stream            operations
            ──SSE────────▶  /product-create/stream            users / user_groups
            ──SSE────────▶  /photo-upload/analyze/stream      settings
            ──SSE────────▶  /delivery/import/stream
            ──SSE────────▶  /delivery/add-products/stream
            ──POST───────▶  /photo-upload/execute
            ──POST───────▶  /product-ai-analyze
            ──POST───────▶  /delivery/parse
            ──POST───────▶  /cancel/{token}
            ──GET────────▶  /vbn-name/:code
            ──GET────────▶  /vbn-search?q=...
            ──GET────────▶  /floricode/colors
            ──GET/POST───▶  /catalogue/sync
            ──POST───────▶  /sync/run
            ──GET────────▶  /sync/status
            ──GET────────▶  /vbn-auto/status
            ──POST───────▶  /vbn-auto/toggle

/api/auth   ◀──────────── Auth.js v5 (JWT, 2h session)
/api/log    ◀──────────── zapis operacji do Neon
/api/history◀──────────── odczyt historii z Neon
/api/admin  ◀──────────── zarządzanie użytkownikami
```

Przeglądarka łączy się **bezpośrednio z Railway** (`NEXT_PUBLIC_RAILWAY_API_URL`). `FetchAuthPatch` automatycznie wstrzykuje `Authorization: Bearer <token>` do każdego `fetch()` kierowanego na Railway. Vercel pośredniczy przy uwierzytelnianiu i historii operacji.

## Autoryzacja

Dostęp oparty na **grupach uprawnień (RBAC)**:

| Uprawnienie | Funkcja |
|-------------|---------|
| `vbn:check` | VBN Checker — sprawdzanie kodów |
| `vbn:fix` | VBN Checker — naprawa kodów w FreshPortal |
| `products:create` | Tworzenie nowych produktów |
| `photos:upload` | Photo Uploader |
| `admin:manage` | Panel admina, synchronizacja, import dostaw, katalog Ecuador, debug |

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
    login/page.tsx                — strona logowania
    layout.tsx                    — layout z SystemProvider
    api/
      auth/[...nextauth]/route.ts — Auth.js handler
      log/route.ts                — zapis operacji (username z sesji)
      history/route.ts            — odczyt historii operacji
      admin/                      — zarządzanie użytkownikami (CRUD)
  components/
    VbnChecker.tsx                — VBN Checker + Auto VBN + cancel
    ProductCreator.tsx            — kreator produktów + AI analiza + cancel
    PhotoUploader.tsx             — photo upload + analiza + cancel
    HistoryTab.tsx                — historia operacji z username
    DeliveryImporter.tsx          — import dostawy: parser 3 formatów, stepper, modal dopasowania
    CatalogueSync.tsx             — synchronizacja katalogu Ecuador
    AdminTab.tsx                  — zarządzanie użytkownikami
    FetchAuthPatch.tsx            — wstrzyknięcie Bearer token do window.fetch
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
  api_server.py                   — FastAPI: endpointy + SSE + APScheduler + _cancel_tokens
  auth_middleware.py              — weryfikacja JWT, require_permission, CORS
  scraper_fp.py                   — Playwright: FreshPortal login, pobieranie, inline edit VBN
  scraper_vbn.py                  — Floricode API: weryfikacja VBN, wyszukiwanie, kolory
  verifier.py                     — reguły weryfikacji VBN + AI z cancel_event
  product_creator.py              — fuzzy search + kopiowanie szablonu
  ai_helper.py                    — Claude AI: streaming + cancel_event
  photo_matcher.py                — AND-ILIKE matching zdjęć do produktów
  photo_uploader.py               — upload zdjęć przez Playwright
  parser_delivery.py              — parser JSON dostaw (3 formaty) + normalizacja pól
  sync.py                         — pełna i inkrementalna synchronizacja katalogu
  db.py                           — Postgres: upsert, search, historia, settings
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
| `FRESHPORTAL_ECUADOR_URL` | tak | URL FreshPortal Ecuador |
| `FRESHPORTAL_ECUADOR_USERNAME` | tak | Login FreshPortal Ecuador |
| `FRESHPORTAL_ECUADOR_PASSWORD` | tak | Hasło FreshPortal Ecuador |
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

| Endpoint | Metoda | Uprawnienie | Opis |
|----------|--------|-------------|------|
| `/health` | GET | — | Healthcheck |
| `/cancel/{token}` | POST | (dowolne) | Zatrzymaj trwające wywołanie Anthropic AI |
| `/vbn-check/stream` | POST | `vbn:check` | SSE: sprawdzenie VBN (`{ vbn, lang, cancel_token }`) |
| `/vbn-fix/stream` | POST | `vbn:fix` | SSE: naprawa VBN (`{ fixes: [{product_id, new_vbn}], lang }`) |
| `/vbn-name/:code` | GET | `vbn:check` | Oficjalna nazwa kodu VBN |
| `/vbn-search` | GET | `vbn:check` | Wyszukiwanie kodów VBN (`?q=rosa tros&limit=15`) |
| `/product-search/stream` | POST | `products:create` | SSE: wyszukiwanie podobnych produktów |
| `/product-number-suggest` | GET | `products:create` | Wolny numer produktu |
| `/product-create/stream` | POST | `products:create` | SSE: kopiowanie produktu jako szablon |
| `/product-ai-analyze` | POST | `products:create` | AI: duplikaty + sugestia VBN (`{ name, candidates, preferred_vbn, cancel_token }`) |
| `/photo-upload/analyze/stream` | POST | `photos:upload` | SSE: dopasowanie zdjęć |
| `/photo-upload/execute` | POST | `photos:upload` | Upload zdjęć do FreshPortal |
| `/floricode/colors` | GET | `products:create` | Lista kolorów |
| `/floricode/colors/refresh` | GET | `admin:manage` | Wyczyść cache kolorów |
| `/delivery/parse` | POST | `admin:manage` | Parsuj JSON dostawy → linia + dopasowania produktów + slim katalog |
| `/delivery/import/stream` | POST | `admin:manage` | SSE: utwórz przesyłkę (batch) w FreshPortal Ecuador |
| `/delivery/add-products/stream` | POST | `admin:manage` | SSE: dodaj dopasowane produkty do batch |
| `/catalogue/sync` | POST | `admin:manage` | Synchronizuj katalog dostawcy Ecuador do bazy |
| `/sync/run` | POST | `admin:manage` | Uruchom synchronizację stamgegevens |
| `/sync/status` | GET | `admin:manage` | Status synchronizacji |
| `/sync/history` | GET | `admin:manage` | Historia synchronizacji |
| `/vbn-auto/status` | GET | `vbn:check` | Status Auto VBN |
| `/vbn-auto/toggle` | POST | `admin:manage` | Włącz/wyłącz Auto VBN |
| `/vbn-auto/history` | GET | `vbn:check` | Historia Auto VBN |
| `/debug/fp` | GET | `admin:manage` | Diagnostyka FreshPortal |
| `/debug/colour-table` | GET | `admin:manage` | Tabela kolorów VBN |

## Import dostawy — flow

1. **Upload** — wgraj JSON lub wklej tekst. System wykrywa format (1/2/3) i parsuje faktury.
2. **Przegląd** — tabela linii dostawy z automatycznie dopasowanymi produktami z katalogu dostawcy. Linie bez dopasowania (match_method: none) oznaczone są jako wymagające uwagi. Kliknięcie linii otwiera modal z wyszukiwarką katalogu (widoczne atrybuty: długość cm, st/bos, opakowanie). Wszystkie ceny w USD.
3. **Import** — kliknięcie "Importuj" tworzy przesyłkę w FreshPortal Ecuador (SSE progress log).
4. **Produkty** — po utworzeniu batch, kliknięcie "Dodaj produkty" dodaje dopasowane linie. Po zakończeniu: podsumowanie z linkami do FreshPortal + przycisk "Zacznij od nowa".

Stepper: kroki 1–3 zaznaczone checkboxem po ukończeniu. Krok 4 "Produkty" wyświetla się jako aktywny (pustym kółkiem) do czasu dodania produktów — po sukcesie wszystkie 4 kroki stają się zielone.

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

Pełna: 2 sesje Playwright (1–130 i 131–koniec), osobne logowanie. Logi w `sync_log.messages` (JSONB).
Inkrementalna: tylko produkty zmienione od ostatniego udanego synca.
