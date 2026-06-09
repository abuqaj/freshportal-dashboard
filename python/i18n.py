"""Backend status message translations."""
from __future__ import annotations

MSGS: dict[str, dict[str, str]] = {
    "en": {
        "logging_in":          "Logging into FreshPortal…",
        "searching":           "Searching '{term}'…",
        "page_result":         "'{term}' page {page} — {total} products total",
        "no_good_matches":     "No results ≥80% — checking spelling with AI…",
        "ai_suggests":         "AI suggests: {spellings}",
        "ai_unavailable":      "AI unavailable — skipping spelling correction",
        "finished_search":     "Done — {total} products{best}",
        "number_taken_search": "Nr {base} taken — searching for available variant…",
        "number_taken_using":  "Nr {base} taken — using: {candidate}",
        "opening_copy_form":   "Opening copy form for product {id}…",
        "filling_name":        "Filling in name: {name}…",
        "filling_number":      "Filling in product number: {num}…",
        "fields_filled":       "Filled {name_n} name fields and {short_n} short name fields",
        "saving_product":      "Saving product…",
        "waiting_save":        "Waiting for save…",
        "verifying_product":   "Verifying created product…",
        "product_verified":    "Product verified successfully",
        "initializing":        "Initializing…",
        "connecting":          "Connecting to Railway…",
    },
    "nl": {
        "logging_in":          "Inloggen bij FreshPortal…",
        "searching":           "Zoeken naar '{term}'…",
        "page_result":         "'{term}' pagina {page} — {total} producten totaal",
        "no_good_matches":     "Geen resultaten ≥80% — spelling controleren met AI…",
        "ai_suggests":         "AI suggereert: {spellings}",
        "ai_unavailable":      "AI niet beschikbaar — spellingscorrectie overgeslagen",
        "finished_search":     "Klaar — {total} producten{best}",
        "number_taken_search": "Nr {base} bezet — zoeken naar beschikbare variant…",
        "number_taken_using":  "Nr {base} bezet — gebruik: {candidate}",
        "opening_copy_form":   "Kopieerformulier openen voor product {id}…",
        "filling_name":        "Naam invullen: {name}…",
        "filling_number":      "Productnummer invullen: {num}…",
        "fields_filled":       "{name_n} naamvelden en {short_n} korte naamvelden ingevuld",
        "saving_product":      "Product opslaan…",
        "waiting_save":        "Wachten op opslaan…",
        "verifying_product":   "Aangemaakt product verifiëren…",
        "product_verified":    "Product succesvol geverifieerd",
        "initializing":        "Initialiseren…",
        "connecting":          "Verbinding met Railway…",
    },
    "pl": {
        "logging_in":          "Logowanie do FreshPortal…",
        "searching":           "Szukam '{term}'…",
        "page_result":         "'{term}' strona {page} — {total} produktów łącznie",
        "no_good_matches":     "Brak wyników ≥80% — sprawdzam pisownię z AI…",
        "ai_suggests":         "AI sugeruje: {spellings}",
        "ai_unavailable":      "AI niedostępne — pomijam korektę pisowni",
        "finished_search":     "Zakończono — {total} produktów{best}",
        "number_taken_search": "Nr {base} zajęty — szukam wolnego wariantu…",
        "number_taken_using":  "Nr {base} zajęty — używam: {candidate}",
        "opening_copy_form":   "Otwieranie formularza kopiowania produktu {id}…",
        "filling_name":        "Wypełnianie nazwy: {name}…",
        "filling_number":      "Wypełnianie numeru produktu: {num}…",
        "fields_filled":       "Wypełniono {name_n} pól nazwy i {short_n} pól short name",
        "saving_product":      "Zapisywanie produktu…",
        "waiting_save":        "Czekam na zapis…",
        "verifying_product":   "Weryfikuję utworzony produkt…",
        "product_verified":    "Produkt zweryfikowany pomyślnie",
        "initializing":        "Inicjalizacja…",
        "connecting":          "Łączenie z Railway…",
    },
    "es": {
        "logging_in":          "Iniciando sesión en FreshPortal…",
        "searching":           "Buscando '{term}'…",
        "page_result":         "'{term}' página {page} — {total} productos en total",
        "no_good_matches":     "Sin resultados ≥80% — comprobando ortografía con IA…",
        "ai_suggests":         "La IA sugiere: {spellings}",
        "ai_unavailable":      "IA no disponible — omitiendo corrección ortográfica",
        "finished_search":     "Finalizado — {total} productos{best}",
        "number_taken_search": "Nº {base} ocupado — buscando variante disponible…",
        "number_taken_using":  "Nº {base} ocupado — usando: {candidate}",
        "opening_copy_form":   "Abriendo formulario de copia del producto {id}…",
        "filling_name":        "Rellenando nombre: {name}…",
        "filling_number":      "Rellenando número de producto: {num}…",
        "fields_filled":       "Rellenados {name_n} campos de nombre y {short_n} de nombre corto",
        "saving_product":      "Guardando producto…",
        "waiting_save":        "Esperando guardado…",
        "verifying_product":   "Verificando producto creado…",
        "product_verified":    "Producto verificado correctamente",
        "initializing":        "Inicializando…",
        "connecting":          "Conectando con Railway…",
    },
}


def msg(lang: str, key: str, **kwargs: object) -> str:
    templates = MSGS.get(lang, MSGS["en"])
    template = templates.get(key, MSGS["en"].get(key, key))
    if kwargs:
        try:
            return template.format(**kwargs)
        except (KeyError, IndexError):
            pass
    return template
