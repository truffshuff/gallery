"""Fork-only CI probe: mutate the runner checkout, never a published source commit."""

import difflib
import hashlib
import os
from pathlib import Path
import re
import subprocess


root = Path(__file__).resolve().parents[2]
source = root / "server/src/gallery/utils/asset-edit-ready.ts"
matrix = root / "server/test/medium/specs/gallery/asset-edit-ready-role-matrix.spec.ts"
evidence = root / "mutation-evidence"
evidence.mkdir(exist_ok=True)
original = source.read_text()
guard = "  if (!allowed.has(data.asset.id)) {\n    return;\n  }\n"
assert original.count(guard) == 1, "Expected exactly one completion read guard"
assert original.count("const allowed = await checkAccess(") == 1
mutated = original.replace("const allowed = await checkAccess(", "await checkAccess(").replace(guard, "")
command = [
    "mise", "exec", "--", "pnpm", "--dir", "server", "exec", "vitest",
    "--config", "test/vitest.config.medium.mjs", "run",
    "test/medium/specs/gallery/asset-edit-ready-role-matrix.spec.ts",
]


def run(phase: str) -> tuple[int, str]:
    print(f"Running {phase} database matrix", flush=True)
    result = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (evidence / f"{phase}.log").write_text(result.stdout)
    clean = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
    print(clean[-6000:], flush=True)
    return result.returncode, clean


baseline_code, _ = run("baseline")
assert baseline_code == 0, "Guarded database baseline must pass before mutation"
(evidence / "guard-removal.diff").write_text("".join(difflib.unified_diff(
    original.splitlines(keepends=True), mutated.splitlines(keepends=True),
    fromfile="guarded/asset-edit-ready.ts", tofile="runner-only-mutant/asset-edit-ready.ts",
)))
try:
    source.write_text(mutated)
    mutant_code, mutant_log = run("mutant")
finally:
    source.write_text(original)

# A setup/container/import failure does not count as detecting the authorization bug.
assert mutant_code == 1, "The unguarded matrix must fail"
assert all(text in mutant_log for text in ["AssertionError", "owner/false/", "11000000", "11111110"]), (
    "Mutation must fail on the hand-authored authorization outcome grid"
)
restored_code, _ = run("restored")
assert restored_code == 0, "Restored guard must pass the same database matrix"
assert source.read_text() == original
assert subprocess.run(["git", "diff", "--exit-code", "--", str(source)], cwd=root).returncode == 0
summary = (
    "## Edit-ready database mutation check\n\n"
    "- Guarded baseline: PASS (160 combinations)\n"
    "- Guard removed in runner: correctly FAILS (expected 11000000, received 11111110)\n"
    "- Guard restored: PASS (160 combinations)\n"
    "- Published application source retains the guard.\n\n"
    f"Guarded module SHA256: `{hashlib.sha256(original.encode()).hexdigest()}`\n\n"
    f"Matrix SHA256: `{hashlib.sha256(matrix.read_bytes()).hexdigest()}`\n"
)
(evidence / "summary.md").write_text(summary)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary)
print(summary)
