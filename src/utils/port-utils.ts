import { exec } from 'child_process';
import net from 'net';
import os from 'os';
import { Logger } from '../logger.js';

export class PortUtils {
  static async isPortAvailable(port: number): Promise<boolean> {
    // Probe by actually attempting to bind the port. This is accurate and
    // cross-platform; the previous `netstat | findstr :PORT` approach matched
    // substrings (e.g. ":5000" also matched ephemeral ":50001"), producing
    // false negatives on Windows that forced the Gateway off its default port.
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => {
        // EADDRINUSE (or EACCES) -> not available for us to bind
        resolve(false);
      });
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, '0.0.0.0');
    });
  }

  static async findAvailablePort(startPort: number = 5000, maxAttempts: number = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      const available = await this.isPortAvailable(port);
      if (available) {
        return port;
      }
    }
    throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts - 1}`);
  }

  static async isGatewayProcess(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const platform = os.platform();
      let command: string;
      
      switch (platform) {
        case 'win32':
          command = `netstat -ano | findstr :${port}`;
          break;
        case 'darwin':
          command = `lsof -i :${port} -n -P`;
          break;
        case 'linux':
          command = `ss -tlnp | grep :${port} || netstat -tlnp | grep :${port}`;
          break;
        default:
          command = `lsof -i :${port} -n -P`;
          break;
      }
      
      exec(command, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(false);
          return;
        }
        
        const output = stdout.toLowerCase();
        Logger.info(`Existing process running on port ${port}: ${output}`);
        // Look for indicators that this is likely a Gateway process
        const gatewayIndicators = [
          'java',           // Gateway runs on Java
          'clientportal',   // Gateway directory/process name
          'gateway',        // Generic gateway indicator
          'ib',            // Interactive Brokers
        ];
        
        const isGateway = gatewayIndicators.some(indicator => output.includes(indicator));
        resolve(isGateway);
      });
    });
  }

  static async findExistingGateway(): Promise<number | null> {
    const commonPorts = [5000, 5001, 5002, 5003, 5004, 5005];
    
    for (const port of commonPorts) {
      const isInUse = !(await this.isPortAvailable(port));
      if (isInUse) {
        const isGateway = await this.isGatewayProcess(port);
        if (isGateway) {
          return port;
        }
      }
    }
    
    return null;
  }
}
