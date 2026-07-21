#!/usr/bin/env node
/**
 * Fork-channel publisher for @pgxsinkit/pglite (see the pgxsinkit runbook
 * "temporary @electric-sql/pglite fork override").
 *
 *   pnpm publish:pgx:gh    build and publish the current -pgx version to
 *                          GitHub Packages (the canonical build output)
 *   pnpm publish:pgx:npm   download the exact GitHub Packages tarball for the
 *                          current version and republish it byte-identical to
 *                          public npm under dist-tag `pgx`
 *
 * Auth comes from the gitignored npmrc files in <repo>/tmp/agents/:
 *   npmrc-ghpackages  @pgxsinkit:registry=https://npm.pkg.github.com
 *                     //npm.pkg.github.com/:_authToken=<PAT packages:write>
 *   npmrc-npmjs       //registry.npmjs.org/:_authToken=<npm token>
 *
 * pnpm honors NPM_CONFIG_USERCONFIG (bun does not — do not port this to bun).
 * publishConfig must never contain a `registry` key: routing lives here, and
 * an embedded registry would make the tarball unmirrorable.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(PACKAGE_DIR, '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'tmp', 'agents')
const GH_REGISTRY = 'https://npm.pkg.github.com'
const NPM_REGISTRY = 'https://registry.npmjs.org'

function fail(message) {
  console.error(`publish-pgx: ${message}`)
  process.exit(1)
}

function readManifest() {
  const manifest = JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
  )
  if (manifest.name !== '@pgxsinkit/pglite') {
    fail(`unexpected package name ${manifest.name}`)
  }
  if (!/-pgx\.\d+$/.test(manifest.version)) {
    fail(
      `version ${manifest.version} has no -pgx.N suffix — refusing to publish an upstream-shaped version`,
    )
  }
  if (manifest.publishConfig?.registry !== undefined) {
    fail(
      'publishConfig.registry is set — remove it; registry routing must stay in the publish-time npmrc',
    )
  }
  return manifest
}

function userconfig(name) {
  const path = join(AGENTS_DIR, name)
  if (!existsSync(path)) {
    fail(`missing ${path} — see the fork runbook's auth prerequisites`)
  }
  return path
}

function ghToken() {
  const line = readFileSync(userconfig('npmrc-ghpackages'), 'utf8')
    .split('\n')
    .find((entry) => entry.includes('npm.pkg.github.com/:_authToken='))
  if (!line) fail('npmrc-ghpackages has no GitHub Packages auth token line')
  return line.split('_authToken=')[1].trim()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_DIR,
    stdio: 'inherit',
    ...options,
  })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

async function registryDocument(registry, token) {
  const response = await fetch(`${registry}/@pgxsinkit%2fpglite`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    fail(`${registry} responded ${response.status} for the package document`)
  }
  return response.json()
}

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex')
}

async function publishGithubPackages(manifest) {
  console.log(`building ${manifest.name}@${manifest.version}…`)
  run('pnpm', ['build:js'])
  console.log('publishing to GitHub Packages (dist-tag pgx)…')
  run('pnpm', ['publish', '--tag', 'pgx', '--no-git-checks'], {
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: userconfig('npmrc-ghpackages'),
    },
  })
  const doc = await registryDocument(GH_REGISTRY, ghToken())
  const dist = doc.versions?.[manifest.version]?.dist
  if (!dist) fail(`GitHub Packages does not list ${manifest.version} after publish`)
  console.log(`GitHub Packages has ${manifest.version} shasum ${dist.shasum}`)
  console.log(`next: pnpm publish:pgx:npm`)
}

async function mirrorToNpm(manifest) {
  const token = ghToken()
  const doc = await registryDocument(GH_REGISTRY, token)
  const dist = doc.versions?.[manifest.version]?.dist
  if (!dist) {
    fail(
      `GitHub Packages does not list ${manifest.version} — run pnpm publish:pgx:gh first`,
    )
  }
  console.log(`downloading exact tarball ${dist.tarball}…`)
  const response = await fetch(dist.tarball, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) fail(`tarball download responded ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const localShasum = sha1(bytes)
  if (localShasum !== dist.shasum) {
    fail(
      `downloaded tarball shasum ${localShasum} does not match GitHub Packages ${dist.shasum}`,
    )
  }
  mkdirSync(AGENTS_DIR, { recursive: true })
  const tarballPath = join(AGENTS_DIR, `pglite-${manifest.version}.tgz`)
  writeFileSync(tarballPath, bytes)
  console.log(`verified ${tarballPath} (${dist.shasum}); publishing to npm…`)
  // bun uploads the tarball bytes verbatim — pnpm/npm would re-pack the
  // source directory and destroy byte-identity (observed on 0.5.4-pgx.7:
  // unrewritten manifest, dropped LICENSE). bun reads auth from ~/.npmrc
  // only, so the npm token must live there, not in tmp/agents/npmrc-npmjs.
  run('bun', ['publish', tarballPath, '--tag', 'pgx', '--access', 'public'])
  let npmDoc
  let npmDist
  for (let attempt = 0; attempt < 10; attempt += 1) {
    npmDoc = await registryDocument(NPM_REGISTRY)
    npmDist = npmDoc.versions?.[manifest.version]?.dist
    if (npmDist) break
    // The registry read path can lag the accepted publish by a few seconds.
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  if (!npmDist) fail(`npm does not list ${manifest.version} after publish`)
  if (npmDist.shasum !== dist.shasum) {
    fail(
      `npm shasum ${npmDist.shasum} does not match GitHub Packages ${dist.shasum} — the mirror is NOT byte-identical`,
    )
  }
  console.log(
    `npm has ${manifest.version} byte-identical (${npmDist.shasum}); dist-tags: ${JSON.stringify(npmDoc['dist-tags'])}`,
  )
}

const mode = process.argv[2]
const manifest = readManifest()
if (mode === 'gh') {
  await publishGithubPackages(manifest)
} else if (mode === 'npm') {
  await mirrorToNpm(manifest)
} else {
  fail('usage: publish-pgx.mjs <gh|npm>')
}
