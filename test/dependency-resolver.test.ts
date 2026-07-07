// test/dependency-resolver.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { DependencyResolver } from '../src/dependency-resolver.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const ENV_KEYS = [
  'IB_JAVA_HOME',
  'JAVA_HOME',
  'IB_GATEWAY_DIR',
  'IB_DOWNLOADS_DISABLED',
  'IB_GATEWAY_ALLOW_UNVERIFIED',
  'IB_CACHE_DIR',
  'XDG_CACHE_HOME',
] as const;

function snapshotEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('DependencyResolver static controls', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
    vi.restoreAllMocks();
  });

  it('honors IB_DOWNLOADS_DISABLED and IB_GATEWAY_ALLOW_UNVERIFIED flags', () => {
    expect(DependencyResolver.downloadsDisabled()).toBe(false);
    expect(DependencyResolver.gatewayUnverifiedAllowed()).toBe(false);
    process.env.IB_DOWNLOADS_DISABLED = 'true';
    process.env.IB_GATEWAY_ALLOW_UNVERIFIED = 'true';
    expect(DependencyResolver.downloadsDisabled()).toBe(true);
    expect(DependencyResolver.gatewayUnverifiedAllowed()).toBe(true);
  });

  it('uses IB_CACHE_DIR override and derives a stable run dir under it', () => {
    process.env.IB_CACHE_DIR = '/tmp/custom-cache';
    expect(DependencyResolver.cacheRoot()).toBe('/tmp/custom-cache');
    expect(DependencyResolver.runDir()).toBe(path.join('/tmp/custom-cache', 'run'));
  });
});

describe('DependencyResolver.resolveJava', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
    vi.mocked(fs.existsSync).mockReset();
  });
  afterEach(() => {
    restoreEnv(saved);
    vi.restoreAllMocks();
  });

  it('prefers IB_JAVA_HOME when it contains a Java executable', async () => {
    process.env.IB_JAVA_HOME = '/opt/jdk';
    const expected = path.join('/opt/jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => p === expected);

    const resolver = new DependencyResolver();
    const resolved = await resolver.resolveJava();
    expect(resolved.source).toBe('IB_JAVA_HOME');
    expect(resolved.javaPath).toBe(expected);
  });

  it('throws a clear error when no Java is available and downloads are disabled', async () => {
    process.env.IB_DOWNLOADS_DISABLED = 'true';
    process.env.IB_CACHE_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibjava-'));
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const resolver = new DependencyResolver();
    // Avoid depending on whatever `java` happens to be on the test host's PATH.
    vi.spyOn(resolver as unknown as { findUsableSystemJava: () => Promise<null> }, 'findUsableSystemJava')
      .mockResolvedValue(null);

    await expect(resolver.resolveJava()).rejects.toThrow(/downloads are disabled/i);
  });
});

describe('DependencyResolver.resolveGateway', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
  });
  afterEach(() => {
    restoreEnv(saved);
    vi.restoreAllMocks();
  });

  it('throws when IB_GATEWAY_DIR is set but has no gateway jar', () => {
    process.env.IB_GATEWAY_DIR = '/nope';
    const resolver = new DependencyResolver();
    return expect(resolver.resolveGateway()).rejects.toThrow(/IB_GATEWAY_DIR/);
  });

  it('throws when the gateway is missing and downloads are disabled', async () => {
    process.env.IB_DOWNLOADS_DISABLED = 'true';
    process.env.IB_CACHE_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibgw-'));
    const resolver = new DependencyResolver();
    await expect(resolver.resolveGateway()).rejects.toThrow(/downloads are disabled/i);
  });
});

describe('DependencyResolver download verification', () => {
  type PrivateResolver = {
    downloadAndVerify: (
      url: string,
      verify: { sha256: string; md5?: string; liveMd5?: string | null; allowSha256Mismatch?: boolean },
    ) => Promise<{ path: string; cleanup: () => Promise<void> }>;
    assertOfficialHost: (url: string, host: string) => void;
  };

  const payload = Buffer.from('fake-artifact-bytes');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const md5 = crypto.createHash('md5').update(payload).digest('hex');

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    } as unknown as Response);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts bytes that match the pinned sha256 and live ETag md5', async () => {
    const resolver = new DependencyResolver() as unknown as PrivateResolver;
    const result = await resolver.downloadAndVerify('https://x/y', { sha256, md5, liveMd5: md5 });
    expect(typeof result.path).toBe('string');
    await result.cleanup();
  });

  it('rejects when the live CDN ETag md5 does not match the bytes', async () => {
    const resolver = new DependencyResolver() as unknown as PrivateResolver;
    await expect(
      resolver.downloadAndVerify('https://x/y', { sha256, liveMd5: 'f'.repeat(32) }),
    ).rejects.toThrow(/live CDN ETag/i);
  });

  it('rejects on pinned sha256 mismatch by default', async () => {
    const resolver = new DependencyResolver() as unknown as PrivateResolver;
    await expect(
      resolver.downloadAndVerify('https://x/y', { sha256: '0'.repeat(64) }),
    ).rejects.toThrow(/sha256 mismatch/i);
  });

  it('proceeds past a sha256 mismatch when IB_GATEWAY_ALLOW_UNVERIFIED is allowed', async () => {
    const resolver = new DependencyResolver() as unknown as PrivateResolver;
    const result = await resolver.downloadAndVerify('https://x/y', {
      sha256: '0'.repeat(64),
      allowSha256Mismatch: true,
    });
    expect(typeof result.path).toBe('string');
    await result.cleanup();
  });

  it('refuses gateway downloads from a non-official host or non-HTTPS URL', () => {
    const resolver = new DependencyResolver() as unknown as PrivateResolver;
    expect(() => resolver.assertOfficialHost('http://download2.interactivebrokers.com/x', 'download2.interactivebrokers.com'))
      .toThrow(/non-HTTPS/i);
    expect(() => resolver.assertOfficialHost('https://evil.example.com/x', 'download2.interactivebrokers.com'))
      .toThrow(/unexpected host/i);
    expect(() => resolver.assertOfficialHost('https://download2.interactivebrokers.com/x', 'download2.interactivebrokers.com'))
      .not.toThrow();
  });
});
