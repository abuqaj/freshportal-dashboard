# FreshPortal Dashboard

Dashboard do zarządzania produktami w FreshPortal — weryfikacja VBN, tworzenie produktów, upload zdjęć.

## Funkcje

- **VBN Checker** — wpisz numer VBN, sprawdź poprawność kodów wszystkich produktów, edytuj i zatwierdź poprawki inline (streaming SSE)
- **Nowe produkty** — wpisz nazwę produktu, system znajdzie podobne (fuzzy search odporny na literówki, próg 80%), skopiuje najbliższy jako szablon; numer produktu jest weryfikowany w FreshPortal jeszcze przed kliknięciem "Utwórz" — jeśli zajęty, proponowany jest wariant rozszerzony o kolejne litery ostatniego słowa nazwy (np. CAMALA → CAMALAV → CAMALAVE)
- **Wielojęzyczność** — interfejs dostępny w 4 językach: angielski, holenderski, polski, hiszpański; wybór przez menu flagowe w prawym górnym rogu, statusy z backendu tłumaczone dynamicznie
- **Photo Uploader** — uploaduj Excel z mapowaniem `product_id → zdjęcie`
- **Historia** — logi operacji VBN, tworzenia produktów i photo upload (wymaga Vercel Postgres)

## Architektura

```
Vercel (Next.js)          Railway (FastAPI + Playwright)
─────────────────         ──────────────────────────────
page.tsx  ──────SSE──────▶  /vbn-check/stream
          ──────SSE──────▶  /vbn-fix/stream
          ──────SSE──────▶  /product-search/stream
          ──────GET──────▶  /product-number-suggest
          ──────SSE──────▶  /product-create/stream
          ──────POST─────▶  /photo-upload
          ──────GET──────▶  /vbn-name/:code
          ──────GET──────▶  /vbn-search?q=...

/api/log      ────────────▶  Vercel Postgres (historia)
/api/history  ◀────────────  Vercel Postgres
```

Przeglądarka łączy się **bezpośrednio z Railway** (przez `NEXT_PUBLIC_RAILWAY_API_URL`). Vercel pośredniczy tylko przy logowaniu historii.

## Struktura projektu

```
src/app/
  page.tsx                   — główny UI (VBN, Nowe produkty, Photo, Historia)
  api/
    log/route.ts             — zapis operacji do Vercel Postgres
    history/route.ts         — odczyt historii z Vercel Postgres

python/
  api_server.py              — FastAPI: wszystkie endpointy HTTP + SSE
  scraper_fp.py              — Playwright: logowanie, pobieranie i edycja produktów FreshPortal
  scraper_vbn.py             — Floricode API: weryfikacja kodów VBN, wyszukiwanie po nazwie
  verifier.py                — reguły weryfikacji VBN (spray, kolor, preserved, brak VBN…)
  product_creator.py         — wyszukiwanie podobnych produktów + kopiowanie jako szablon
  i18n.py                    — tłumaczenia komunikatów backendowych (EN/NL/PL/ES)
  photo_uploader.py          — upload zdjęć do produktów FreshPortal
  reporter.py                — generowanie raportów Excel
  config.py                  — konfiguracja z env
  requirements.txt

src/
  lib/i18n.ts                — tłumaczenia UI (EN/NL/PL/ES) + lista języków z kodami krajów
  components/LanguageSwitcher.tsx — dropdown flagowy w prawym górnym rogu
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

Ustaw `NEXT_PUBLIC_RAILWAY_API_URL=http://localhost:8000` w `.env.local` żeby frontend łączył się z lokalnym backendem.

## Zmienne środowiskowe

| Zmienna | Gdzie | Opis |
|---------|-------|------|
| `FRESHPORTAL_URL` | Railway | URL instancji FreshPortal, np. `https://fp042100.freshportal.nl` |
| `FRESHPORTAL_USERNAME` | Railway | Login FreshPortal |
| `FRESHPORTAL_PASSWORD` | Railway | Hasło FreshPortal |
| `FLORICODE_USERNAME` | Railway | Login Floricode (weryfikacja VBN) |
| `FLORICODE_PASSWORD` | Railway | Hasło Floricode |
| `ANTHROPIC_API_KEY` | Railway | Opcjonalne — Claude AI do sugerowania kodów VBN i wykrywania duplikatów |
| `NEXT_PUBLIC_RAILWAY_API_URL` | Vercel | Publiczny URL Railway API |
| `POSTGRES_URL` | Vercel | Connection string Vercel Postgres (historia operacji) |

## Deploy

### Railway (backend Python)

