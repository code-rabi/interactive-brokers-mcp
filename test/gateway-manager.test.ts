// test/gateway-manager.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import { IBGatewayManager } from '../src/gateway-manager.js';
import { PortUtils } from '../src/utils/port-utils.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

describe('IBGatewayManager.isMuslLibc', () => {
  const originalReport = (process as unknown as { report?: unknown }).report;

  afterEach(() => {
    Object.defineProperty(process, 'report', { configurable: true, value: originalReport });
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
  });

  it('returns false on non-Linux platforms without consulting libc', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true); // would lie if consulted
    expect(IBGatewayManager.isMuslLibc('darwin')).toBe(false);
    expect(IBGatewayManager.isMuslLibc('win32')).toBe(false);
  });

  it('returns false on Linux when process.report exposes a glibc runtime version', () => {
    Object.defineProperty(process, 'report', { configurable: true, value: {
      getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }),
    } });
    expect(IBGatewayManager.isMuslLibc('linux')).toBe(false);
  });

  it('returns true on Linux when glibcVersionRuntime is missing and the musl loader is on disk', () => {
    Object.defineProperty(process, 'report', { configurable: true, value: {
      getReport: () => ({ header: {} }),
    } });
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => p === '/lib/ld-musl-x86_64.so.1',
    );
    expect(IBGatewayManager.isMuslLibc('linux')).toBe(true);
  });

  it('returns true when only the aarch64 musl loader is present', () => {
    Object.defineProperty(process, 'report', { configurable: true, value: {
      getReport: () => ({ header: {} }),
    } });
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => p === '/lib/ld-musl-aarch64.so.1',
    );
    expect(IBGatewayManager.isMuslLibc('linux')).toBe(true);
  });

  it('returns false when neither glibc nor a musl loader is detectable', () => {
    Object.defineProperty(process, 'report', { configurable: true, value: {
      getReport: () => ({ header: {} }),
    } });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(IBGatewayManager.isMuslLibc('linux')).toBe(false);
  });

  it('falls back to the filesystem check if process.report.getReport throws', () => {
    Object.defineProperty(process, 'report', { configurable: true, value: {
      getReport: () => {
        throw new Error('not available');
      },
    } });
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => p === '/lib/ld-musl-x86_64.so.1',
    );
    expect(IBGatewayManager.isMuslLibc('linux')).toBe(true);
  });
});

describe('IBGatewayManager runtime platform resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the plain platform-arch key for glibc Linux', () => {
    vi.spyOn(IBGatewayManager, 'isMuslLibc').mockReturnValue(false);
    expect((IBGatewayManager as unknown as {
      resolveRuntimePlatform: (platform?: NodeJS.Platform, arch?: string) => string;
    }).resolveRuntimePlatform('linux', 'x64')).toBe('linux-x64');
  });

  it('routes Linux musl environments to the musl runtime key', () => {
    vi.spyOn(IBGatewayManager, 'isMuslLibc').mockReturnValue(true);
    expect((IBGatewayManager as unknown as {
      resolveRuntimePlatform: (platform?: NodeJS.Platform, arch?: string) => string;
    }).resolveRuntimePlatform('linux', 'arm64')).toBe('linux-arm64-musl');
  });
});

describe('IBGatewayManager existing gateway selection', () => {
  const originalForceStandalone = process.env.IB_FORCE_STANDALONE_GATEWAY;

  afterEach(() => {
    if (originalForceStandalone === undefined) {
      delete process.env.IB_FORCE_STANDALONE_GATEWAY;
    } else {
      process.env.IB_FORCE_STANDALONE_GATEWAY = originalForceStandalone;
    }
    vi.restoreAllMocks();
  });

  it('skips existing gateway discovery when standalone mode is forced', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'true';
    const findExistingGatewaySpy = vi.spyOn(PortUtils, 'findExistingGateway');
    const manager = new IBGatewayManager();

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBeNull();
    expect(findExistingGatewaySpy).not.toHaveBeenCalled();
  });

  it('ignores an existing gateway candidate when it is not reachable', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'false';
    vi.spyOn(PortUtils, 'findExistingGateway').mockResolvedValue(5000);
    const manager = new IBGatewayManager() as unknown as {
      quickCheckExistingGateway: () => Promise<number | null>;
      checkGatewayHealth: (port?: number) => Promise<boolean>;
    };
    const checkGatewayHealthSpy = vi.spyOn(manager, 'checkGatewayHealth').mockResolvedValue(false);

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBeNull();
    expect(checkGatewayHealthSpy).toHaveBeenCalledWith(5000);
  });

  it('reuses an existing gateway candidate when it is reachable', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'false';
    vi.spyOn(PortUtils, 'findExistingGateway').mockResolvedValue(5000);
    const manager = new IBGatewayManager() as unknown as {
      quickCheckExistingGateway: () => Promise<number | null>;
      checkGatewayHealth: (port?: number) => Promise<boolean>;
    };
    const checkGatewayHealthSpy = vi.spyOn(manager, 'checkGatewayHealth').mockResolvedValue(true);

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBe(5000);
    expect(checkGatewayHealthSpy).toHaveBeenCalledWith(5000);
  });
});
