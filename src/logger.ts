import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// File-based logging utility that never interferes with MCP protocol
export class Logger {
  private static logDir = process.env.IB_MCP_LOG_DIR || join(homedir(), '.ib-mcp');
  private static logFile = join(Logger.logDir, 'ib-mcp.log');
  private static enableLogging = process.env.IB_MCP_DISABLE_LOGGING !== 'true';
  private static enableConsoleLogging = process.env.IB_MCP_CONSOLE_LOGGING === 'true' || 
                                       process.argv.includes('--console-logging') ||
                                       process.argv.includes('--log-console');

  private static ensureLogDir() {
    if (!Logger.enableLogging) return;
    if (!existsSync(Logger.logDir)) {
      try {
        mkdirSync(Logger.logDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // If we can't create log dir, disable logging
        Logger.enableLogging = false;
      }
    }
    try {
      chmodSync(Logger.logDir, 0o700);
    } catch {
      Logger.enableLogging = false;
    }
  }

  private static writeToFile(level: string, message: string, ...args: any[]) {
    if (!Logger.enableLogging) return;
    
    try {
      Logger.ensureLogDir();
      const timestamp = new Date().toISOString();
      const argsStr = args.length > 0 ? ' ' + args.map(arg => 
        Logger.serializeArgument(arg)
      ).join(' ') : '';
      const logLine = `${timestamp} [${level}] ${message}${argsStr}\n`;
      appendFileSync(Logger.logFile, logLine, { encoding: 'utf8', mode: 0o600 });
      chmodSync(Logger.logFile, 0o600);
    } catch (error) {
      // Silently fail to avoid recursive logging issues
    }
  }

  private static writeToConsole(level: string, message: string, ...args: any[]) {
    if (!Logger.enableConsoleLogging) return;
    
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ' ' + args.map(arg => 
      Logger.serializeArgument(arg)
    ).join(' ') : '';
    const logLine = `${timestamp} [${level}] ${message}${argsStr}`;
    
    // Use stderr to avoid interfering with MCP JSON-RPC on stdout
    console.error(logLine);
  }

  private static writeLog(level: string, message: string, ...args: any[]) {
    Logger.writeToFile(level, message, ...args);
    Logger.writeToConsole(level, message, ...args);
  }

  static log(message: string, ...args: any[]) {
    Logger.writeLog('LOG', message, ...args);
  }

  static error(message: string, ...args: any[]) {
    Logger.writeLog('ERROR', message, ...args);
  }

  static info(message: string, ...args: any[]) {
    Logger.writeLog('INFO', message, ...args);
  }

  static debug(message: string, ...args: any[]) {
    if (process.env.DEBUG) {
      Logger.writeLog('DEBUG', message, ...args);
    }
  }

  static critical(message: string, ...args: any[]) {
    Logger.writeLog('CRITICAL', message, ...args);
  }

  static warn(message: string, ...args: any[]) {
    Logger.writeLog('WARN', message, ...args);
  }

  // Get the current log file path (useful for debugging)
  static getLogFile(): string | null {
    return Logger.enableLogging ? Logger.logFile : null;
  }

  // Log a startup message with log file location
  static logStartup() {
    if (Logger.enableLogging || Logger.enableConsoleLogging) {
      const logDestinations = [];
      if (Logger.enableLogging) logDestinations.push(`file: ${Logger.logFile}`);
      if (Logger.enableConsoleLogging) logDestinations.push('console');
      Logger.info(`IB MCP Server started - logging to: ${logDestinations.join(', ')}`);
    }
  }

  // Check if console logging is enabled
  static isConsoleLoggingEnabled(): boolean {
    return Logger.enableConsoleLogging;
  }

  // Helper method to properly serialize arguments including error objects
  private static serializeArgument(arg: any): string {
    if (arg instanceof Error) {
      // For Error objects, extract all important properties including non-enumerable ones
      try {
        return JSON.stringify({
          ...arg,
          name: arg.name,
          message: arg.message,
          stack: arg.stack,        
        });
      } catch (circularError) {
        // If even the error object has circular references, return basic info
        return `[Error: ${arg.name}: ${arg.message}]`;
      }
    } else if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, Logger.getCircularReplacer());
      } catch (circularError) {
        // Handle other serialization errors
        return '[Object with serialization error]';
      }
    } else {
      return String(arg);
    }
  }

  // Helper method to create a replacer function for handling circular references
  private static getCircularReplacer() {
    const seen = new WeakSet();
    return (key: string, value: any) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }
      return value;
    };
  }
}
