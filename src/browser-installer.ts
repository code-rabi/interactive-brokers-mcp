import { chromium, Browser } from 'playwright-core';
import { Logger } from './logger.js';

export interface BrowserConnectionResult {
  browser: Browser;
  isRemote: boolean;
}

export class BrowserInstaller {
  /**
   * Connect to a remote browser if endpoint is provided
   */
  static async connectToRemoteBrowser(endpoint: string): Promise<Browser> {
    Logger.info(`🌐 Connecting to remote browser at ${endpoint}...`);
    try {
      const browser = await chromium.connectOverCDP(endpoint);
      Logger.info('✅ Successfully connected to remote browser');
      return browser;
    } catch (error) {
      Logger.error(`❌ Failed to connect to remote browser: ${error}`);
      throw new Error(`Remote browser connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Launch a local browser using Playwright's default behavior or system Chromium
   */
  static async launchLocalBrowser(): Promise<Browser> {
    Logger.info('🔧 Starting local browser with Playwright...');
    try {
      // Check for system Chromium executable path from environment
      const systemChromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                                 process.env.CHROMIUM_PATH ||
                                 process.env.GOOGLE_CHROME_BIN;

      const launchOptions: any = {
        headless: true,
        args: this.getChromiumLaunchArgs()
      };

      // If we have a system Chromium path, use it
      if (systemChromiumPath) {
        Logger.info(`🎯 Using system Chromium at: ${systemChromiumPath}`);
        launchOptions.executablePath = systemChromiumPath;
      } else {
        Logger.info('🔧 Using Playwright\'s default Chromium');
      }

      const browser = await chromium.launch(launchOptions);
      Logger.info('✅ Local browser started successfully');
      return browser;
    } catch (error) {
      Logger.error('❌ Failed to start local browser:', error);
      
      // Provide helpful error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      const suggestions = [
        '- Use a remote browser: set IB_BROWSER_ENDPOINT=ws://browser:3000',
        '- Use a browser service: set IB_BROWSER_ENDPOINT=wss://chrome.browserless.io?token=YOUR_TOKEN',
        '- Install Chromium locally: apk add chromium',
        '- Set system Chromium path: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser',
        '- Disable headless mode: set IB_HEADLESS_MODE=false'
      ];
      
      const helpText = `\n\nSuggestions:\n${suggestions.join('\n')}`;
      throw new Error(`Local browser startup failed: ${errorMessage}${helpText}`);
    }
  }

  static getChromiumLaunchArgs(): string[] {
    return [
      '--headless=new',
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
  }
}