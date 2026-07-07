import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
import AdmZip from 'adm-zip';
import { resolveRuntimePlatform } from './utils/platform-utils.js';

const require = createRequire(import.meta.url);

type JavaPlatformEntry = { url: string; archive: 'tar.gz' | 'zip'; sha256: string };
type DependencyManifest = {
  java: {
    vendor: string;
    bundle: string;
    version: string;
    platforms: Record<string, JavaPlatformEntry>;
  };
  gateway: {
    vendor: string;
    version: string;
    url: string;
    host: string;
    archive: 'zip';
    sha256: string;
    md5: string;
    size: number;
  };
};

export type ResolvedJava = {
  javaPath: string;
  javaHome: string;
  source: 'IB_JAVA_HOME' | 'JAVA_HOME' | 'system' | 'download';
};

export type ResolvedGateway = {
  // Directory that contains the `clientportal.gw` subdirectory.
  gatewayDir: string;
  source: 'IB_GATEWAY_DIR' | 'download';
};

const DOWNLOADS_DISABLED_HINT =
  'Set IB_JAVA_HOME / IB_GATEWAY_DIR to point at pre-installed dependencies, or unset IB_DOWNLOADS_DISABLED to allow on-demand installs.';

// Resolves the IB Gateway and a compatible Java runtime, either from user-managed locations
// or by downloading verified, pinned artifacts on demand into a per-user cache. Nothing is
// bundled in the package; see dependencies.manifest.json for the pinned sources.
export class DependencyResolver {
  private readonly manifest: DependencyManifest;

  constructor(private readonly log: (message: string) => void = () => {}) {
    this.manifest = require('../dependencies.manifest.json') as DependencyManifest;
  }

  static downloadsDisabled(): boolean {
    return process.env.IB_DOWNLOADS_DISABLED === 'true';
  }

  static gatewayUnverifiedAllowed(): boolean {
    return process.env.IB_GATEWAY_ALLOW_UNVERIFIED === 'true';
  }

