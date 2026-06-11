#!/usr/bin/env python3
"""Extract normalized text from the SotDL rulebook PDFs.

The PDFs live in the repo root (gitignored). Output goes to scripts/cache/
(also gitignored) for the parse_* scripts to consume.

The core rulebook's embedded fonts map ligatures to private characters;
normalize() repairs them so downstream data is clean English.
"""
import os
import re
import sys

import fitz  # PyMuPDF

CACHE = os.path.join(os.path.dirname(__file__), "cache")

BOOK_FILES = [
    "SDL1000_Shadow_of_the_Demon_Lord_Revised-digital_3-21-19-1 (2).pdf",
    "Occult_Philosophy_book_file_-_digital_links_v3.pdf",
    "Terrible_Beauty_digital040416.pdf",
]


def find_pdf_dir() -> str:
    """Walk up from this script until a directory containing the PDFs is found."""
    if "SOTDL_PDF_DIR" in os.environ:
        return os.environ["SOTDL_PDF_DIR"]
    d = os.path.abspath(os.path.dirname(__file__))
    while d != "/":
        if any(os.path.exists(os.path.join(d, f)) for f in BOOK_FILES):
            return d
        d = os.path.dirname(d)
    raise SystemExit("Could not locate the rulebook PDFs; set SOTDL_PDF_DIR")

BOOKS = {
    "core": "SDL1000_Shadow_of_the_Demon_Lord_Revised-digital_3-21-19-1 (2).pdf",
    "occult": "Occult_Philosophy_book_file_-_digital_links_v3.pdf",
    "terrible": "Terrible_Beauty_digital040416.pdf",
}

# Broken ligature glyphs observed in the core rulebook's fonts.
LIGATURES = [
    ("ŋ", "fi"),   # ŋ
    ("Ŋ", "ff"),   # Ŋ
    ("Ō", "fl"),   # Ō
    ("ő", "ffi"),  # ő
    ("Œ", "ffl"),  # Œ
    ("ﬁ", "fi"),
    ("ﬂ", "fl"),
]


def normalize(text: str) -> str:
    for bad, good in LIGATURES:
        text = text.replace(bad, good)
    # Acute accent used as "fi" before letters (e.g. "bene´ts", "´lled").
    text = re.sub(r"´(?=[a-z])", "fi", text)
    # Ligatures extracted with a stray trailing space ("fi rst", "camoufl age",
    # "Diffi culty"). "ff" is excluded: real words end in it ("off", "staff").
    text = re.sub(r"(ffi|ffl|fi|fl) (?=[a-z])", r"\1", text)
    text = text.replace(" ", " ")
    return text


def main():
    os.makedirs(CACHE, exist_ok=True)
    pdf_dir = find_pdf_dir()
    for key, filename in BOOKS.items():
        path = os.path.join(pdf_dir, filename)
        if not os.path.exists(path):
            print(f"missing: {path}", file=sys.stderr)
            continue
        doc = fitz.open(path)
        out = os.path.join(CACHE, f"{key}.txt")
        with open(out, "w") as f:
            for i, page in enumerate(doc):
                f.write(f"\n===PAGE {i + 1}===\n")
                f.write(normalize(page.get_text()))
        print(f"{key}: {len(doc)} pages -> {out}")
        doc.close()


if __name__ == "__main__":
    main()
