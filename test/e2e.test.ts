import { describe, it, expect } from 'vitest';
import { IBGatewayManager } from '../src/gateway-manager.js';
import { IBClient } from '../src/ib-client.js';
import { HeadlessAuthenticator } from '../src/headless-auth.js';

describe('E2E Headless Authentication Flow', () => {
  // E2E test runs only when credentials are provided in the environment.
  const username = process.env.IB_USERNAME;
  const password = process.env.IB_PASSWORD;
  const isCredentialsProvided = Boolean(username && password);

  it.skipIf(!isCredentialsProvided)(
    'should start gateway, connect client, and authenticate headlessly',
    async () => {
      console.log('🚀 Starting E2E Headless Authentication test...');
      const gatewayManager = new IBGatewayManager();
      let authenticator: HeadlessAuthenticator | null = null;
      let client: IBClient | null = null;

      try {
        // 1. Quick start gateway and wait for it to be ready
        console.log('1. Starting IB Gateway...');
        await gatewayManager.quickStartGateway();
        await gatewayManager.ensureGatewayReady();
        const port = gatewayManager.getCurrentPort();
        const url = gatewayManager.getGatewayUrl();
        console.log(`✅ Gateway is running on port ${port} (URL: ${url})`);

        // 2. Initialize IB Client
        console.log('2. Initializing IB Client...');
        client = new IBClient({
          host: 'localhost',
          port: port,
        });

        // 3. Authenticate headlessly
        console.log('3. Initiating headless authentication...');
        authenticator = new HeadlessAuthenticator();
        const authResult = await authenticator.authenticate({
          url,
          username: username!,
          password: password!,
          ibClient: client,
          paperTrading: true, // E2E is designed for paper trading
          timeout: 120000,    // 2 minutes timeout for E2E authentication
        });

        console.log('Auth Result:', authResult);

        // 4. Verify results
        expect(authResult.success).toBe(true);
        expect(authResult.status).toBe('SUCCESS');

        // Verify client session is authenticated
        const isAuthenticated = await client.checkAuthenticationStatus();
        expect(isAuthenticated).toBe(true);
        console.log('🎉 E2E Headless Authentication Test Passed!');
      } finally {
        console.log('🧹 Cleaning up E2E resources...');
        if (authenticator) {
          try {
            await authenticator.close();
          } catch (e) {
            console.error('Error closing authenticator:', e);
          }
        }
        if (client) {
          try {
            client.destroy();
          } catch (e) {
            console.error('Error destroying client:', e);
          }
        }
        if (gatewayManager) {
          try {
            await gatewayManager.stopGateway();
          } catch (e) {
            console.error('Error stopping gateway:', e);
          }
        }
      }
    },
    180000 // 3 minutes timeout
  );
});
