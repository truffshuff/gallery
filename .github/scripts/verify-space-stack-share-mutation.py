"""Fork-only database verification. Mutants exist only in the disposable runner checkout."""

import difflib
import hashlib
import os
from pathlib import Path
import re
import subprocess


root = Path(__file__).resolve().parents[2]
access = root / "server/src/gallery/utils/access-grants.ts"
service = root / "server/src/services/shared-space.service.ts"
matrix = "test/medium/specs/gallery/space-add-stack-share-matrix.medium.spec.ts"
evidence = root / "mutation-evidence"
evidence.mkdir(exist_ok=True)
originals = {path: path.read_text() for path in [access, service]}
command = [
    "mise", "exec", "--", "pnpm", "--dir", "server", "exec", "vitest",
    "--config", "test/vitest.config.medium.mjs", "run", matrix,
    "test/medium/specs/services/shared-space-stacks.spec.ts",
]


def run(phase: str) -> tuple[int, str]:
    print(f"Running {phase}", flush=True)
    result = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (evidence / f"{phase}.log").write_text(result.stdout)
    clean = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
    print(clean[-8000:], flush=True)
    return result.returncode, clean


baseline_code, _ = run("guarded-baseline")
assert baseline_code == 0, "The guarded database matrix and existing stack regressions must pass first"

explicit_gate = (
    "  if (assetIds.some((id) => !allowed.has(id))) {\n"
    "    throw new BadRequestException(`Not found or no ${Permission.AssetShare} access`);\n"
    "  }\n"
)
sibling_filter = "return [...ids].filter((id) => allowed.has(id));"
role_gate = (
    "  async addAssets(auth: AuthDto, spaceId: string, dto: SharedSpaceAssetAddDto): Promise<void> {\n"
    "    await this.requireRole(auth, spaceId, SharedSpaceRole.Editor);"
)
assert originals[access].count(explicit_gate) == 1
assert originals[access].count(sibling_filter) == 1
assert originals[service].count(role_gate) == 1
base = "ca0ec8871be65b5060770020fc7f41d95287f47a"

mutations = [
    (
        "original-bug",
        {path: subprocess.check_output(["git", "show", f"{base}:{path.relative_to(root)}"], cwd=root, text=True) for path in originals},
        ["automatic sibling: archive", "Not found or no asset.share access"],
    ),
    (
        "explicit-gate-removed",
        {access: originals[access].replace(explicit_gate, "")},
        ["explicit sibling: archive", "promise resolved"],
    ),
    (
        "sibling-filter-removed",
        {access: originals[access].replace(sibling_filter, "return [...ids];")},
        ["automatic sibling: archive", "AssertionError"],
    ),
    (
        "space-role-gate-removed",
        {service: originals[service].replace(role_gate, role_gate.split("\n")[0])},
        ["role: viewer", "role: outsider", "role: admin", "promise resolved"],
    ),
]

for name, changes, markers in mutations:
    diffs = []
    try:
        for path, mutated in changes.items():
            diffs.extend(difflib.unified_diff(
                originals[path].splitlines(keepends=True), mutated.splitlines(keepends=True),
                fromfile=f"guarded/{path.name}", tofile=f"runner-only-{name}/{path.name}",
            ))
            path.write_text(mutated)
        (evidence / f"{name}.diff").write_text("".join(diffs))
        code, log = run(name)
        assert code == 1 and "AssertionError" in log and all(marker in log for marker in markers), (
            f"{name} must fail behavioral assertions; setup/import failures do not count"
        )
    finally:
        for path, original in originals.items():
            path.write_text(original)

restored_code, _ = run("guarded-restored")
assert restored_code == 0, "The restored database matrix must pass"
assert all(path.read_text() == original for path, original in originals.items())
assert subprocess.run(["git", "diff", "--exit-code", "--", *map(str, originals)], cwd=root).returncode == 0
summary = (
    "## Partner stack Space-add verification\n\n"
    "- Guarded database matrix: PASS (135 authorization cells plus boundary and stack regressions)\n"
    "- Pre-fix source: original archived-partner-sibling failure reproduced\n"
    "- Explicit-selection gate removed: correctly FAILS\n"
    "- Automatic-sibling filter removed: correctly FAILS\n"
    "- Space-role gate removed: correctly FAILS\n"
    "- Guarded source restored: PASS\n"
    "- Published application source retains all guards.\n\n"
    f"Matrix SHA256: `{hashlib.sha256((root / 'server' / matrix).read_bytes()).hexdigest()}`\n"
)
(evidence / "summary.md").write_text(summary)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary)
