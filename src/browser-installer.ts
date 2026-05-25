import { chromium, Browser } from 'playwright-core';
import { Logger } from './logger.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class BrowserInstaller {
  static headless: boolean = true; // Set this to false to debug 
  /**
   * Launch a local browser using Playwright's default behavior or system Chromium
   */
  static async launchLocalBrowser(): Promise<Browser> {
    Logger.info('🔧 Starting local browser with Playwright...');
    try {
      // Find the best available browser executable
      const executablePath = await this.findBrowserExecutable();
      
      const launchOptions: any = {
        headless: this.headless,
        args: this.getChromiumLaunchArgs(this.headless) // Pass headless=false to avoid conflicting args
      };

      if (executablePath) {
        Logger.info(`🎯 Using browser at: ${executablePath}`);
        launchOptions.executablePath = executablePath;
      } else {
        Logger.info('🔧 Using Playwright\'s default Chromium');
      }

      const browser = await chromium.launch(launchOptions);
      Logger.info('✅ Local browser started successfully');
      return browser;
    } catch (error) {
      Logger.error('❌ Failed to start local browser:', error);
      
      // Provide helpful error message with platform-specific suggestions
      const errorMessage = error instanceof Error ? error.message : String(error);
      const suggestions = this.getPlatformSpecificSuggestions();
      
      const helpText = `\n\nSuggestions:\n${suggestions.join('\n')}`;
      throw new Error(`Local browser startup failed: ${errorMessage}${helpText}`);
    }
  }

  /**
   * Find the best available browser executable on the system
   */
  private static async findBrowserExecutable(): Promise<string | null> {
    // Check environment variables first
    const envPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROMIUM_PATH,
      process.env.GOOGLE_CHROME_BIN,
      process.env.CHROME_BIN
    ].filter(Boolean);

    for (const envPath of envPaths) {
      if (envPath && await this.isExecutableFile(envPath)) {
        Logger.info(`🔍 Found browser via environment variable: ${envPath}`);
        return envPath;
      }
    }

    // Platform-specific search paths
    const searchPaths = this.getPlatformBrowserPaths();
    
    for (const browserPath of searchPaths) {
      if (await this.isExecutableFile(browserPath)) {
        Logger.info(`🔍 Found system browser: ${browserPath}`);
        return browserPath;
      }
    }

    const playwrightBrowserPath = await this.findPlaywrightCacheBrowser();
    if (playwrightBrowserPath) {
      Logger.info(`🔍 Found Playwright cached browser: ${playwrightBrowserPath}`);
      return playwrightBrowserPath;
    }

    Logger.warn('⚠️ No system browser found, will try Playwright default');
    return null;
  }

  private static async findPlaywrightCacheBrowser(): Promise<string | null> {
    const cacheRoots = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      path.join(os.homedir(), '.cache', 'ms-playwright'),
    ].filter(Boolean) as string[];

    for (const cacheRoot of cacheRoots) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(cacheRoot);
      } catch {
        continue;
      }

      const chromiumDirs = entries
        .filter((entry) => entry.startsWith('chromium-'))
        .sort()
        .reverse();

      for (const entry of chromiumDirs) {
        const candidates = [
          path.join(cacheRoot, entry, 'chrome-linux64', 'chrome'),
          path.join(cacheRoot, entry, 'chrome-linux', 'chrome'),
        ];

        for (const candidate of candidates) {
          if (await this.isExecutableFile(candidate)) {
            return candidate;
          }
        }
      }
    }

    return null;
  }

  /**
   * Get platform-specific browser search paths
   */
  private static getPlatformBrowserPaths(): string[] {
    const platform = process.platform;
    
    switch (platform) {
      case 'darwin': // macOS
        return [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/usr/local/bin/chrome',
          '/usr/local/bin/chromium',
          '/opt/homebrew/bin/chrome',
          '/opt/homebrew/bin/chromium'
        ];
      
      case 'linux':
        return [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
          '/usr/local/bin/chrome',
          '/usr/local/bin/chromium'
        ];
      
      case 'win32':
        return [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Chromium\\Application\\chromium.exe',
          'C:\\Program Files (x86)\\Chromium\\Application\\chromium.exe'
        ];
      
      default:
        return [];
    }
  }

  /**
   * Get platform-specific suggestions for fixing browser issues
   */
  private static getPlatformSpecificSuggestions(): string[] {
    const platform = process.platform;
    
    switch (platform) {
      case 'darwin': // macOS
        return [
          '- Install Chrome: brew install --cask google-chrome',
          '- Install Chromium: brew install --cask chromium',
          '- Install Playwright browsers: npx playwright install chromium',
          '- Set custom path: export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
        ];
      
      case 'linux':
        return [
          '- Install Chrome: apt-get install google-chrome-stable',
          '- Install Chromium: apt-get install chromium-browser',
          '- Install Playwright browsers: npx playwright install chromium',
          '- Set custom path: export CHROME_BIN=/usr/bin/google-chrome'
        ];
      
      case 'win32':
        return [
          '- Install Chrome from https://www.google.com/chrome/',
          '- Install Playwright browsers: npx playwright install chromium',
          '- Set custom path: set CHROME_BIN="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
        ];
      
      default:
        return [
          '- Install Playwright browsers: npx playwright install chromium',
          '- Set custom path with CHROME_BIN environment variable'
        ];
    }
  }

  /**
   * Check if a file exists and is executable
   */
  private static async isExecutableFile(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile() && !!(stats.mode & parseInt('111', 8));
    } catch {
      return false;
    }
  }

  static getChromiumLaunchArgs(headless: boolean = true): string[] {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // Only add headless arg if headless mode is requested
    if (headless) {
      args.unshift('--headless=new');
    }

    return args;
  }
}
