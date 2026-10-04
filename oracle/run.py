#!/usr/bin/env python3
"""
Collator execution oracle.

Answers one question empirically:

    "Would a UNIQUE constraint on this column treat these two strings as the
     same value?"

For every (engine configuration x test vector) the oracle creates a throwaway
in-memory database, declares a UNIQUE column with that collation, inserts the
first value, then attempts to insert the second.  If the second insert is
rejected, the engine considers the two strings equal (COLLIDE).  If it is
accepted, they are two distinct rows (DISTINCT).

Nothing here is asserted from documentation.  Every EXECUTED tier claim in the
final report was produced by actually running the insert.

Stdlib only: sqlite3, unicodedata, socket, json.  Optional engines (DuckDB)
are probed and reported as UNAVAILABLE when their driver is not installed,
rather than being skipped silently.
"""

from __future__ import annotations

import argparse
import json
import platform
import socket
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Test vectors
# ---------------------------------------------------------------------------
# Each pair is a real duplicate-identity failure mode.  `klass` groups them so
# the UI can explain *which* kind of folding is at play.

VECTORS: list[dict[str, str]] = [
    {
        "id": "ascii-case",
        "klass": "case",
        "label": "ASCII case",
        "a": "Alice@Example.com",
        "b": "alice@example.com",
        "why": "The trivial case every engineer believes they have handled.",
    },
    {
        "id": "unicode-case",
        "klass": "case",
        "label": "Non-ASCII case",
        "a": "JOS\u00c9@EXAMPLE.COM",
        "b": "jos\u00e9@example.com",
        "why": "Only the non-ASCII character differs in case. SQLite NOCASE folds A-Z only, so this pair slips through.",
    },
    {
        "id": "accent-fold",
        "klass": "accent",
        "label": "Accent folding",
        "a": "Jos\u00e9@x.com",
        "b": "Jose@x.com",
        "why": "MySQL utf8mb4_0900_ai_ci folds accents; utf8mb4_0900_as_cs does not.",
    },
    {
        "id": "sharp-s",
        "klass": "case",
        "label": "Sharp s expansion",
        "a": "strasse@x.com",
        "b": "stra\u00dfe@x.com",
        "why": "German sharp s casefolds to 'ss', changing the string length.",
    },
    {
        "id": "nfc-nfd",
        "klass": "normalization",
        "label": "NFC vs NFD",
        "a": "caf\u00e9@x.com",
        "b": "cafe\u0301@x.com",
        "why": "macOS writes the decomposed form, Windows the composed form. Same pixels, different bytes.",
    },
    {
        "id": "trailing-space",
        "klass": "whitespace",
        "label": "Trailing space",
        "a": "bob@x.com",
        "b": "bob@x.com ",
        "why": "MySQL PAD SPACE and SQLite RTRIM trim it; MySQL 0900 and SQLite BINARY do not.",
    },
    {
        "id": "kelvin",
        "klass": "case",
        "label": "Kelvin sign vs k",
        "a": "\u212aey@x.com",
        "b": "key@x.com",
        "why": "U+212A KELVIN SIGN lowercases to 'k' in Unicode-aware code but not in ASCII folding.",
    },
    {
        "id": "ligature",
        "klass": "normalization",
        "label": "Ligature vs letters",
        "a": "\ufb01le@x.com",
        "b": "file@x.com",
        "why": "U+FB01 LATIN SMALL LIGATURE FI survives casefold; only NFKC decomposes it.",
    },
    {
        "id": "dotted-i",
        "klass": "case",
        "label": "Dotted capital I",
        "a": "\u0130@x.com",
        "b": "i\u0307@x.com",
        "why": "U+0130 casefolds to TWO code points, so a fixed-width hash assumption breaks.",
    },
    {
        "id": "fullwidth",
        "klass": "normalization",
        "label": "Fullwidth A",
        "a": "\uff21@x.com",
        "b": "A@x.com",
        "why": "U+FF21 is only folded by NFKC compatibility decomposition.",
    },
    {
        "id": "combining-mark",
        "klass": "accent",
        "label": "Combining mark in Arabic",
        "a": "Muhammad@x.com",
        "b": "Mu\u1e25ammad@x.com",
        "why": "U+1E25 ARABIC LETTER HA WITH DOT BELOW - an accent no ASCII rule notices.",
    },
    {
        "id": "homoglyph",
        "klass": "confusable",
        "label": "Cyrillic a vs Latin a",
        "a": "admin@x.com",
        "b": "adm\u0430in@x.com",
        "why": "U+0430 CYRILLIC SMALL LETTER A. No engine folds confusables - only UTS #39 does.",
    },
]