  // Per-user cache root for downloaded artifacts, kept outside the package/repo directory.
  static cacheRoot(): string {
    if (process.env.IB_CACHE_DIR) {
      return process.env.IB_CACHE_DIR;
    }
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(base, 'interactive-brokers-mcp', 'cache');
    }
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, 'interactive-brokers-mcp');
  }

  // Stable working directory for session metadata, locks and gateway logs (independent of the
  // versioned artifact directories so it survives dependency upgrades).
  static runDir(): string {
    return path.join(DependencyResolver.cacheRoot(), 'run');
  }

  // ---------------------------------------------------------------------------
  // Java
  // ---------------------------------------------------------------------------

  async resolveJava(): Promise<ResolvedJava> {
    const javaExecutable = process.platform === 'win32' ? 'java.exe' : 'java';

    for (const envVar of ['IB_JAVA_HOME', 'JAVA_HOME'] as const) {
      const home = process.env[envVar];
      if (!home) {
        continue;
      }
      const candidate = path.join(home, 'bin', javaExecutable);
      if (existsSync(candidate)) {
        this.log(`☕ Using Java from ${envVar}: ${candidate}`);
        return { javaPath: candidate, javaHome: home, source: envVar };
      }
      this.log(`⚠️ ${envVar} is set to ${home} but no Java executable was found there; ignoring it`);
    }

    const systemJava = await this.findUsableSystemJava();
    if (systemJava) {
      return systemJava;
    }

    return this.downloadJava(javaExecutable);
  }

  // The IB Gateway is a Java 11-era application (Vert.x 3.5 / Netty 4.1); it relies on internal
  // APIs that newer JDKs remove, so we only auto-adopt a system `java` within a known-good range.
  // Users can still force any runtime explicitly via IB_JAVA_HOME / JAVA_HOME.
  private static readonly SYSTEM_JAVA_MIN_MAJOR = 11;
  private static readonly SYSTEM_JAVA_MAX_MAJOR = 17;

  private async findUsableSystemJava(): Promise<ResolvedJava | null> {
    const major = await this.detectJavaMajorVersion('java');
    if (major === null) {
      return null;
    }
    if (major < DependencyResolver.SYSTEM_JAVA_MIN_MAJOR || major > DependencyResolver.SYSTEM_JAVA_MAX_MAJOR) {
      this.log(
        `⚠️ System Java major version ${major} is outside the IB Gateway supported range ` +
        `(${DependencyResolver.SYSTEM_JAVA_MIN_MAJOR}-${DependencyResolver.SYSTEM_JAVA_MAX_MAJOR}); installing a managed runtime instead. ` +
        `Set IB_JAVA_HOME to override.`,
      );
      return null;
    }
    this.log(`☕ Using system Java on PATH (major version ${major})`);
    const javaHome = await this.detectJavaHome('java');
    return { javaPath: 'java', javaHome: javaHome ?? '', source: 'system' };
  }

  private detectJavaMajorVersion(javaCmd: string): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(javaCmd, ['-version'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', () => resolve(null));
      child.on('exit', () => {
        // Matches: java version "11.0.31"  OR  openjdk version "1.8.0_392"
        const match = stderr.match(/version "(\d+)(?:\.(\d+))?/);
        if (!match) {
          resolve(null);
          return;
        }
        const first = Number.parseInt(match[1], 10);
        const major = first === 1 ? Number.parseInt(match[2] ?? '0', 10) : first;
        resolve(Number.isFinite(major) ? major : null);
      });
    });
  }

  private detectJavaHome(javaCmd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(
        javaCmd,
        ['-XshowSettings:properties', '-version'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', () => resolve(null));
      child.on('exit', () => {
        const match = stderr.match(/java\.home = (.+)/);
        resolve(match ? match[1].trim() : null);
      });
    });
  }

  private async downloadJava(javaExecutable: string): Promise<ResolvedJava> {
    const platform = resolveRuntimePlatform();
    const entry = this.manifest.java.platforms[platform];
    if (!entry) {
      throw new Error(
        `No managed Java runtime is available for platform "${platform}". ` +
        `Install a Java 11+ runtime and set IB_JAVA_HOME (or JAVA_HOME) to its location.`,
      );
    }

    const installDir = path.join(
      DependencyResolver.cacheRoot(),
      'java',
      `${this.manifest.java.vendor}-${this.sanitize(this.manifest.java.version)}-${platform}`,
    );
    const javaPath = path.join(installDir, 'bin', javaExecutable);

    if (await this.isComplete(installDir) && existsSync(javaPath)) {
      this.log(`☕ Reusing managed Java runtime at ${installDir}`);
      return { javaPath, javaHome: installDir, source: 'download' };
    }

    if (DependencyResolver.downloadsDisabled()) {
      throw new Error(
        `Java runtime is not installed for "${platform}" and downloads are disabled (IB_DOWNLOADS_DISABLED=true). ${DOWNLOADS_DISABLED_HINT}`,
      );
    }

    this.log(`⬇️ Installing ${this.manifest.java.vendor} ${this.manifest.java.bundle} ${this.manifest.java.version} for ${platform}`);
    this.log(`   from ${entry.url}`);
    this.log(`   into ${installDir}`);

    const archive = await this.downloadAndVerify(entry.url, { sha256: entry.sha256 });
    await this.atomicInstall(installDir, entry.archive, archive.path, archive.cleanup, true);

    if (!existsSync(javaPath)) {
      throw new Error(`Installed Java runtime for "${platform}" is missing the expected executable at ${javaPath}`);
    }
    this.log(`✅ Java runtime ready at ${installDir}`);
    return { javaPath, javaHome: installDir, source: 'download' };
  }

  // ---------------------------------------------------------------------------
  // Gateway
  // ---------------------------------------------------------------------------

  async resolveGateway(): Promise<ResolvedGateway> {
    const userDir = process.env.IB_GATEWAY_DIR;
    if (userDir) {
      const resolved = this.resolveUserGatewayDir(userDir);
      this.log(`🌐 Using user-managed IB Gateway from IB_GATEWAY_DIR: ${resolved}`);
      return { gatewayDir: resolved, source: 'IB_GATEWAY_DIR' };
    }

    const gateway = this.manifest.gateway;
    const installDir = path.join(
      DependencyResolver.cacheRoot(),
      'gateway',
      this.sanitize(gateway.version),
    );
    const clientPortalDir = path.join(installDir, 'clientportal.gw');
    const jarPath = path.join(clientPortalDir, 'dist', 'ibgroup.web.core.iblink.router.clientportal.gw.jar');

    // atomicInstall manages and marks clientPortalDir, so the completion marker lives there.
    if (!((await this.isComplete(clientPortalDir)) && existsSync(jarPath))) {
      if (DependencyResolver.downloadsDisabled()) {
        throw new Error(
          `IB Gateway is not installed and downloads are disabled (IB_DOWNLOADS_DISABLED=true). ${DOWNLOADS_DISABLED_HINT}`,
        );
      }
      await this.downloadGateway(installDir, clientPortalDir);
    } else {
      this.log(`🌐 Reusing IB Gateway at ${installDir}`);
    }

    // The downloaded gateway runs with Interactive Brokers' own shipped configuration; we do not
    // modify it. See SECURITY.md for the network exposure of IB's default conf and how to harden
    // it (e.g. a loopback-only `ips.allow` via a user-managed IB_GATEWAY_DIR).
    return { gatewayDir: installDir, source: 'download' };
  }

  private resolveUserGatewayDir(userDir: string): string {
    const candidates = [
      userDir,
      path.join(userDir, '..'), // user pointed directly at the clientportal.gw directory
    ];
    for (const candidate of candidates) {
      const jar = path.join(candidate, 'clientportal.gw', 'dist', 'ibgroup.web.core.iblink.router.clientportal.gw.jar');
      if (existsSync(jar)) {
        return path.resolve(candidate);
      }
    }
    throw new Error(
      `IB_GATEWAY_DIR (${userDir}) does not contain a clientportal.gw/dist gateway jar. ` +
      `Point it at the directory that holds clientportal.gw.`,
    );
  }

  private async downloadGateway(installDir: string, clientPortalDir: string): Promise<void> {
    const gateway = this.manifest.gateway;

    this.assertOfficialHost(gateway.url, gateway.host);
    this.log(`⬇️ Installing IB Gateway (${gateway.version})`);
    this.log(`   from ${gateway.url}`);
    this.log(`   into ${installDir}`);

    const liveMd5 = await this.fetchLiveEtagMd5(gateway.url);
    const archive = await this.downloadAndVerify(gateway.url, {
      sha256: gateway.sha256,
      md5: gateway.md5,
      liveMd5,
      allowSha256Mismatch: DependencyResolver.gatewayUnverifiedAllowed(),
    });

    // The zip extracts to bin/build/dist/doc/root at its root — i.e. the clientportal.gw contents.
    await this.atomicInstall(clientPortalDir, gateway.archive, archive.path, archive.cleanup, false);
  }

  private assertOfficialHost(url: string, expectedHost: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`Refusing to download IB Gateway over non-HTTPS URL: ${url}`);
    }
    if (parsed.hostname !== expectedHost) {
      throw new Error(
        `Refusing to download IB Gateway from unexpected host "${parsed.hostname}" (expected "${expectedHost}").`,
      );
    }
  }

  // IB's Akamai CDN exposes the object's MD5 in the ETag header (`<md5>:<timestamp>`); fetching
  // it lets us cross-check the bytes against what IB is serving right now, with no maintenance.
  private async fetchLiveEtagMd5(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const etag = response.headers.get('etag');
      if (!etag) {
        return null;
      }
      const md5 = etag.replace(/"/g, '').split(':')[0]?.toLowerCase();
      return md5 && /^[a-f0-9]{32}$/.test(md5) ? md5 : null;
    } catch (error) {
      this.log(`⚠️ Could not read live ETag for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Download / verify / extract helpers
  // ---------------------------------------------------------------------------

  private async downloadAndVerify(
    url: string,
    verify: { sha256: string; md5?: string; liveMd5?: string | null; allowSha256Mismatch?: boolean },
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');

    // Layer 1: live integrity against IB's own CDN value (when available).
    if (verify.liveMd5) {
      if (md5 !== verify.liveMd5) {
        throw new Error(
          `Integrity check failed for ${url}: downloaded bytes (md5 ${md5}) do not match the live CDN ETag (md5 ${verify.liveMd5}). ` +
          `The download may have been corrupted or tampered with in transit.`,
        );
      }
      this.log('   ✓ verified against live CDN ETag (md5)');
    }

    // Layer 2: pinned sha256 (human-reviewed anchor).
    if (sha256 !== verify.sha256) {
      const detail =
        `Pinned sha256 mismatch for ${url}.\n  expected ${verify.sha256}\n  actual   ${sha256}` +
        (verify.md5 ? `\n  (expected md5 ${verify.md5}, actual md5 ${md5})` : '');
      if (verify.allowSha256Mismatch) {
        this.log(`⚠️ ${detail}`);
        this.log('⚠️ Proceeding because IB_GATEWAY_ALLOW_UNVERIFIED=true. The vendor likely rotated the artifact; consider updating dependencies.manifest.json.');
      } else {
        throw new Error(
          `${detail}\nThe vendor may have rotated this artifact. ` +
          `Update dependencies.manifest.json with the new checksum, or set IB_GATEWAY_ALLOW_UNVERIFIED=true to proceed (the live CDN ETag is still checked).`,
        );
      }
    } else {
      this.log('   ✓ verified against pinned sha256');
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-mcp-dl-'));
    const archivePath = path.join(tempRoot, 'artifact');
    await fs.writeFile(archivePath, buffer);
    return {
      path: archivePath,
      cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined),
    };
  }

  // Extract an archive and atomically swap it into installDir. When stripTopLevelDir is true the
  // archive is expected to contain a single top-level directory (the JRE) whose contents become
  // installDir; otherwise the archive contents become installDir directly.
  private async atomicInstall(
    installDir: string,
    archiveType: 'tar.gz' | 'zip',
    archivePath: string,
    cleanupArchive: () => Promise<void>,
    stripTopLevelDir: boolean,
  ): Promise<void> {
    const parent = path.dirname(installDir);
    await fs.mkdir(parent, { recursive: true });
    const extractDir = await fs.mkdtemp(path.join(parent, '.extract-'));
    const staging = `${installDir}.staging-${process.pid}`;

    try {
      if (archiveType === 'zip') {
        // Our zip artifacts (IB Gateway, Windows JRE) contain no files that need a Unix execute
        // bit, so adm-zip's synchronous extraction is sufficient and avoids stream-based hangs.
        new AdmZip(archivePath).extractAllTo(extractDir, true);
      } else {
        // tar preserves Unix permissions, which the mac/linux JRE bin/java needs.
        await this.extractTarGz(archivePath, extractDir);
      }

      let source = extractDir;
      if (stripTopLevelDir) {
        const entries = await fs.readdir(extractDir, { withFileTypes: true });
        const topDir = entries.find((entry) => entry.isDirectory());
        if (!topDir) {
          throw new Error('Downloaded archive did not contain an extracted runtime directory');
        }
        source = path.join(extractDir, topDir.name);
      }

      await fs.rm(staging, { recursive: true, force: true });
      await fs.rename(source, staging);
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.rename(staging, installDir);
      await this.markComplete(installDir);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
      await cleanupArchive();
    }
  }

  private extractTarGz(archivePath: string, destinationDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tarProcess = spawn('tar', ['-xzf', archivePath, '-C', destinationDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      tarProcess.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      tarProcess.on('error', reject);
      tarProcess.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Failed to extract archive with tar (exit ${code}): ${stderr.trim() || 'no stderr captured'}`));
      });
    });
  }

  private markerPath(installDir: string): string {
    return path.join(installDir, '.ib-mcp-complete');
  }

  private async isComplete(installDir: string): Promise<boolean> {
    try {
      await fs.access(this.markerPath(installDir));
      return true;
    } catch {
      return false;
    }
  }

  private async markComplete(installDir: string): Promise<void> {
    await fs.writeFile(this.markerPath(installDir), `${new Date().toISOString()}\n`, 'utf8');
  }

  private sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
  }
}
