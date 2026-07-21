#!/usr/bin/env node
// Regenerates dependencies.manifest.json by resolving the pinned third-party artifacts from
// their official vendor sources, verifying them, and recording sha256 checksums.
//
//   node scripts/update-dependency-manifest.mjs [javaVersion]
//
// - Java: BellSoft Liberica JRE 11 (LTS). Download URLs + vendor sha1 come from the BellSoft
//   API; each artifact is downloaded, its sha1 verified, and its sha256 recorded.
// - Gateway: IB Client Portal Gateway. IB publishes no checksum, so we download over HTTPS from
//   the official host, record the sha256, and capture the live Akamai ETag MD5 for cross-checks.
//
// This is a maintainer tool. It is not shipped and not run at install/runtime.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, '..', 'dependencies.manifest.json');

const GATEWAY_URL = 'https://download2.interactivebrokers.com/portal/clientportal.gw.zip';
const GATEWAY_HOST = 'download2.interactivebrokers.com';

// platformKey -> BellSoft API selector (os, architecture, bitness, packageType)
const JAVA_TARGETS = {
  'darwin-arm64': { os: 'macos', architecture: 'arm', bitness: 64, packageType: 'tar.gz' },
  'darwin-x64': { os: 'macos', architecture: 'x86', bitness: 64, packageType: 'tar.gz' },
  'linux-x64': { os: 'linux', architecture: 'x86', bitness: 64, packageType: 'tar.gz' },
  'linux-arm64': { os: 'linux', architecture: 'arm', bitness: 64, packageType: 'tar.gz' },
  'linux-x64-musl': { os: 'linux-musl', architecture: 'x86', bitness: 64, packageType: 'tar.gz' },
  'linux-arm64-musl': { os: 'linux-musl', architecture: 'arm', bitness: 64, packageType: 'tar.gz' },
  'win32-x64': { os: 'windows', architecture: 'x86', bitness: 64, packageType: 'zip' },
};

function semverKey(v) {
  // "11.0.31+11" -> comparable tuple
  const [main, build = '0'] = v.split('+');
  return [...main.split('.').map(Number), Number(build)];
}

function cmp(a, b) {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

async function fetchBuffer(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function resolveJava(requestedVersion) {
  console.log('• Querying BellSoft Liberica JRE 11 releases…');
  const res = await fetch(
    'https://api.bell-sw.com/v1/liberica/releases?version-feature=11&bundle-type=jre&release-type=lts&bitness=64',
  );
  if (!res.ok) throw new Error(`BellSoft API HTTP ${res.status}`);
  const releases = await res.json();

  const version =
    requestedVersion ||
    releases.map((r) => r.version).sort(cmp).at(-1);
  console.log(`  using version ${version}`);

  const platforms = {};
  for (const [platformKey, sel] of Object.entries(JAVA_TARGETS)) {
    const match = releases.find(
      (r) =>
        r.version === version &&
        r.os === sel.os &&
        r.architecture === sel.architecture &&
        r.bitness === sel.bitness &&
        r.packageType === sel.packageType,
    );
    if (!match) throw new Error(`No BellSoft artifact for ${platformKey} @ ${version}`);

    console.log(`  ↓ ${platformKey}: ${match.filename}`);
    const { buffer } = await fetchBuffer(match.downloadUrl);
    const sha1 = createHash('sha1').update(buffer).digest('hex');
    if (sha1 !== match.sha1) {
      throw new Error(`sha1 mismatch for ${match.filename}: vendor ${match.sha1}, got ${sha1}`);
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    platforms[platformKey] = { url: match.downloadUrl, archive: sel.packageType, sha256 };
    console.log(`    ✓ sha1 verified, sha256=${sha256}`);
  }

  return {
    vendor: 'bellsoft-liberica',
    bundle: 'jre',
    version,
    comment:
      "BellSoft Liberica JRE 11 (LTS). URLs are immutable GitHub release assets; sha256 verified against BellSoft's published sha1 at pin time.",
    platforms,
  };
}

async function resolveGateway() {
  console.log('• Downloading IB Client Portal Gateway…');
  const { buffer, headers } = await fetchBuffer(GATEWAY_URL);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const md5 = createHash('md5').update(buffer).digest('hex');
  const etag = (headers.get('etag') || '').replace(/"/g, '');
  const etagMd5 = etag.split(':')[0]?.toLowerCase();
  if (etagMd5 && etagMd5 !== md5) {
    throw new Error(`Gateway ETag md5 ${etagMd5} does not match downloaded md5 ${md5}`);
  }
  const lastModified = headers.get('last-modified');
  const version = lastModified ? new Date(lastModified).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  console.log(`  ✓ sha256=${sha256} md5=${md5} (version ${version})`);

  return {
    vendor: 'interactive-brokers',
    channel: 'stable',
    version,
    comment:
      "IB Client Portal Gateway. IB only ships a rolling 'latest' zip over HTTPS with no published checksum; the bytes are verified against this pinned sha256 AND against the live MD5 that IB's Akamai CDN exposes in the ETag header at download time. host must stay on the official IB distribution domain.",
    url: GATEWAY_URL,
    host: GATEWAY_HOST,
    archive: 'zip',
    sha256,
    md5,
    size: buffer.length,
  };
}

async function main() {
  const requestedVersion = process.argv[2];
  const manifest = {
    $comment:
      'Pinned third-party dependency manifest for interactive-brokers-mcp v2. These artifacts are downloaded on demand at runtime and verified before use; nothing here is checked into the repo or shipped in the npm package. Regenerate with `npm run manifest:update`.',
    java: await resolveJava(requestedVersion),
    gateway: await resolveGateway(),
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\n✅ Wrote ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
