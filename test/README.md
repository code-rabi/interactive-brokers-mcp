# Interactive Brokers MCP - Test Suite

This directory contains the test suite for the Interactive Brokers MCP server using Vitest.

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (reruns on file changes)
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

## Test Structure

### `test/setup.ts`
Global test setup file that configures the test environment, mocks, and cleanup.

### `test/tool-definitions.test.ts`
Tests for Zod schemas and validation:
- Order validation (strict allowlisted limit-stock orders)
- Fractional share quantity support
- Required field validation
- Schema refinements

### `test/ib-client.test.ts`
Tests for the IBClient class:
- Session management and authentication
- Automatic tickle for session maintenance
- API method calls (orders, positions, market data)
- Port updates and reinitialization
- Error handling

### `test/tool-handlers.test.ts`
Tests for tool handlers:
- Tool execution flow
- Input validation
- Error handling and formatting
- Headless mode authentication
- Gateway readiness checks

## Test Coverage

Run `npm run test:coverage` to generate a coverage report. The report will be available in:
- Terminal output (text summary)
- `coverage/` directory (HTML report)

## Mocking Strategy

The tests use Vitest's mocking capabilities to:
- Mock axios for HTTP requests
- Mock IBGatewayManager for gateway operations
- Mock headless authentication
- Mock browser operations (playwright)

This allows tests to run quickly without actual network calls or browser automation.

## Adding New Tests

When adding new features:
1. Add tests for Zod schemas in `tool-definitions.test.ts`
2. Add tests for IBClient methods in `ib-client.test.ts`
3. Add tests for tool handlers in `tool-handlers.test.ts`
4. Ensure all tests pass before committing: `npm test`
