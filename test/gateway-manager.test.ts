// test/gateway-manager.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { IBGatewayManager } from '../src/gateway-manager.js';
import { PortUtils } from '../src/utils/port-utils.js';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

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
  const originalGatewayPort = process.env.IB_GATEWAY_PORT;

  afterEach(() => {
    if (originalForceStandalone === undefined) {
      delete process.env.IB_FORCE_STANDALONE_GATEWAY;
    } else {
      process.env.IB_FORCE_STANDALONE_GATEWAY = originalForceStandalone;
    }
    if (originalGatewayPort === undefined) {
      delete process.env.IB_GATEWAY_PORT;
    } else {
      process.env.IB_GATEWAY_PORT = originalGatewayPort;
    }
    vi.restoreAllMocks();
  });

  it('skips existing gateway discovery when standalone mode is forced', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'true';
    const findExistingGatewaySpy = vi.spyOn(PortUtils, 'findExistingGateway');
    const manager = new IBGatewayManager() as unknown as {
      quickCheckExistingGateway: () => Promise<number | null>;
      findManagedGateway: () => Promise<number | null>;
    };
    vi.spyOn(manager, 'findManagedGateway').mockResolvedValue(null);

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBeNull();
    expect(findExistingGatewaySpy).not.toHaveBeenCalled();
  });

  it('still reuses an MCP-managed gateway when standalone mode is forced', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'true';
    const findExistingGatewaySpy = vi.spyOn(PortUtils, 'findExistingGateway');
    const manager = new IBGatewayManager() as unknown as {
      quickCheckExistingGateway: () => Promise<number | null>;
      findManagedGateway: () => Promise<number | null>;
    };
    vi.spyOn(manager, 'findManagedGateway').mockResolvedValue(5003);

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBe(5003);
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

  it('reuses a reachable configured port before process-name discovery', async () => {
    process.env.IB_FORCE_STANDALONE_GATEWAY = 'false';
    process.env.IB_GATEWAY_PORT = '5002';
    const findExistingGatewaySpy = vi.spyOn(PortUtils, 'findExistingGateway').mockResolvedValue(null);
    const manager = new IBGatewayManager() as unknown as {
      quickCheckExistingGateway: () => Promise<number | null>;
      checkGatewayHealth: (port?: number) => Promise<boolean>;
    };
    const checkGatewayHealthSpy = vi
      .spyOn(manager, 'checkGatewayHealth')
      .mockImplementation(async (port?: number) => port === 5002);

    const port = await manager.quickCheckExistingGateway();

    expect(port).toBe(5002);
    expect(checkGatewayHealthSpy).toHaveBeenCalledWith(5002);
    expect(findExistingGatewaySpy).not.toHaveBeenCalled();
  });

  it('treats unauthenticated API responses as a live Gateway health signal', () => {
    const manager = new IBGatewayManager() as unknown as {
      isLiveGatewayResponse: (pathname: string, statusCode?: number) => boolean;
    };

    expect(manager.isLiveGatewayResponse('/v1/api/iserver/auth/status', 401)).toBe(true);
    expect(manager.isLiveGatewayResponse('/v1/api/iserver/auth/status', 403)).toBe(true);
    expect(manager.isLiveGatewayResponse('/v1/api/iserver/auth/status', 404)).toBe(false);
    expect(manager.isLiveGatewayResponse('/', 404)).toBe(false);
  });
});

