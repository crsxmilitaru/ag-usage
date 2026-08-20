# Project: AG Usage VS Code Extension

## Overview

AG Usage (`ag-usage`) is a Visual Studio Code extension designed to monitor and display real-time usage and quotas for Antigravity AI models (Gemini, Claude, etc.) directly in the status bar and an interactive sidebar webview dashboard.

## Tech Stack

- **Framework**: VS Code Extension API (`^1.107.0`)
- **Language**: TypeScript (target ES2022, Node16 module resolution)
- **Build Tool**: esbuild (`^0.28.2`)
- **Linter**: ESLint v9+ flat config (`eslint.config.mjs`, `typescript-eslint`)
- **Runtime**: Node.js (VS Code Extension Host)

## Project Structure

- `src/extension.ts`: Extension entry point. Handles activation, deactivation, command registrations, configuration change events, `ExtensionState` lifecycle management, and refresh scheduling.
- `src/api.ts`: API interaction layer. Discovers running Antigravity processes, extracts CSRF tokens and ports, communicates with internal `LanguageServerService` endpoints (`RetrieveUserQuotaSummary`, `GetUserStatus`, `GetUnleashData`), and aggregates quota statistics.
- `src/renderer.ts`: Status bar rendering logic. Constructs status bar text, countdown indicators, and rich Markdown tooltips.
- `src/panel.ts`: Webview panel provider (`UsageViewProvider` implementing `vscode.WebviewViewProvider`). Renders the interactive sidebar dashboard (`ag-usage.sidebarPanel`) with live quota gauges, daily activity heatmap, history charts, model lists, and service health status.
- `src/history.ts`: State management for quota history and daily usage tracking (`QuotaHistory`, `QuotaHistoryEntry`, `DailyUsageEntry`).
- `src/formatter.ts`: Helper functions for formatting dates, times, relative countdowns, quota percentages, and error tooltips.
- `src/notifications.ts`: Quota alerts and threshold notifications (`NotificationManager`) for full quota refills and low quota warnings.
- `src/statusgator.ts`: Public service status monitor. Scrapes and parses Google Antigravity service health and outage reports from StatusGator.
- `src/environment.ts`: Environment detection helper (e.g., detects if running inside Antigravity IDE or standard VS Code).
- `src/platform.ts`: Cross-platform process query strategies (`WindowsPlatform` and `UnixPlatform`) for querying OS processes and parsing network ports.
- `src/constants.ts`: Configuration keys, command IDs, default values, API endpoints, time constants, and UI theme colors.
- `src/types.ts`: TypeScript interfaces and type definitions for API responses, quota metrics, platform discovery, and extension state.
- `src/utils.ts`: General helper utilities (data sanitization, PID/port validation, delay, HTML escaping).
- `package.json`: Defines extension manifest, activation events, sidebar webview view container, commands, configuration properties, menus, and build scripts.
- `tsconfig.json`: TypeScript compiler configuration.
- `eslint.config.mjs`: ESLint configuration for code quality and style rules.
- `dev/`: Development mock data (`testData.json`) and data structure documentation (`AVAILABLE_DATA.md`).
- `scripts/convert-svg.js`: Asset conversion script for generating PNG icons from SVG assets using `@resvg/resvg-js`.

## Coding Guidelines

### General

- **Clarity**: Prioritize code readability, maintainability, and clean separation of concerns.
- **Async/Await**: Use `async/await` for all asynchronous operations.
- **Error Handling**: Catch errors explicitly. Log failures to the extension's output channel using `ExtensionState.log` rather than `console.log`. Never use empty catch blocks.
- **State**: Centralize extension state management within the `ExtensionState` class.

### Style & Conventions

- **Indentation**: Follow the existing indentation style (use tabs).
- **Naming Operations**:
  - Variables/Functions: `camelCase`
  - Classes/Interfaces: `PascalCase`
  - **Interface Naming**: Do NOT prefix interfaces with `I` (e.g., use `UsageStatistics`, not `IUsageStatistics`).
- **Semicolons**: Always use semicolons at the end of statements.
- **Quotes**: Use single quotes `'` for strings, except when template literals are needed.
- **Line Endings**: Use CRLF line endings.

### Configuration

- New settings must be defined in the `contributes.configuration` section of `package.json`.
- Access configuration using `vscode.workspace.getConfiguration('ag-usage')`.
- Handle configuration updates dynamically in the `vscode.workspace.onDidChangeConfiguration` event listener.

## Development Workflow

- **Build**: `npm run compile` to build the minified extension bundle using esbuild.
- **Watch Mode**: `npm run watch` to automatically rebuild on file changes with sourcemaps enabled.
- **Lint**: `npm run lint` or `npm run lint:fix` to run ESLint across TypeScript source files.
- **Packaging**: `npm run package` to generate a `.vsix` file using `@vscode/vsce`.
- **Publishing**: `npm run publish` (or `publish:vsce` / `publish:ovsx`) for marketplace releases.
- **Mock Data**: Set `USE_MOCK_DATA = true` in `src/constants.ts` to test UI rendering against `dev/testData.json` when the backend process is unavailable.
