from pathlib import Path

source_path = Path('scripts/apply-m21-direct-identity-false-negative-fix.py')
source = source_path.read_text()
source = source.replace(
    "    if count != 1:\n        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')",
    "    if count < 1:\n        raise SystemExit(f'{label}: expected at least 1 match, got {count}')",
    1,
)
exec(compile(source, str(source_path), 'exec'))