# ---------------------------------------------------------------------------
# Application-side policies (the code *you* wrote, before the row hits the DB)
# ---------------------------------------------------------------------------

Policy = Callable[[str], str]


def _p_casefold(s: str) -> str:
    return s.casefold()


def _p_lower(s: str) -> str:
    return s.lower()


def _p_nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _p_nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s)


def _p_canonical(s: str) -> str:
    """The policy Collator recommends: NFKC + casefold + strip + NFC."""
    return unicodedata.normalize("NFC", unicodedata.normalize("NFKC", s).casefold().strip())


POLICIES: list[tuple[str, str, Policy]] = [
    ("python.lower", "str.lower()", _p_lower),
    ("python.casefold", "str.casefold()", _p_casefold),
    ("python.nfc", "unicodedata.normalize('NFC')", _p_nfc),
    ("python.nfkc", "unicodedata.normalize('NFKC')", _p_nfkc),
    ("python.canonical", "NFKC + casefold + strip + NFC", _p_canonical),
]


# ---------------------------------------------------------------------------
# Engine configurations (SQLite)
# ---------------------------------------------------------------------------


def _nfc_fold(a: str, b: str) -> int:
    """Case-insensitive, NFC-normalised.  The fix, demonstrated."""
    x = unicodedata.normalize("NFC", a).casefold()
    y = unicodedata.normalize("NFC", b).casefold()
    return (x > y) - (x < y)


def _nfkc_fold(a: str, b: str) -> int:
    """Aggressive canonicalisation: NFKC + casefold + strip."""
    x = unicodedata.normalize("NFKC", a).casefold().strip()
    y = unicodedata.normalize("NFKC", b).casefold().strip()
    return (x > y) - (x < y)


class EngineConfig:
    def __init__(self, id_: str, label: str, note: str, collate: str | None, custom: Policy | None):
        self.id = id_
        self.label = label
        self.note = note
        self.collate = collate
        self.custom = custom


SQLITE_CONFIGS: list[EngineConfig] = [
    EngineConfig(
        "sqlite/binary",
        "SQLite BINARY (default)",
        "Byte-for-byte comparison. This is what you get if you write nothing.",
        None,
        None,
    ),
    EngineConfig(
        "sqlite/nocase",
        "SQLite NOCASE",
        "Folds the 26 ASCII letters only. Non-ASCII case is untouched.",
        "NOCASE",
        None,
    ),
    EngineConfig(
        "sqlite/rtrim",
        "SQLite RTRIM",
        "Strips trailing spaces before comparing. Combines with the default byte comparison.",
        "RTRIM",
        None,
    ),
    EngineConfig(
        "sqlite/nfc_fold",
        "SQLite COLLATE NFC_FOLD (custom)",
        "Custom collation: NFC normalise, then casefold. Registered with create_collation().",
        "NFC_FOLD",
        _nfc_fold,
    ),
    EngineConfig(
        "sqlite/nfkc_fold",
        "SQLite COLLATE NFKC_FOLD (custom)",
        "Custom collation: NFKC normalise, casefold, strip. The widest net.",
        "NFKC_FOLD",
        _nfkc_fold,
    ),
]


def run_sqlite(config: EngineConfig, vector: dict[str, str]) -> dict[str, Any]:
    conn = sqlite3.connect(":memory:")
    try:
        if config.custom is not None:
            conn.create_collation(config.collate or "CUSTOM", config.custom)
        collate_sql = f" COLLATE {config.collate}" if config.collate else ""
        conn.execute(
            f"CREATE TABLE users (email TEXT PRIMARY KEY{collate_sql})"
        )
        conn.execute("INSERT INTO users (email) VALUES (?)", (vector["a"],))
        outcome = "COLLIDES"
        detail = "second insert rejected by UNIQUE constraint"
        try:
            conn.execute("INSERT INTO users (email) VALUES (?)", (vector["b"],))
            outcome = "DISTINCT"
            detail = "both rows accepted - two accounts for one identity"
        except sqlite3.IntegrityError as exc:
            detail = f"IntegrityError: {exc}"
        return {"outcome": outcome, "detail": detail}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Optional engines
