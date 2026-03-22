# Project: AG Usage VS Code Extension

## Overview

This is a Visual Studio Code extension (`ag-usage`) designed to track and display real-time usage of Antigravity AI models directly in the status bar.

## Tech Stack

- **Framework**: VS Code Extension API
- **Language**: TypeScript (target ES2022)
- **Build Tool**: esbuild
- **Runtime**: Node.js (VS Code Extension Host)

## Project Structure

- `src/extension.ts`: The main entry point. Initializes the extension, registers commands, manages state (`ExtensionState`), and orchestrates the refresh loop.
- `src/api.ts`: API interaction layer. Responsible for:
  - Locating the Antigravity process.
  - Extracting the CSRF token from the process command line.
  - Identifying listening ports.
  - Fetching usage statistics from the local server.
- `src/renderer.ts`: UI rendering logic. Constructs the status bar text and complex markdown tooltips.
- `src/panel.ts`: Webview panel provider. Renders the detailed quota history and statistics in a side panel.
- `src/history.ts`: Manages quota history state and tracks usage changes over time.
- `src/formatter.ts`: Helper functions for formatting dates, times, and converting values to human-readable strings.
- `src/types.ts`: TypeScript interfaces and type definitions.
- `src/platform.ts`: Platform-specific strategies (Windows/Unix) for querying OS processes and parsing network ports using native commands.
- `src/constants.ts`: Configuration keys, default values, and application constants.
- `src/utils.ts`: General utility functions.
- `package.json`: Defines the extension manifest, activation events, contribution points (commands, configuration), and build scripts.

## Coding Guidelines

### General

- **Clarity**: Prioritize code readability and maintainability.
- **Async/Await**: Use `async/await` for all asynchronous operations.
- **Error Handling**: Catch errors explicitly. Log failures to the extension's output channel using the `ExtensionState.log` method (or similar logging utility) rather than `console.log`.
- **State**: Centralize state management within the `ExtensionState` class where possible.

### Style & Conventions

- **Indentation**: Follow the existing indentation style (use tabs).
- **Naming Operations**:
  - Variables/Functions: `camelCase`
  - Classes/Interfaces: `PascalCase`
  - **Interface Naming**: Do NOT prefix interfaces with `I` (e.g., use `UsageStatistics`, not `IUsageStatistics`).
- **Semicolons**: Always use semicolons at the end of statements.
- **Quotes**: Use single quotes `'` for strings, except when template literals are needed.

### Configuration

- New settings should be defined in the `contributes.configuration` section of `package.json`.
- Access configuration using `vscode.workspace.getConfiguration('ag-usage')`.
- Handle configuration changes in the `vscode.workspace.onDidChangeConfiguration` event listener.

## Development Workflow

- **Build**: Run `npm run compile` to build the extension.
- **Watch Mode**: Run `npm run watch` to automatically rebuild on file changes.
- **Packaging**: Run `npm run package` to generate a `.vsix` file for distribution.
- **Mock Data**: The extension supports using mock data for testing UI rendering when the backend is unavailable or for testing specific scenarios.
