#!/usr/bin/env python3
"""Translation checks for freshportal-dashboard (src/lib/i18n.ts).

Commands:
  parity                  every language has exactly the keys English has
  untranslated            nl/pl/es values identical to English (a review list)
  hardcoded FILE [FILE…]  text written straight into .tsx files (heuristic)

File paths may be relative to the repository root.
Exit code 1 when parity fails or hardcoded text is found.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
I18N = ROOT / "src" / "lib" / "i18n.ts"
LANGS = ("en", "nl", "pl", "es")

_LANG_START = re.compile(r"^const (en|nl|pl|es)\b[^=]*=\s*\{\s*$")
_OPEN = re.compile(r"""^\s*["']?([\w$-]+)["']?\s*:\s*\{\s*$""")
_CLOSE = re.compile(r"^\s*\}\s*[,;]?\s*$")
_LEAF = re.compile(r"""^\s*["']?([\w$-]+)["']?\s*:\s*(\S.*?)\s*,?\s*$""")


def parse_translations(path: Path = I18N) -> dict[str, dict[str, tuple[str, int]]]:
    """Map language -> {"block.key": (raw value, line number)}.

    Relies on the file's layout: one key per line, nested objects opened with
    `key: {` on their own line and closed with `},`.
    """
    langs: dict[str, dict[str, tuple[str, int]]] = {}
    current: dict[str, tuple[str, int]] | None = None
    stack: list[str] = []
    pending: tuple[str, str, int] | None = None  # a function value whose body is on the next line
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        start = _LANG_START.match(line)
        if start:
            current = langs.setdefault(start.group(1), {})
            stack, pending = [], None
            continue
        if current is None:
            continue
        if pending:
            key, head, first = pending
            current[key] = (f"{head} {line.strip().rstrip(',')}", first)
            pending = None
            continue
        opened = _OPEN.match(line)
        if opened:
            stack.append(opened.group(1))
        elif _CLOSE.match(line):
            if stack:
                stack.pop()
            else:
                current = None
        else:
            leaf = _LEAF.match(line)
            if leaf:
                key = ".".join(stack + [leaf.group(1)])
                current[key] = (leaf.group(2), number)
                if leaf.group(2).endswith("=>"):
                    pending = (key, leaf.group(2), number)
    return langs


def check_parity(path: Path = I18N) -> list[str]:
    langs = parse_translations(path)
    if "en" not in langs:
        return [f"{path}: no `const en = {{` block found"]
    base = langs["en"]
    problems = []
    for lang in LANGS[1:]:
        keys = langs.get(lang)
        if keys is None:
            problems.append(f"{lang}: language block missing")
            continue
        for key in sorted(base.keys() - keys.keys()):
            problems.append(f"{lang}: missing {key} (en line {base[key][1]})")
        for key in sorted(keys.keys() - base.keys()):
            problems.append(f"{lang}: extra {key} (line {keys[key][1]}) that en does not have")
    return problems


def find_untranslated(path: Path = I18N) -> list[str]:
    langs = parse_translations(path)
    base = langs.get("en", {})
    hits = []
    for lang in LANGS[1:]:
        for key, (value, number) in langs.get(lang, {}).items():
            if key not in base or value != base[key][0]:
                continue
            text = re.sub(r"\$\{[^}]*\}", "", value)
            if len(re.findall(r"[A-Za-zÀ-ž]", text)) < 4:
                continue
            hits.append(f"{lang} line {number}: {key} = {value}")
    return hits


_PROP = re.compile(r"""\b(placeholder|title|aria-label|alt|label)=["']([^"'{}]*[A-Za-z]{2,}[^"'{}]*)["']""")
_MESSAGE = re.compile(
    r"""\b(set\w*(?:Error|Message|Status|Msg|Warning|Notice|Info)|alert|confirm|toast(?:\.\w+)?)"""
    r"""\(\s*(["'`])((?:(?!\2).)*[A-Za-z]{3,}(?:(?!\2).)*)\2""")
_JSX_TEXT = re.compile(r">\s*([^<>{}]*[A-Za-z]{3,}[^<>{}]*?)\s*<")
_TEXT_LINE = re.compile(r"""^\s*([A-Za-z][^<>{}=;()`"]*[A-Za-z.!?:…])\s*$""")
_SKIP_LINE = re.compile(r"^\s*(//|/\*|\*|import |export \{|console\.)")
_CLASSNAME = re.compile(r"""className=(["'`]).*?\1|className=\{[^}]*\}""")
_CODE_MARKS = ("&&", "||", "==", "=>", ";", "|", "?.")
_KEYWORDS = {"return", "else", "break", "continue", "default:", "try", "finally", "do"}


def _looks_like_code(text: str) -> bool:
    stripped = text.strip()
    return (not stripped or stripped in _KEYWORDS or any(mark in stripped for mark in _CODE_MARKS)
            or re.fullmatch(r"[\w.$-]+", stripped) is not None and stripped[:1].islower() and "." in stripped)


def find_hardcoded(files: list[str]) -> list[str]:
    hits = []
    for name in files:
        path = Path(name) if Path(name).is_absolute() else ROOT / name
        rel = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)
        previous = ""
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if _SKIP_LINE.match(line):
                continue
            found = [("prop", m.group(2)) for m in _PROP.finditer(line)]
            found += [("message", m.group(3)) for m in _MESSAGE.finditer(line)]
            code = _CLASSNAME.sub("", line)
            found += [("jsx text", m.group(1)) for m in _JSX_TEXT.finditer(code)]
            if not found and previous.rstrip().endswith(">") and _TEXT_LINE.match(line):
                found.append(("jsx text", line.strip()))
            for kind, text in found:
                if not _looks_like_code(text):
                    hits.append(f"{rel}:{number}: {kind}: {text.strip()}")
            if line.strip():
                previous = line
    return hits


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("parity", "untranslated"):
        sub.add_parser(command).add_argument("--i18n", type=Path, default=I18N)
    sub.add_parser("hardcoded").add_argument("files", nargs="+")
    args = parser.parse_args(argv)

    if args.command == "parity":
        problems = check_parity(args.i18n)
        counts = {lang: len(keys) for lang, keys in parse_translations(args.i18n).items()}
        print(f"keys per language: {counts}")
        print("\n".join(problems) if problems else "OK: all languages have the same keys")
        return 1 if problems else 0
    if args.command == "untranslated":
        hits = find_untranslated(args.i18n)
        print("\n".join(hits) if hits else "OK: no value is identical to English")
        print(f"{len(hits)} to review (brand names, codes and units may rightly stay the same)")
        return 0
    hits = find_hardcoded(args.files)
    print("\n".join(hits) if hits else "OK: no hardcoded text found")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