describe('IBGatewayManager durable managed sessions', () => {
  const originalForceStandalone = process.env.IB_FORCE_STANDALONE_GATEWAY;
  const originalGatewayPort = process.env.IB_GATEWAY_PORT;

  afterEach(() => {
    if (originalForceStandalone === undefined) {
      delete process.env.IB_FORCE_STANDALONE_GATEWAY;
    } else {
      process.env.IB_FORCE_STANDALONE_GATEWAY = originalForceStandalone;
    }
    if (originalGatewayPort === undefined) {
      delete process.env.IB_GATEWAY_PORT;
    } else {
      process.env.IB_GATEWAY_PORT = originalGatewayPort;
    }
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
  });

  function createMockGatewayProcess(pid = 4321) {
    const gatewayProcess = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    gatewayProcess.pid = pid;
    gatewayProcess.unref = vi.fn();
    return gatewayProcess;
  }

  function mockManagedStartup(manager: IBGatewayManager, pid = 4321) {
    const privateManager = manager as unknown as {
      ensureGatewayExists: () => Promise<void>;
      getJavaPath: () => Promise<string>;
      checkGatewayHealth: (port?: number) => Promise<boolean>;
      acquireManagedGatewayLock: () => Promise<{ close: () => Promise<void> }>;
      releaseManagedGatewayLock: (handle: { close: () => Promise<void> } | null) => Promise<void>;
      writeManagedSessionMetadata: (processId: number, port: number) => Promise<void>;
      ensureRuntimeDir: () => Promise<void>;
      startGatewayInternal: () => Promise<void>;
    };
    const lockHandle = { close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(privateManager, 'ensureGatewayExists').mockResolvedValue(undefined);
    vi.spyOn(privateManager, 'getJavaPath').mockResolvedValue('/runtime/linux-x64/bin/java');
    vi.spyOn(privateManager, 'checkGatewayHealth').mockResolvedValue(true);
    vi.spyOn(privateManager, 'acquireManagedGatewayLock').mockResolvedValue(lockHandle);
    vi.spyOn(privateManager, 'releaseManagedGatewayLock').mockResolvedValue(undefined);
    vi.spyOn(privateManager, 'writeManagedSessionMetadata').mockResolvedValue(undefined);
    vi.spyOn(privateManager, 'ensureRuntimeDir').mockResolvedValue(undefined);
    vi.spyOn(PortUtils, 'isPortAvailable').mockResolvedValue(true);
    vi.mocked(spawn).mockReturnValue(createMockGatewayProcess(pid) as never);

    return { privateManager, lockHandle };
  }

  it('spawns the bundled Gateway detached with durable file stdio and writes metadata', async () => {
    const manager = new IBGatewayManager();
    const { privateManager } = mockManagedStartup(manager, 9876);
    const openSpy = vi.spyOn(fs.promises, 'open')
      .mockResolvedValueOnce({ fd: 31, write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) } as never)
      .mockResolvedValueOnce({ fd: 32, write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) } as never);
    const metadataSpy = vi.spyOn(privateManager, 'writeManagedSessionMetadata');

    await privateManager.startGatewayInternal();

    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('gateway.stdout.log'), 'a');
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('gateway.stderr.log'), 'a');
    expect(spawn).toHaveBeenCalledWith(
      '/runtime/linux-x64/bin/java',
      expect.any(Array),
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 31, 32],
      }),
    );
    const spawnedProcess = vi.mocked(spawn).mock.results[0]?.value as ReturnType<typeof createMockGatewayProcess>;
    expect(spawnedProcess.unref).toHaveBeenCalled();
    expect(metadataSpy).toHaveBeenCalledWith(9876, 5000);
  });

  it('cleans up stale managed metadata when the stored pid is gone', async () => {
    const manager = new IBGatewayManager() as unknown as {
      findManagedGateway: () => Promise<number | null>;
      readManagedSessionMetadata: () => Promise<{ managedBy: string; pid: number; port: number } | null>;
      clearManagedSessionMetadata: () => Promise<void>;
      isProcessAlive: (pid: number) => boolean;
    };
    vi.spyOn(manager, 'readManagedSessionMetadata').mockResolvedValue({
      managedBy: 'interactive-brokers-mcp',
      pid: 99999,
      port: 5004,
    });
    vi.spyOn(manager, 'isProcessAlive').mockReturnValue(false);
    const clearSpy = vi.spyOn(manager, 'clearManagedSessionMetadata').mockResolvedValue(undefined);

    await expect(manager.findManagedGateway()).resolves.toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('prevents a second managed start while another live process owns the lock', async () => {
    const manager = new IBGatewayManager() as unknown as {
      startGatewayInternal: () => Promise<void>;
      findManagedGateway: () => Promise<number | null>;
      acquireManagedGatewayLock: () => Promise<never>;
      waitForManagedGatewayFromMetadata: () => Promise<boolean>;
    };
    vi.spyOn(manager, 'findManagedGateway').mockResolvedValue(null);
    vi.spyOn(manager, 'acquireManagedGatewayLock').mockRejectedValue(new Error('Another MCP process is starting the managed Gateway (lock held by pid 1234)'));
    vi.spyOn(manager, 'waitForManagedGatewayFromMetadata').mockResolvedValue(false);

    await expect(manager.startGatewayInternal()).rejects.toThrow('lock held by pid 1234');
  });

  it('detaches on shutdown without killing the durable Gateway process', async () => {
    const manager = new IBGatewayManager() as unknown as {
      gatewayProcess: { kill: ReturnType<typeof vi.fn> } | null;
      isReady: boolean;
      stopGateway: () => Promise<void>;
    };
    const kill = vi.fn();
    manager.gatewayProcess = { kill };
    manager.isReady = true;

    await manager.stopGateway();

    expect(kill).not.toHaveBeenCalled();
    expect(manager.gatewayProcess).toBeNull();
    expect(manager.isReady).toBe(false);
  });

  it('waits for the managed session instead of spawning when the startup lock is held', async () => {
    const manager = new IBGatewayManager() as unknown as {
      startGatewayInternal: () => Promise<void>;
      findManagedGateway: () => Promise<number | null>;
      acquireManagedGatewayLock: () => Promise<never>;
      waitForManagedGatewayFromMetadata: () => Promise<boolean>;
      ensureGatewayExists: () => Promise<void>;
    };
    vi.spyOn(manager, 'findManagedGateway').mockResolvedValue(null);
    vi.spyOn(manager, 'acquireManagedGatewayLock').mockRejectedValue(new Error('lock held'));
    vi.spyOn(manager, 'waitForManagedGatewayFromMetadata').mockResolvedValue(true);
    const ensureGatewayExistsSpy = vi.spyOn(manager, 'ensureGatewayExists').mockResolvedValue(undefined);

    await manager.startGatewayInternal();

    expect(ensureGatewayExistsSpy).not.toHaveBeenCalled();
  });
});
