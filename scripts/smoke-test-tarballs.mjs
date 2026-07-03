#!/usr/bin/env node
/**
 * Install the packed tarballs into a throwaway npm-only project the way a real
 * consumer would (react/react-dom aliased to the fork, scheduler overridden),
 * then render through the fork: mount a component that reads an atom via
 * useSignal, write urgently, and write inside startSignalTransition.
 *
 * This catches what workspace tests can't: broken tarball contents, wrong
 * scheduler resolution, fork/peer version mismatches, missing dist files.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values: options, positionals } = parseArgs({
  options: {
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
})

if (options.help || positionals.length !== 1) {
  console.log("Usage: node scripts/smoke-test-tarballs.mjs <tarball-dir> [--keep]")
  process.exit(options.help ? 0 : 1)
}

const tarballDir = resolve(positionals[0])
const manifest = JSON.parse(readFileSync(join(tarballDir, "publish-manifest.json"), "utf8"))

function tarball(name) {
  const entry = manifest.find((item) => item.name === name)
  if (!entry) throw new Error(`No ${name} tarball in publish-manifest.json`)
  return join(tarballDir, entry.filename)
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`)
  }
}

const workDir = mkdtempSync(join(tmpdir(), "cosignal-tarball-smoke-"))

const smokeScript = `
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
globalThis.window = dom.window
globalThis.document = dom.window.document

const React = (await import("react")).default
const { createRoot } = await import("react-dom/client")
const { Atom, useSignal, startSignalTransition } = await import("cosignal")

// The fork's external-runtime channel must be present — this is what
// distinguishes @jitl/react from upstream.
assert.equal(typeof React.unstable_subscribeToExternalRuntime, "function")
assert.equal(typeof React.unstable_getCurrentWriteBatch, "function")

// react-dom must have resolved the *fork* scheduler, not upstream's.
const schedulerPackage = JSON.parse(readFileSync("./node_modules/scheduler/package.json", "utf8"))
assert.equal(schedulerPackage.name, "@jitl/scheduler")
assert.match(schedulerPackage.version, /-cosignal\\./)

const atom = new Atom({ state: "initial" })
function App() {
  return React.createElement("span", null, useSignal(atom))
}

const container = document.createElement("div")
document.body.appendChild(container)
createRoot(container).render(React.createElement(App))

async function waitForText(expected) {
  const deadline = Date.now() + 5000
  while (container.textContent !== expected) {
    if (Date.now() > deadline) {
      throw new Error(\`Timed out waiting for "\${expected}"; got "\${container.textContent}"\`)
    }
    await new Promise((fulfill) => setTimeout(fulfill, 10))
  }
}

await waitForText("initial")
atom.set("urgent")
await waitForText("urgent")
startSignalTransition(() => atom.set("transition"))
await waitForText("transition")

console.log("Tarball smoke test passed.")
process.exit(0)
`

writeFileSync(
  join(workDir, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: {
        react: `file:${tarball("@jitl/react")}`,
        "react-dom": `file:${tarball("@jitl/react-dom")}`,
        cosignal: `file:${tarball("cosignal")}`,
        jsdom: "^26.0.0",
      },
      // A published consumer aliases via the registry ("npm:@jitl/..."); at
      // smoke time these versions aren't on the registry yet, so point the
      // same override at the local tarball instead.
      overrides: {
        scheduler: `file:${tarball("@jitl/scheduler")}`,
      },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(workDir, "smoke.mjs"), smokeScript)

try {
  run("npm", ["install", "--no-audit", "--no-fund"], workDir)
  run("node", ["smoke.mjs"], workDir)
} finally {
  if (options.keep) {
    console.log(`Keeping smoke-test project at ${workDir}`)
  } else {
    rmSync(workDir, { recursive: true, force: true })
  }
}