1. Utwórz nowy projekt na [railway.app](https://railway.app)
2. Połącz repo `abuqaj/freshportal-dashboard`
3. Railway wykryje `Dockerfile` automatycznie (`railway.toml` ustawia builder na Dockerfile)
4. Dodaj zmienne środowiskowe (FRESHPORTAL_*, FLORICODE_*, opcjonalnie ANTHROPIC_API_KEY)
5. Deploy — serwis będzie dostępny pod wygenerowanym URL Railway

### Vercel (frontend Next.js)

1. Wejdź na [vercel.com/new](https://vercel.com/new)
2. Importuj repo `abuqaj/freshportal-dashboard`
3. Dodaj zmienne środowiskowe:
   - `NEXT_PUBLIC_RAILWAY_API_URL` — URL z kroku Railway
   - `POSTGRES_URL` — opcjonalnie, dla historii operacji
4. Deploy

## Endpointy Railway API

| Endpoint | Metoda | Opis |
|----------|--------|------|
| `/health` | GET | Healthcheck |
| `/vbn-check/stream` | POST | SSE: sprawdzenie VBN (`{ vbn: "595" }`) |
| `/vbn-fix/stream` | POST | SSE: naprawa VBN (`{ fixes: [{product_id, new_vbn}] }`) |
| `/vbn-name/:code` | GET | Oficjalna nazwa kodu VBN z Floricode |
| `/vbn-search` | GET | Wyszukiwanie kodów VBN po nazwie (`?q=dianthus&limit=15`) |
| `/product-search/stream` | POST | SSE: wyszukiwanie podobnych produktów (`{ name: "Rosa Ec Atena", lang: "en" }`) |
| `/product-number-suggest` | GET | Sprawdź dostępność numeru i zwróć wolny wariant (`?number=ROECAT&name=Rosa+Ec+Athena`) |
| `/product-create/stream` | POST | SSE: kopiowanie produktu jako szablon (`{ template_id, new_name, product_number, lang }`) |
| `/product-ai-analyze` | POST | Analiza duplikatów i sugestia VBN przez Claude AI (`{ name, candidates }`) |
| `/photo-upload` | POST | Upload zdjęć z pliku Excel (multipart) |
| `/debug/fp` | GET | Diagnostyka połączenia z FreshPortal |
| `/debug/colour-table` | GET | Podgląd tabeli kolorów VBN z Floricode |

## Tworzenie nowego produktu — szczegółowy flow

1. Użytkownik wpisuje nazwę (np. `Rosa Ec Athena`) i klika **Szukaj podobnych**
2. Backend (`product_creator.search_products`) przeszukuje FreshPortal fuzzy matchingiem
3. Wyniki ≥80% podobieństwa wyświetlane jako szablony do skopiowania
4. Po kliknięciu **Kopiuj jako szablon** formularz potwierdzenia pojawia się natychmiast, a w tle startuje `GET /product-number-suggest?number=CAMALA&name=Callistephus+Matsumoto+Lavender`:
   - Sprawdza `td[data-cell-action="product_number"]` w wynikach FreshPortal (exact match)
   - Jeśli zajęty — rozszerza numer o kolejne litery ostatniego słowa nazwy: `CAMALA` → `CAMALAV` → `CAMALAVE`, potem fallback na alfabet
   - Pole numeru aktualizuje się automatycznie; przycisk **Utwórz produkt** jest zablokowany do czasu zakończenia sprawdzania
5. Po kliknięciu **Utwórz produkt** backend (`product_creator.copy_and_create`):
   - Otwiera `/product/index/copy/PRO_ID/{id}/` (formularz kopiowania)
   - Wypełnia pola nazwy i numeru produktu przez Shadow DOM (Angular fps-input)
   - Zapisuje formularz
   - Weryfikuje sukces szukając wiersza z dokładnym `product_number` i `product_name` w wyrenderowanym DOM
6. Wynik (sukces / błąd) pojawia się w UI, operacja zapisywana jest do historii

## Algorytm wyszukiwania podobnych produktów

`product_creator.py` używa wieloetapowego wyszukiwania z fuzzy matching:

1. **Ekstrakcja variety** — wycina tokeny origin (`Ec`, `Col`, `Ke`…) z nazwy, porównuje tylko nazwę odmiany: `"Rosa Ec Atena"` → variety = `"Atena"`
2. **Generowanie search terms** — pełna fraza + warianty odporności na literówki (np. `"Atena"` → `["Atena", "Aten", "ena"]`), sufiks drugiej połowy słowa (`"ena"`) trafia w `"Ath-ena"` w FreshPortal
3. **Pobieranie stron** — dla każdego termu pobiera do 2 stron wyników przez `name_adjustable`
4. **Phase 2 (AI)** — jeśli brak wyników ≥80% i dostępny `ANTHROPIC_API_KEY`, Claude sugeruje alternatywną pisownię variety i wyszukuje ponownie
5. **Similarity scoring** — `SequenceMatcher` na samej variety (bez genus i origin): `"atena"` vs `"athena"` ≈ 91%
6. **Wyświetlanie** — tylko wyniki ≥80%; jeśli brak, 1 najlepszy z adnotacją

## Sprawdzanie dostępności numeru produktu

`number_adjustable` w FreshPortal to filtr **contains**, nie exact match. Dlatego `find_available_number()` / `_find_available_number_on_page()`:

1. Nawiguje do `?1=1&number_adjustable={kandydat}&page=1`
2. Czeka na `td[data-cell-action='product_number']` (SPA musi wyrenderować tabelę)
3. Sprawdza przez `page.evaluate()` czy którakolwiek komórka `td[data-cell-action="product_number"]` ma **dokładnie** ten tekst (case-insensitive)
4. Jeśli zajęty — następny kandydat generowany jest przez `_number_candidates(base, name)`:
   - **Faza 1**: dokłada kolejne litery ostatniego słowa nazwy (po pierwszych 2 już użytych): `CAMALA` + `V` → `CAMALAV`, + `E` → `CAMALAVE`
   - **Faza 2**: fallback alfabetyczny / cyfry gdy wyczerpano litery słowa lub osiągnięto 8 znaków
