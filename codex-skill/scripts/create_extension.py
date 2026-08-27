#!/usr/bin/env python3
"""Copy the bundled bilingual browser-extension template to a new directory."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an experimental English-Chinese browser extension."
    )
    parser.add_argument(
        "--target",
        required=True,
        type=Path,
        help="New or empty output directory for the extension project.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    template = Path(__file__).resolve().parent.parent / "assets" / "extension-template"
    target = args.target.expanduser().resolve()

    if not template.is_dir():
        print(f"Template directory is missing: {template}", file=sys.stderr)
        return 2

    if target.exists() and any(target.iterdir()):
        print(f"Refusing to overwrite non-empty directory: {target}", file=sys.stderr)
        return 3

    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, target, dirs_exist_ok=True)

    files = sorted(path.relative_to(target).as_posix() for path in target.rglob("*") if path.is_file())
    print(f"Created bilingual browser extension at: {target}")
    for file in files:
        print(f"  {file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