# ---------------------------------------------------------------------------


DUCKDB_CONFIGS: list[EngineConfig] = [
    EngineConfig(
        "duckdb/default",
        "DuckDB (default)",
        "Exact comparison; DuckDB applies no case folding of its own.",
        None,
        None,
    ),
    EngineConfig(
        "duckdb/nocase",
        "DuckDB NOCASE",
        "Case-insensitive collation. Accent behaviour differs from SQLite NOCASE.",
        "NOCASE",
        None,
    ),
]


def run_duckdb(config: EngineConfig, vector: dict[str, str]) -> dict[str, Any]:
    import duckdb  # type: ignore

    con = duckdb.connect(":memory:")
    try:
        collate_sql = f" COLLATE {config.collate}" if config.collate else ""
        con.execute(
            f"CREATE TABLE users (email VARCHAR{collate_sql} UNIQUE)"
        )
        con.execute("INSERT INTO users VALUES (?)", (vector["a"],))
        try:
            con.execute("INSERT INTO users VALUES (?)", (vector["b"],))
            return {"outcome": "DISTINCT", "detail": "both rows accepted"}
        except Exception as exc:  # noqa: BLE001
            return {"outcome": "COLLIDES", "detail": str(exc).splitlines()[0]}
    finally:
        con.close()


def probe_duckdb_collation(config: EngineConfig) -> str | None:
    """Return an error string if this DuckDB build does not know the collation."""
    import duckdb  # type: ignore

    con = duckdb.connect(":memory:")
    try:
        collate_sql = f" COLLATE {config.collate}" if config.collate else ""
        con.execute(f"CREATE TABLE probe (email VARCHAR{collate_sql})")
        return None
    except Exception as exc:  # noqa: BLE001
        return str(exc).splitlines()[0]
    finally:
        con.close()


