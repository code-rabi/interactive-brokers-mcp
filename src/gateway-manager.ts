import { spawn, ChildProcess } from 'child_process';
import { promises as fs, existsSync as fsExistsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { Logger } from './logger.js';
import { PortUtils } from './utils/port-utils.js';
import { ConfigUtils } from './utils/config-utils.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = require('../package.json') as { version: string };

const MUSL_RUNTIME_DOWNLOADS: Record<string, string> = {
  'linux-x64-musl': 'https://download.bell-sw.com/java/11.0.31+11/bellsoft-jre11.0.31+11-linux-x64-musl.tar.gz',
  'linux-arm64-musl': 'https://download.bell-sw.com/java/11.0.31+11/bellsoft-jre11.0.31+11-linux-aarch64-musl.tar.gz',
};

export class IBGatewayManager {
  private gatewayProcess: ChildProcess | null = null;
  private gatewayDir: string;
  private jreDir: string;
  private isStarting = false;
  private isReady = false;
  private useStderr: boolean;
  private cleanupHandlersRegistered = false;
  private currentPort: number = IBGatewayManager.getConfiguredGatewayPort();
  private backgroundStartupPromise: Promise<void> | null = null;
  private spawnFailure: { reason: string; details?: string } | null = null;
  private static readonly STDERR_TAIL_BYTES = 4096;
  private static readonly DEFAULT_GATEWAY_PORT = 5000;
  private static readonly COMMON_GATEWAY_PORTS = [5000, 5001, 5002, 5003, 5004, 5005];
  private static readonly GATEWAY_HEALTH_PATHS = [
    '/v1/api/iserver/auth/status',
    '/v1/api/tickle',
    '/',
  ];
  private readonly forceStandaloneGateway: boolean;

  constructor() {
    this.gatewayDir = path.join(__dirname, '../ib-gateway');
    this.jreDir = path.join(__dirname, '../runtime');
    this.useStderr = !(process.env.MCP_HTTP_SERVER === 'true' || process.argv.includes('--http'));
    this.forceStandaloneGateway = process.env.IB_FORCE_STANDALONE_GATEWAY === 'true';
    this.registerCleanupHandlers();
  }

  private log(message: string) {
    Logger.info(message);
  }



  private static getConfiguredGatewayPort(): number {
    const parsedPort = Number.parseInt(process.env.IB_GATEWAY_PORT || '', 10);
    return Number.isFinite(parsedPort) && parsedPort > 0
      ? parsedPort
      : IBGatewayManager.DEFAULT_GATEWAY_PORT;
  }

  private getGatewayProbePorts(): number[] {
    return Array.from(new Set([
      this.currentPort,
      IBGatewayManager.getConfiguredGatewayPort(),
      ...IBGatewayManager.COMMON_GATEWAY_PORTS,
    ].filter((port) => Number.isInteger(port) && port > 0 && port < 65536)));
  }

  private async findReachableGatewayPort(): Promise<number | null> {
    for (const port of this.getGatewayProbePorts()) {
      const isReachable = await this.checkGatewayHealth(port);
      if (isReachable) {
        return port;
      }
    }

    return null;
  }

  private async findExistingGateway(): Promise<number | null> {
    if (this.forceStandaloneGateway) {
      this.log('Standalone gateway mode enabled; skipping existing gateway discovery');
      return null;
    }
    this.log('🔍 Checking for existing Gateway instances...');

    const reachablePort = await this.findReachableGatewayPort();
    if (reachablePort) {
      this.log(`✅ Found reachable Gateway on port ${reachablePort}`);
      return reachablePort;
    }

    const existingPort = await PortUtils.findExistingGateway();
    if (existingPort) {
      const isReachable = await this.checkGatewayHealth(existingPort);
      if (!isReachable) {
        this.log(`Gateway candidate on port ${existingPort} is not reachable; ignoring it`);
        return null;
      }
    }
    if (existingPort) {
      this.log(`✅ Found existing Gateway on port ${existingPort}`);
    } else {
      this.log('🚫 No existing Gateway found');
    }
    return existingPort;
  }

  async quickCheckExistingGateway(): Promise<number | null> {
    if (this.forceStandaloneGateway) {
      this.log('Standalone gateway mode enabled; skipping quick existing gateway discovery');
      return null;
    }
    this.log('⚡ Quick check for existing Gateway instances...');
    try {
      const reachablePort = await this.findReachableGatewayPort();
      if (reachablePort) {
        this.log(`✅ Found reachable Gateway on port ${reachablePort}`);
        return reachablePort;
      }

      const existingPort = await PortUtils.findExistingGateway();
      if (existingPort) {
        const isReachable = await this.checkGatewayHealth(existingPort);
        if (!isReachable) {
          this.log(`Gateway candidate on port ${existingPort} is not reachable; ignoring it`);
          return null;
        }
      }
      if (existingPort) {
        this.log(`✅ Found existing Gateway on port ${existingPort}`);
      } else {
        this.log('⚡ Quick check complete - no existing Gateway found');
      }
      return existingPort;
    } catch (error) {
      this.log('⚡ Quick check failed, continuing...');
      return null;
    }
  }

  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) {
      return;
    }

    this.cleanupHandlersRegistered = true;

    // Handle graceful shutdown signals - only clean temp files, don't kill gateway
    const cleanup = async (signal: string) => {
      this.log(`🛑 Received ${signal}, cleaning up temp files only...`);
      await this.cleanup();
      process.exit(0);
    };

    // Handle different termination signals
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGHUP', () => cleanup('SIGHUP'));

    // Handle uncaught exceptions and unhandled rejections
    process.on('uncaughtException', async (error) => {
      Logger.error('❌ Uncaught Exception:', error);
      await this.cleanup();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      Logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      await this.cleanup();
      process.exit(1);
    });

    // Handle normal process exit - only clean temp files
    process.on('exit', (code) => {
      this.log(`🛑 Process exiting with code ${code}, cleaning temp files only...`);
      // Don't kill gateway - just clean references
      this.gatewayProcess = null;
      this.isReady = false;
      this.isStarting = false;
    });

    // Handle when parent process dies (useful for child processes)
    process.on('disconnect', async () => {
      this.log('🛑 Parent process disconnected, cleaning up temp files only...');
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    try {
      // Only clean up temporary config files - don't kill gateway
      this.log('🧹 Cleaning up temporary files only...');
      await ConfigUtils.cleanupTempConfigFiles(this.gatewayDir);
      
      // Just clear references without killing the process
      this.gatewayProcess = null;
      this.isReady = false;
      this.isStarting = false;
    } catch (error) {
      Logger.error('❌ Error during cleanup:', error);
      // Still don't kill gateway - just clear references
      this.gatewayProcess = null;
      this.isReady = false;
      this.isStarting = false;
    }
  }



  // Removed forceKillGateway - we never kill gateway processes anymore

  private static resolveRuntimePlatform(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
  ): string {
    let runtimePlatform = `${platform}-${arch}`;
    if (platform === 'linux' && IBGatewayManager.isMuslLibc(platform)) {
      runtimePlatform = `${runtimePlatform}-musl`;
    }
    return runtimePlatform;
  }

  private async getJavaPath(): Promise<string> {
    const isWindows = process.platform === 'win32';
    const javaExecutable = isWindows ? 'java.exe' : 'java';
    const platform = IBGatewayManager.resolveRuntimePlatform();

    const runtimePath = path.join(this.jreDir, platform, 'bin', javaExecutable);

    if (!fsExistsSync(runtimePath)) {
      await this.ensureRuntimeAvailable(platform, runtimePath);
    }

    if (!fsExistsSync(runtimePath)) {
      throw new Error(`Custom runtime not found for platform: ${platform}. Expected at: ${runtimePath}`);
    }

    return runtimePath;
  }

  private async ensureRuntimeAvailable(platform: string, runtimePath: string): Promise<void> {
    const runtimeUrl = MUSL_RUNTIME_DOWNLOADS[platform];
    if (!runtimeUrl) {
      throw new Error(`Custom runtime not found for platform: ${platform}. Expected at: ${runtimePath}`);
    }

    this.log(`⬇️ Bundled runtime missing for ${platform}; downloading a public musl JRE...`);
    await this.downloadAndInstallRuntime(platform, runtimeUrl);
  }

  private async downloadAndInstallRuntime(platform: string, runtimeUrl: string): Promise<void> {
    const response = await fetch(runtimeUrl);
    if (!response.ok) {
      throw new Error(`Failed to download runtime for ${platform} from ${runtimeUrl}: HTTP ${response.status}`);
    }

    const tempRoot = await fs.mkdtemp(path.join(tmpdir(), `ib-mcp-runtime-${platform}-`));
    const archivePath = path.join(tempRoot, 'runtime.tar.gz');
    const extractDir = path.join(tempRoot, 'extract');
    const installDir = path.join(this.jreDir, platform);
    const stagingDir = path.join(this.jreDir, `${platform}.tmp-${process.pid}`);

    try {
      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(archivePath, archiveBuffer);
      await fs.mkdir(extractDir, { recursive: true });

      await this.extractTarGz(archivePath, extractDir);

      const extractedEntries = await fs.readdir(extractDir, { withFileTypes: true });
      const extractedDir = extractedEntries.find((entry) => entry.isDirectory());
      if (!extractedDir) {
        throw new Error(`Downloaded runtime archive for ${platform} did not contain an extracted runtime directory`);
      }

      const extractedRuntimeDir = path.join(extractDir, extractedDir.name);
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.rename(extractedRuntimeDir, stagingDir);
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.rename(stagingDir, installDir);

      this.log(`✅ Downloaded musl JRE for ${platform} (${packageJson.version})`);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractTarGz(archivePath: string, destinationDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
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
        reject(new Error(`Failed to extract runtime archive with tar (exit ${code}): ${stderr.trim() || 'no stderr captured'}`));
      });
    });
  }

  // Detect whether the current Linux system uses musl libc (Alpine, etc.) rather than glibc.
  // The bundled glibc JRE cannot exec on musl — its ELF interpreter /lib64/ld-linux-x86-64.so.2
  // does not exist there, producing an opaque ENOENT at spawn time.
  // The platform argument is injected so tests can exercise the matrix without mutating
  // process.platform (which is non-configurable on some Node versions).
  static isMuslLibc(platform: NodeJS.Platform = process.platform): boolean {
    if (platform !== 'linux') {
      return false;
    }
    // process.report.getReport() exposes glibcVersionRuntime when glibc is present.
    try {
      const report = (process as { report?: { getReport: () => { header?: { glibcVersionRuntime?: string } } } }).report;
      const glibcRuntime = report?.getReport?.().header?.glibcVersionRuntime;
      if (typeof glibcRuntime === 'string' && glibcRuntime.length > 0) {
        return false;
      }
    } catch {
      // Fall through to filesystem check.
    }
    // Fallback: presence of the musl loader in its standard path.
    return fsExistsSync('/lib/ld-musl-x86_64.so.1') || fsExistsSync('/lib/ld-musl-aarch64.so.1');
  }

  async ensureGatewayExists(): Promise<void> {
    const gatewayPath = path.join(this.gatewayDir, 'clientportal.gw');
    const runScript = path.join(gatewayPath, 'bin/run.sh');
    
    try {
      await fs.access(runScript);
      this.log('✅ IB Gateway found at:' + gatewayPath);
    } catch {
      throw new Error(`IB Gateway not found at ${gatewayPath}. Please ensure the gateway files are properly installed.`);
    }
  }

  // Public method for fast initialization (used during server startup)
  async quickStartGateway(): Promise<void> {
    this.log('⚡ Quick Gateway initialization...');
    
    // Quick check for existing Gateway (aggressive timeouts)
    const existingPort = await this.quickCheckExistingGateway();
    if (existingPort) {
      this.currentPort = existingPort;
      this.isReady = true;
      this.log(`✅ Using existing Gateway on port ${existingPort}`);
      return;
    }
    
    // No existing Gateway - start new one in background
    this.log('🚀 No existing Gateway found - starting new one in background...');
    this.startGatewayAsync();
  }
  
  // Start Gateway in background (non-blocking)
  startGatewayAsync(): void {
    if (this.backgroundStartupPromise) {
      this.log('Background Gateway startup already in progress');
      return;
    }
    
    // Wrap the startup in a promise that handles errors gracefully
    this.backgroundStartupPromise = (async () => {
      try {
        await this.startGatewayInternal();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.log(`❌ Background Gateway startup failed: ${errorMessage}`);
        // Reset the promise so sync startup can be attempted later
        this.backgroundStartupPromise = null;
        throw error;
      }
    })();
    
    // Add unhandled rejection handler to prevent process termination
    this.backgroundStartupPromise.catch((error) => {
      // Error already logged above, just prevent unhandled rejection
    });
  }
  
  // Ensure Gateway is ready (used by tool handlers)
  async ensureGatewayReady(): Promise<void> {
    if (this.isReady) {
      return; // Already ready
    }
    
    this.log('⏳ Tool called - ensuring Gateway is ready...');
    
    // First, try to find existing Gateway again (might have started since init)
    const existingPort = await this.findExistingGateway();
    if (existingPort) {
      this.currentPort = existingPort;
      this.isReady = true;
      this.log(`✅ Found existing Gateway on port ${existingPort}`);
      return;
    }
    
    // Wait for background startup if it's running
    if (this.backgroundStartupPromise) {
      this.log('⏳ Waiting for background Gateway startup to complete...');
      try {
        await this.backgroundStartupPromise;
        if (this.isReady) {
          return;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.log(`⚠️ Background startup failed, attempting synchronous start: ${errorMessage}`);
      }
    }
    
    // If no background startup or it failed, start synchronously
    this.log('⏳ Starting Gateway synchronously...');
    await this.startGatewayInternal();
  }
  
  // Backwards compatibility - redirect to quickStartGateway
  async startGateway(): Promise<void> {
    await this.quickStartGateway();
  }

  private async startGatewayInternal(): Promise<void> {
    if (this.isStarting || this.isReady) {
      this.log('Gateway is already starting or ready');
      return;
    }

    this.isStarting = true;
    this.spawnFailure = null;

    try {
      await this.ensureGatewayExists();
      
      // Check port availability for new Gateway
      this.log('🔍 Checking port availability for new Gateway...');
      const defaultPort = IBGatewayManager.getConfiguredGatewayPort();
      
      if (await PortUtils.isPortAvailable(defaultPort)) {
        this.currentPort = defaultPort;
        this.log(`✅ Using default port ${defaultPort}`);
      } else {
        this.log(`❌ Default port ${defaultPort} is occupied, trying to find alternative...`);
        try {
          this.currentPort = await PortUtils.findAvailablePort(5001, 9); // Try 5001-5009
          this.log(`✅ Found alternative port ${this.currentPort}`);
          
          // Create a temporary config file with the new port
          await ConfigUtils.createTempConfigWithPort(this.gatewayDir, this.currentPort);
          this.log(`📝 Created temporary config file with port ${this.currentPort}`);
        } catch (error) {
          this.log(`❌ No alternative ports available, will try with default port anyway`);
          this.currentPort = defaultPort;
        }
      }
      
      const bundledJavaPath = await this.getJavaPath();
      const bundledJavaHome = path.dirname(path.dirname(bundledJavaPath));
      const bundledJavaLibPath = path.join(bundledJavaHome, 'lib');
      const bundledJavaServerLibPath = path.join(bundledJavaLibPath, 'server');
      
      const configFile = this.currentPort === defaultPort ? 'root/conf.yaml' : `root/conf-${this.currentPort}.yaml`;
      const jarPath = path.join(this.gatewayDir, 'clientportal.gw/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar');
      const runtimePath = path.join(this.gatewayDir, 'clientportal.gw/build/lib/runtime/*');
      const configDir = path.join(this.gatewayDir, 'clientportal.gw/root');
      
      const classpath = `${configDir}:${jarPath}:${runtimePath}`;

      this.log('🚀 Starting IB Gateway with bundled JRE...');
      this.log('   Java: ' + bundledJavaPath);
      this.log('   Java Home: ' + bundledJavaHome);
      this.log('   Lib Path: ' + `${bundledJavaServerLibPath}:${bundledJavaLibPath}`);
      this.log('   Config: ' + configFile);
      this.log('   Port: ' + this.currentPort);
      
      this.gatewayProcess = spawn(bundledJavaPath, [
        '-server',
        '-Djava.awt.headless=true',
        '-Xmx512m',
        '-Dvertx.disableDnsResolver=true',
        '-Djava.net.preferIPv4Stack=true',
        '-Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory',
        '-Dnologback.statusListenerClass=ch.qos.logback.core.status.OnConsoleStatusListener',
        '-Dnolog4j.debug=true',
        '-Dnolog4j2.debug=true',
        '-cp', classpath,
        'ibgroup.web.core.clientportal.gw.GatewayStart',
        '--conf', `../${configFile}`
      ], {
        cwd: path.join(this.gatewayDir, 'clientportal.gw'),
        detached: true,
        env: {
          ...process.env,
          JAVA_HOME: bundledJavaHome,
          LD_LIBRARY_PATH: `${bundledJavaServerLibPath}:${bundledJavaLibPath}:${process.env.LD_LIBRARY_PATH || ''}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.gatewayProcess.unref();

      // Buffer the tail of stderr so we can include it in a failure reason if the process
      // dies before the gateway's HTTP port comes up.
      let stderrTail = '';

      this.gatewayProcess.stdout?.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          this.log(`[Gateway] ${output}`);
          // Check for startup completion indicators
          if (output.includes('Server ready') || output.includes('started on port')) {
            this.isReady = true;
            this.log('✅ IB Gateway is ready!');
          }
        }
      });

      this.gatewayProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrTail = (stderrTail + chunk).slice(-IBGatewayManager.STDERR_TAIL_BYTES);
        const trimmed = chunk.trim();
        if (trimmed && !trimmed.includes('WARNING')) {
          Logger.error(`[Gateway Error] ${trimmed}`);
        }
      });

      this.gatewayProcess.on('error', (error) => {
        Logger.error('❌ Gateway process error:', error.message);
        this.spawnFailure = {
          reason: this.diagnoseSpawnError(error, bundledJavaPath),
          details: error.message,
        };
        this.isStarting = false;
        this.isReady = false;
      });

      this.gatewayProcess.on('exit', (code, signal) => {
        this.log(`🛑 Gateway process exited with code ${code}, signal ${signal}`);
        // Any exit before the gateway became ready is a failure: a clean exit-0 means the JVM
        // terminated without ever opening the HTTP port (e.g. config error), and code===null
        // means the process was killed by a signal (e.g. OOM). Recording spawnFailure for all
        // of these makes waitForGateway() bail out fast instead of polling for 30s.
        if (!this.isReady && !this.spawnFailure) {
          const exitDescriptor =
            code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
          this.spawnFailure = {
            reason: `IB Gateway process exited (${exitDescriptor}) before becoming ready`,
            details: stderrTail.trim() || `(no stderr captured)`,
          };
        }
        this.gatewayProcess = null;
        this.isStarting = false;
        this.isReady = false;
      });

      // Wait for the gateway to be ready
      this.log('⏳ Waiting for IB Gateway to start...');
      await this.waitForGateway();
      
      this.isStarting = false;
      this.isReady = true;
      this.log('🎉 IB Gateway started successfully!');

    } catch (error) {
      this.isStarting = false;
      this.isReady = false;
      throw error;
    }
  }

  private async waitForGateway(): Promise<void> {
    const maxAttempts = 30; // 30 seconds
    let attempts = 0;

    while (attempts < maxAttempts) {
      // Bail out early if the child process already failed — no point polling for 30s.
      if (this.spawnFailure) {
        throw this.buildSpawnFailureError();
      }

      try {
        // Try to connect to the gateway port
        const response = await this.checkGatewayHealth(this.currentPort);
        if (response) {
          this.log(`✅ IB Gateway is responding on port ${this.currentPort}`);
          return;
        }
      } catch (error) {
        // Gateway not ready yet, continue waiting
      }

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (attempts % 5 === 0) {
        this.log(`⏳ Still waiting for gateway... (${attempts}/${maxAttempts})`);
      }
    }

    if (this.spawnFailure) {
      throw this.buildSpawnFailureError();
    }
    throw new Error('IB Gateway failed to start within 30 seconds');
  }

  private buildSpawnFailureError(): Error {
    const failure = this.spawnFailure!;
    const detail = failure.details ? `\nDetails: ${failure.details}` : '';
    return new Error(`${failure.reason}${detail}`);
  }

  private diagnoseSpawnError(error: NodeJS.ErrnoException, javaPath: string): string {
    if (error.code === 'ENOENT' && process.platform === 'linux' && IBGatewayManager.isMuslLibc()) {
      return `Failed to spawn bundled JRE at ${javaPath}: musl libc detected and the runtime is unavailable. ` +
        `Ensure the host can download the public musl JRE fallback, or preinstall runtime/${IBGatewayManager.resolveRuntimePlatform()}.`;
    }
    if (error.code === 'ENOENT') {
      return `Failed to spawn bundled JRE at ${javaPath}: file not found or its dynamic loader is missing on this system.`;
    }
    if (error.code === 'EACCES') {
      return `Failed to spawn bundled JRE at ${javaPath}: permission denied (the file may not be executable).`;
    }
    return `Failed to spawn IB Gateway: ${error.message}`;
  }

  private isLiveGatewayResponse(pathname: string, statusCode?: number): boolean {
    if (!statusCode) {
      return false;
    }

    if (pathname.startsWith('/v1/api/')) {
      // Unauthenticated Client Portal Gateway API endpoints commonly return 401.
      // That still proves the Gateway is alive and should be reused.
      return (
        statusCode === 200 ||
        statusCode === 204 ||
        statusCode === 302 ||
        statusCode === 401 ||
        statusCode === 403 ||
        statusCode === 405
      );
    }

    return (
      statusCode === 200 ||
      statusCode === 301 ||
      statusCode === 302 ||
      statusCode === 303 ||
      statusCode === 307 ||
      statusCode === 308 ||
      statusCode === 401 ||
      statusCode === 403
    );
  }

  private async probeGatewayEndpoint(
    https: typeof import('https'),
    port: number,
    pathname: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port,
        path: pathname,
        method: 'GET',
        rejectUnauthorized: false, // Accept self-signed certificates
        timeout: 5000,
      };

      const req = https.request(options, (res) => {
        res.resume();
        resolve(this.isLiveGatewayResponse(pathname, res.statusCode));
      });

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  private async checkGatewayHealth(port: number = this.currentPort): Promise<boolean> {
    // Import https dynamically to avoid issues with module resolution
    const https = await import('https');

    for (const pathname of IBGatewayManager.GATEWAY_HEALTH_PATHS) {
      const isReachable = await this.probeGatewayEndpoint(https, port, pathname);
      if (isReachable) {
        return true;
      }
    }

    return false;
  }

  async stopGateway(): Promise<void> {
    // Don't actually stop the gateway - just disconnect from it
    this.log('🔗 Disconnecting from IB Gateway (leaving it running)...');
    
    this.gatewayProcess = null;
    this.isReady = false;
    this.isStarting = false;
    
    this.log('✅ Disconnected from IB Gateway');
  }

  isGatewayReady(): boolean {
    return this.isReady;
  }

  getGatewayUrl(): string {
    return `https://localhost:${this.currentPort}`;
  }

  getCurrentPort(): number {
    return this.currentPort;
  }
}
