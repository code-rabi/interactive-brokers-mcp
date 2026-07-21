import { existsSync } from 'fs';

// Resolve the runtime platform key (e.g. "linux-x64", "darwin-arm64", "linux-x64-musl")
// used to look up the matching Java runtime in the dependency manifest. The platform/arch
// arguments are injected so tests can exercise the matrix without mutating process.platform
// (which is non-configurable on some Node versions).
export function resolveRuntimePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  let runtimePlatform = `${platform}-${arch}`;
  if (platform === 'linux' && isMuslLibc(platform)) {
    runtimePlatform = `${runtimePlatform}-musl`;
  }
  return runtimePlatform;
}

// Detect whether the current Linux system uses musl libc (Alpine, etc.) rather than glibc.
// A glibc JRE cannot exec on musl — its ELF interpreter /lib64/ld-linux-x86-64.so.2 does not
// exist there, producing an opaque ENOENT at spawn time.
export function isMuslLibc(platform: NodeJS.Platform = process.platform): boolean {
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
  return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
}