def probe_optional_engines() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (engines, unavailable) for non-SQLite engines."""
    engines: list[dict[str, Any]] = []
    unavailable: list[dict[str, Any]] = []

    try:
        import duckdb  # type: ignore

        engines.extend(
            {
                "id": cfg.id,
                "engine": "DuckDB",
                "version": duckdb.__version__,
                "label": cfg.label,
                "note": cfg.note,
                "kind": "duckdb",
                "collation": cfg.collate,
            }
            for cfg in DUCKDB_CONFIGS
        )
    except ModuleNotFoundError:
        unavailable.append(
            {
                "engine": "DuckDB",
                "tier": "UNAVAILABLE",
                "reason": "driver not installed",
                "remediation": "pip install duckdb",
            }
        )
    except Exception as exc:  # noqa: BLE001
        # Installed but unloadable (e.g. a host Application Control policy
        # blocking the native library).  Report the real reason; do not pretend
        # it is a missing package, and do not attempt to bypass the policy.
        unavailable.append(
            {
                "engine": "DuckDB",
                "tier": "UNAVAILABLE",
                "reason": f"driver present but failed to load: {exc}",
                "remediation": (
                    "cannot be remediated from this project - the host blocks the "
                    "native library. The claim stays in the DOCUMENTED tier."
                ),
            }
        )

    # Passive reachability check - a bare TCP connect, no protocol, no auth.
    for name, port, remediation in (
        ("MySQL", 3306, "supply credentials via MYSQL_* env vars to run the PAD SPACE vectors"),
        ("PostgreSQL", 5432, "supply credentials via PG* env vars to run the ICU collation vectors"),
        ("SQL Server", 1433, "no local server detected"),
    ):
        detected = False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                detected = True
        except OSError:
            detected = False
        unavailable.append(
            {
                "engine": name,
                "tier": "DOCUMENTED" if detected else "UNAVAILABLE",
                "reason": (
                    f"server listening on 127.0.0.1:{port}, but no credentials configured"
                    if detected
                    else f"no server reachable on 127.0.0.1:{port}"
                ),
                "remediation": remediation,
                "port": port,
                "detected": detected,
            }
        )

    return engines, unavailable


# ---------------------------------------------------------------------------
# Codepoint introspection - the UI needs to show *why* two strings differ
# ---------------------------------------------------------------------------


def codepoints(s: str) -> list[dict[str, str]]:
    out = []
    for ch in s:
        out.append(
            {
                "char": ch,
                "hex": f"U+{ord(ch):04X}",
                "name": unicodedata.name(ch, "<unnamed>"),
                "category": unicodedata.category(ch),
            }
        )
    return out


def main() -> int:
    # Windows consoles default to a legacy code page; the report contains
    # combining marks and non-Latin code points, so force UTF-8 output.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Collator execution oracle")
    parser.add_argument("--vector", help="run a single vector id")
    parser.add_argument("--pair", nargs=2, metavar=("A", "B"), help="check one ad hoc pair instead of the suite")
    parser.add_argument("--indent", type=int, default=0, help="pretty-print JSON")
    args = parser.parse_args()

    if args.pair:
        vectors = [
            {
                "id": "adhoc",
                "klass": "adhoc",
                "label": "Ad hoc pair",
                "a": args.pair[0],
                "b": args.pair[1],
                "why": "A pair supplied at run time rather than part of the fixed suite.",
            }
        ]
    else:
        vectors = [v for v in VECTORS if not args.vector or v["id"] == args.vector]
    if not vectors:
        print(json.dumps({"error": f"no such vector: {args.vector}"}))
        return 2

    # --- engine inventory -------------------------------------------------
    engines: list[dict[str, Any]] = [
        {
            "id": cfg.id,
            "engine": "SQLite",
            "version": sqlite3.sqlite_version,
            "label": cfg.label,
            "note": cfg.note,
            "kind": "sqlite",
            "collation": cfg.collate,
        }
        for cfg in SQLITE_CONFIGS
    ]
    optional, unavailable = probe_optional_engines()
    engines.extend(optional)

    # --- execute ----------------------------------------------------------
    results: list[dict[str, Any]] = []

    def execute(
        cfg: EngineConfig,
        runner: Callable[[EngineConfig, dict[str, str]], dict[str, Any]],
    ) -> None:
        for vector in vectors:
            try:
                r = runner(cfg, vector)
                results.append(
                    {
                        "engineId": cfg.id,
                        "vectorId": vector["id"],
                        "tier": "EXECUTED",
                        **r,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                results.append(
                    {
                        "engineId": cfg.id,
                        "vectorId": vector["id"],
                        "tier": "UNAVAILABLE",
                        "outcome": "ERROR",
                        "detail": f"{type(exc).__name__}: {exc}",
                    }
                )

    for cfg in SQLITE_CONFIGS:
        execute(cfg, run_sqlite)

    if any(e["kind"] == "duckdb" for e in engines):
        for cfg in DUCKDB_CONFIGS:
            problem = probe_duckdb_collation(cfg)
            if problem is None:
                execute(cfg, run_duckdb)
            else:
                results.append(
                    {
                        "engineId": cfg.id,
                        "vectorId": "*",
                        "tier": "UNAVAILABLE",
                        "outcome": "ERROR",
                        "detail": f"collation not supported by this DuckDB build: {problem}",
                    }
                )

    # --- application-side policies ---------------------------------------
    policies: list[dict[str, Any]] = []
    for pid, label, fn in POLICIES:
        for vector in vectors:
            try:
                same = fn(vector["a"]) == fn(vector["b"])
                policies.append(
                    {
                        "policyId": pid,
                        "label": label,
                        "vectorId": vector["id"],
                        "equal": same,
                        "normalizedA": fn(vector["a"]),
                        "normalizedB": fn(vector["b"]),
                        "tier": "EXECUTED",
                    }
                )
            except Exception as exc:  # noqa: BLE001
                policies.append(
                    {
                        "policyId": pid,
                        "label": label,
                        "vectorId": vector["id"],
                        "equal": None,
                        "tier": "UNAVAILABLE",
                        "detail": f"{type(exc).__name__}: {exc}",
                    }
                )

    report = {
        "tool": "collator-oracle",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "runtime": {
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
            "implementation": platform.python_implementation(),
            "platform": platform.platform(),
        },
        "vectors": [
            {**v, "codepointsA": codepoints(v["a"]), "codepointsB": codepoints(v["b"])}
            for v in vectors
        ],
        "engines": engines,
        "results": results,
        "policies": policies,
        "unavailable": unavailable,
    }
    print(json.dumps(report, indent=args.indent, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
