#!/usr/bin/env node
/**
 * Stage and pack the publishable tarballs:
 *
 *   cosignal@<version>          from packages/cosignal/dist (build first)
 *   @jitl/react@<base>-cosignal.<version>       from vendor/react build output
 *   @jitl/react-dom@<base>-cosignal.<version>
 *   @jitl/scheduler@<base>-cosignal.<version>
 *
 * <base> is each built package's own major.minor.patch (react/react-dom 19.x,
 * scheduler 0.28.x), so the upstream base stays visible and every cosignal
 * version pairs with exactly one fork build.
 *
 * The fork packages keep their upstream names *inside* the bundles
 * (require('scheduler') etc.), so interlinking uses npm aliases: react-dom
 * depends on "scheduler": "npm:@jitl/scheduler@<exact>". Consumers only
 * override the names their code imports:
 *
 *   "overrides": {
 *     "react": "npm:@jitl/react@19.3.0-cosignal.X",
 *     "react-dom": "npm:@jitl/react-dom@19.3.0-cosignal.X"
 *   }
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const usage = `Usage: node scripts/prepare-npm-tarballs.mjs --version <cosignal-version> [options]

Options:
  --version <semver>    Version for cosignal; stamped into the fork versions. Required.
  --out <dir>           Output directory for tarballs. Default: npm-tarballs
  --repository <url>    Repository URL for package.json (CI passes the building
                        repo so npm provenance verification succeeds). Omitted
                        from staged packages when not provided.`

const { values: options } = parseArgs({
  options: {
    version: { type: "string" },
    out: { type: "string", default: "npm-tarballs" },
    repository: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
})

if (options.help) {
  console.log(usage)
  process.exit(0)
}

if (!options.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(options.version)) {
  console.error(`Missing or invalid --version: ${options.version ?? "(none)"}\n\n${usage}`)
  process.exit(1)
}

const SCOPE = "@jitl"
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")
const reactBuildDir = join(repoRoot, "vendor", "react", "build", "oss-experimental")
const cosignalDir = join(repoRoot, "packages", "cosignal")
const outDir = resolve(options.out)
const stagingDir = join(outDir, ".staging")

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function forkVersion(builtVersion) {
  const base = builtVersion.split("-")[0]
  return `${base}-cosignal.${options.version}`
}

function stageForkPackage(pkg, mutate) {
  const srcDir = join(reactBuildDir, pkg)
  if (!existsSync(srcDir)) {
    throw new Error(`Missing ${srcDir}; run scripts/build-react.sh first`)
  }

  const stageDir = join(stagingDir, pkg)
  cpSync(srcDir, stageDir, {
    recursive: true,
    // Exclude the symlink fixup dir build-react.sh creates for local linking.
    filter: (src) => !src.includes(`${pkg}/node_modules`),
  })

  const packageJsonPath = join(stageDir, "package.json")
  const packageJson = readJson(packageJsonPath)
  packageJson.name = `${SCOPE}/${pkg}`
  packageJson.version = forkVersion(packageJson.version)
  delete packageJson.private
  if (options.repository) {
    packageJson.repository = { type: "git", url: `git+${options.repository}.git` }
  } else {
    delete packageJson.repository
  }
  mutate?.(packageJson)
  writeJson(packageJsonPath, packageJson)
  return { dir: stageDir, name: packageJson.name, version: packageJson.version }
}

function stageCosignal(forkVersions) {
  if (!existsSync(join(cosignalDir, "dist", "index.js"))) {
    throw new Error(`Missing ${cosignalDir}/dist; run pnpm --filter cosignal build first`)
  }

  const stageDir = join(stagingDir, "cosignal")
  mkdirSync(stageDir, { recursive: true })
  cpSync(join(cosignalDir, "dist"), join(stageDir, "dist"), { recursive: true })
  for (const extra of ["README.md", "LICENSE"]) {
    if (existsSync(join(cosignalDir, extra))) {
      cpSync(join(cosignalDir, extra), join(stageDir, extra))
    }
  }

  const packageJson = readJson(join(cosignalDir, "package.json"))
  delete packageJson.private
  delete packageJson.scripts
  delete packageJson.devDependencies
  packageJson.version = options.version
  packageJson.files = ["dist"]
  packageJson.exports = Object.fromEntries(
    Object.entries(packageJson.exports).map(([key, value]) => {
      const stem = value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "")
      return [key, { types: `${stem}.d.ts`, default: `${stem}.js` }]
    }),
  )
  if (options.repository) {
    packageJson.repository = {
      type: "git",
      url: `git+${options.repository}.git`,
      directory: "packages/cosignal",
    }
  }
  // The hooks require the fork's external-runtime channel; record the paired
  // build. Kept alongside a permissive "react": "*" peer because consumers
  // install the fork *aliased as* react/react-dom via overrides, and a
  // prerelease-pinned peer range would fight that aliasing in npm's resolver.
  packageJson.cosignal = { pairedReact: forkVersions }
  writeJson(join(stageDir, "package.json"), packageJson)
  return { dir: stageDir, name: packageJson.name, version: packageJson.version }
}

function pack(staged) {
  const result = spawnSync("npm", ["pack", "--pack-destination", outDir, "--json"], {
    cwd: staged.dir,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${staged.name}:\n${result.stderr}`)
  }
  const [info] = JSON.parse(result.stdout)
  return { name: staged.name, version: staged.version, filename: info.filename }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(stagingDir, { recursive: true })

const scheduler = stageForkPackage("scheduler")
const react = stageForkPackage("react")
const reactDom = stageForkPackage("react-dom", (packageJson) => {
  // Bundles require('scheduler') by literal specifier; alias it to the fork.
  packageJson.dependencies.scheduler = `npm:${scheduler.name}@${scheduler.version}`
  // Upstream's peer range "^19.3.0" excludes prereleases; pin the paired fork
  // build exactly (the consumer's aliased react reports this version).
  packageJson.peerDependencies.react = react.version
})
const cosignal = stageCosignal({
  react: react.version,
  "react-dom": reactDom.version,
  scheduler: scheduler.version,
})

// Publish order: dependencies before dependents.
const manifest = [scheduler, react, reactDom, cosignal].map(pack)
writeJson(join(outDir, "publish-manifest.json"), manifest)
rmSync(stagingDir, { recursive: true, force: true })

console.log("Packed:")
for (const entry of manifest) {
  console.log(`  ${entry.name}@${entry.version} -> ${entry.filename}`)
}
