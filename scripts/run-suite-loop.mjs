// Run a vitest file N times consecutively, capture each run's full output to
// a log file, and print a per-run verdict. Avoids shell quoting pitfalls.
// Usage: node scripts/run-suite-loop.mjs <runs> <testFile> [testNamePattern]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 10);
const file = process.argv[3] ?? "tests/p2c-garage-search.test.ts";
const namePattern = process.argv[4] ?? "";

const args = ["run", file, "--reporter=basic"];
if (namePattern) args.push("-t", namePattern);
// Windows .cmd shims are not directly spawnable; invoke the JS entry with node.
const cmd = process.execPath;
const vitestArgs = ["node_modules/vitest/vitest.mjs", ...args];

let passed = 0;
let failed = 0;
let spawnErr = "";
for (let i = 1; i <= N; i++) {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(cmd, vitestArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    spawnErr = `${e?.name}: ${e?.message} status=${e?.status} signal=${e?.signal}`;
  }
  const m = out.match(/Tests\s+(\d+) passed(?: \| (\d+) failed)?/);
  const verdict = code === 0 ? "PASS" : "FAIL";
  if (code === 0) passed++;
  else failed++;
  const errLine = out.split("\n").find((l) => /write conflict|AssertionError|22P02|Unique constraint|expected/.test(l));
  console.log(`run ${i}: ${verdict} ${m ? `(Tests ${m[1]} passed${m[2] ? ` | ${m[2]} failed` : ""})` : ""} ${errLine ? "ERR: " + errLine.trim().slice(0, 70) : ""} ${code !== 0 && !errLine && !m ? "| spawn: " + (spawnErr || "no-spawn-error, exit=" + code) : ""}`);
  mkdirSync("tmp-loop-logs", { recursive: true });
  writeFileSync(`tmp-loop-logs/run-${i}.log`, out);
}
console.log(`\nSUMMARY: ${passed}/${N} passed, ${failed}/${N} failed`);
process.exit(failed === 0 ? 0 : 1);
