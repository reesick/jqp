// Builds everything the Oracle VM needs into dist/dm-host/ as three small files plus the
// service definitions. The VM then needs only Node, not the repository or its 800 MB of packages.
//
//   npm run bundle-dm-worker
//
// vendor/openreply is not modified; it is compiled as it is.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "dm-host");
mkdirSync(out, { recursive: true });

// ESM output needs `require` for the few CommonJS packages inside the bundle.
const banner = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

async function bundle(entry: string, file: string, tsconfig: string): Promise<void> {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, file),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    tsconfig: join(root, tsconfig),
    banner: { js: banner },
    logLevel: "warning"
  });
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  await bundle("vendor/openreply/worker/dm-worker.ts", "dm-worker.mjs", "vendor/openreply/tsconfig.json");
  await bundle("ops/dm-worker/selfcheck.ts", "selfcheck.mjs", "vendor/openreply/tsconfig.json");
  await bundle("ops/vm/vm-guard.ts", "vm-guard.mjs", "tsconfig.base.json");

  for (const f of ["install.sh", "jqp-ctl.sh", "jqp-dm-worker.service", "jqp-vm-guard.service", "jqp-vm-guard.timer", "jqp-halt.path", "jqp-halt.service"]) {
    // Always LF: a Windows checkout can turn these into CRLF, which Linux cannot run.
    writeFileSync(join(out, f), readFileSync(join(root, "ops", "vm", f), "utf8").replace(/\r\n/g, "\n"));
  }
  const dirty = git("status", "--porcelain", "--", "vendor", "ops", "packages") ? "+uncommitted" : "";
  writeFileSync(join(out, "VERSION"), `${git("rev-parse", "--short", "HEAD")}${dirty} built ${new Date().toISOString()}\n`);

  for (const name of readdirSync(out).sort()) {
    console.log(`${name.padEnd(28)} ${(statSync(join(out, name)).size / 1024).toFixed(0).padStart(6)} KB`);
  }
  console.log(`\nWrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
