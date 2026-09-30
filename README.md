# FreshFromSource Dashboard

Wewnętrzne narzędzie do pracy z FreshPortal. Przejmuje powtarzalne rzeczy,
które w portalu trzeba by wyklikać ręcznie: sprawdza i poprawia kody VBN,
zakłada produkty i dostawców, wgrywa zdjęcia, importuje dostawy, poprawia wagi
kartonów i pokazuje dane sprzedaży.

## Jak z tego korzystać

1. Zaloguj się kontem, które założył Ci administrator.
2. Wybierz system FreshPortal (np. Stamgegevens, Ecuador, Kenya). Jeśli masz
   dostęp tylko do jednego, ten krok jest pomijany.
3. Wybierz moduł.

Widzisz tylko moduły, które działają na wybranym systemie i do których masz
uprawnienia. Z wnętrza modułu przejdziesz do innego przez kafelki z boku, bez
wracania na start. Język (EN / NL / PL / ES) zmienisz na górnym pasku.

## Moduły

| Moduł | System | Co robi |
|-------|--------|---------|
| **VBN Checker** | Stamgegevens | Sprawdza, czy produkty mają właściwy kod VBN, podpowiada poprawny i poprawia go w portalu. Może też sam, raz dziennie, sprawdzać świeżo dodane produkty. |
| **Nowe produkty** | Stamgegevens, Test | Zakłada produkt na wzór najbardziej podobnego istniejącego. Ostrzega przed duplikatem i podpowiada VBN. |
| **Photo Uploader** | Stamgegevens | Dopasowuje zdjęcia do produktów po nazwie pliku i wgrywa je do portalu. |
| **Import dostawy** | Ecuador | Czyta plik od dostawcy (JSON, TXT albo fakturę PDF), dopasowuje produkty i tworzy przesyłkę w FreshPortal. |
| **Analysis Tool** | Ecuador | Wykresy sprzedaży i oferty webshopu, odświeżane raz dziennie. |
| **Box Weight** | Kenya | Poprawia wagi kartonów na fakturach według rzeczywistej wagi z listu przewozowego (AWB). |
| **Add Supplier** | Kenya | Czyta formularz dostawcy (skan PDF albo Word) i zakłada dostawcę w portalu. |
| **Knowledge base** | każdy | Pokazuje, czego nauczyła się baza wiedzy, i pozwala zatwierdzić proponowane zmiany. |
| **Historia** | każdy | Kto, co i kiedy zrobił i z jakim skutkiem. |
| **Admin** | każdy | Użytkownicy, grupy uprawnień i listy klientów. |

System **Test** służy do wypróbowania modułu, zanim trafi na prawdziwe dane.

## Uprawnienia

Dostępy nadaje się w **Admin → Groups**: grupa dostaje wybrane systemy
i moduły, a użytkownik należy do jednej lub kilku grup. Sesja trwa 2 godziny.
Po 5 błędnych hasłach konto blokuje się na 15 minut.

## Jak to działa

```
 Przeglądarka
   │
   ├──▶ Vercel   (Next.js)  — ekrany i logowanie
   │
   └──▶ Railway  (Python)   — cała praca z FreshPortal, Floricode i Claude
                    │
                    ▼
                 Neon (Postgres) — użytkownicy, historia, kopie katalogów, dane do wykresów
```

Z FreshPortal backend rozmawia na dwa sposoby: przez oficjalne API tam, gdzie
ono jest (import dostaw, dane do wykresów), a gdzie go nie ma, steruje
przeglądarką (Playwright), tak jak zrobiłby to człowiek. Claude pomaga
tam, gdzie reguły nie wystarczają: przy niejednoznacznym VBN, przy szukaniu
duplikatów i przy czytaniu zeskanowanych formularzy.

W tle backend sam odświeża kopię katalogu produktów (co godzinę), katalog VBN
i dane do wykresów (raz dziennie) oraz, jeśli jest włączony, uruchamia
automatyczny VBN Check.

## Uruchomienie u siebie

Potrzebujesz Node.js, Pythona 3.12 i dostępu do bazy Postgres.

```bash
npm install
pip install -r python/requirements.txt
playwright install chromium

cp .env.example .env.local          # uzupełnij wartości
cd python && python api_server.py   # backend:  http://localhost:8000
npm run dev                         # frontend: http://localhost:3000 (osobny terminal)
```

Wszystkie zmienne środowiskowe, z opisem, które są potrzebne gdzie, są
w [.env.example](.env.example).

## Wdrożenia

| Gałąź | Środowisko |
|-------|-----------|
| `test_1` | testowe, tu sprawdzamy zmiany |
| `main` | produkcja |

Vercel i Railway budują się same po pushu. Na `main` trafia tylko to, co ktoś
świadomie tam przeniesie po sprawdzeniu na teście.

## Dla programistów

Szczegóły techniczne nie są powtarzane tutaj, żeby się nie rozjeżdżały z kodem:

- [.claude/skills/](.claude/skills/) — instrukcje krok po kroku do typowych
  zadań: nowy moduł, nowy format pliku dostawy, tłumaczenia, sprawdzanie
  wykresów, wypychanie na test i na produkcję. Czyta je Claude Code, ale
  człowiek też się z nich dużo dowie.
- [python/api_server.py](python/api_server.py) — wszystkie endpointy API
  i zaplanowane zadania.
- [src/app/page.tsx](src/app/page.tsx) — który moduł jest na którym systemie.
- [src/lib/i18n.ts](src/lib/i18n.ts) — wszystkie teksty interfejsu w czterech
  językach.
- Specyfikacje zadań i notatki projektowe są w osobnym repozytorium
  `coloriginz-knowledge`.
