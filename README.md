# FreshPortal Dashboard

Dashboard do zarządzania kodami VBN i zdjęciami produktów w FreshPortal.

## Funkcje

- **VBN Checker** — wpisz numer VBN, sprawdź wszystkie produkty, edytuj/zatwierdź poprawki
- **Photo Uploader** — uploaduj Excel z mapowaniem product_id → zdjęcie
- **Historia** — logi wszystkich operacji (wymaga Vercel Postgres)

## Lokalne uruchomienie

```bash
# 1. Zainstaluj zależności Node
npm install

# 2. Zainstaluj zależności Python
pip install -r python/requirements.txt
playwright install chromium

# 3. Uzupełnij .env.local (skopiuj z .env.example)
cp .env.example .env.local
# edytuj .env.local

# 4. Start
npm run dev
# Otwórz http://localhost:3000
```

## Deploy na Vercel

1. Wejdź na https://vercel.com/new
2. Importuj repo `abuqaj/freshportal-dashboard`
3. Dodaj Environment Variables (z .env.example)
4. Storage → Connect Database → Vercel Postgres (opcjonalne, dla historii)
5. Deploy

## Struktura projektu

```
src/app/
  page.tsx              — główny dashboard UI
  api/
    vbn-check/route.ts  — wywołuje python/vbn_runner.py
    vbn-fix/route.ts    — wywołuje python/fix_runner.py
    photo-upload/route.ts — wywołuje python/photo_uploader.py
    history/route.ts    — logi z bazy danych

python/
  vbn_runner.py         — bridge: pobiera produkty + weryfikuje VBN → JSON
  fix_runner.py         — bridge: stosuje poprawki VBN w FreshPortal → JSON
  scraper_fp.py         — scraper FreshPortal (Playwright)
  scraper_vbn.py        — API Floricode
  verifier.py           — logika weryfikacji (+ Claude AI)
  config.py             — konfiguracja z env
  photo_uploader.py     — upload zdjęć do FreshPortal
```
