# Changelog

## [1.7.0] - 2026-05-20

- Reduced the model categories to just Gemini and Other according to the new quota system
- Added service status indicator in dashboard
- Ignored backend server glitches to prevent false 0% quota history entries
- Updated status bar, tooltip and dashboard quota colors to use six progress buckets
- Added ESLint checks for TypeScript source files

## [1.6.0] - 2026-03-22

- Removed session usage tracking in favor of the dashboard history panel
- Simplified model category names (Gemini Pro, Gemini Flash)
- Added a usage activity heatmap to the dashboard with monthly navigation
- General stability improvements and internal code cleanups

## [1.5.2] - 2026-03-13

- Fixed "Not started" detection for 7-day reset times
- Adjusted panel colors to better match the Antigravity theme
- Added a button in the dashboard and tooltip to open the official Models page
- Added an Extra Credits display to the dashboard
- Added sparkline charts to the dashboard history sections

## [1.5.1] - 2026-03-07

- Redesigned progress bars into five 20% segments matching the official Antigravity quota display
- Redesigned dashboard and history log with a more compact, organized, and modern look
- Added "Clear History" trash icon, "Export to JSON" button and "Refresh" action in dashboard

## [1.5.0] - 2026-02-25

- Added a sidebar Dashboard panel to visualize detailed quota usage and history logs
- Added the `ag-usage.enableHistoryTracking` setting to optionally disable quota history tracking
- Added the `ag-usage.dateFormatLocale` setting to customize dates formatting

## [1.4.4] - 2026-02-19

- Added settings to customize the status bar item alignment (`ag-usage.statusBarAlignment`) and priority (`ag-usage.statusBarPriority`)
- Updated the model names for Gemini and Claude

## [1.4.3] - 2026-02-05

- Changed the way plan name is fetched from the API response
- Added GEMINI.md file
- Added a "Reset Session" action in the tooltip to manually reset session usage statistics

## [1.4.2] - 2026-01-14

- Fixed UI overlap in tooltip when weekly quota warning is triggered

## [1.4.1] - 2026-01-13

- Added plan display (Free/Pro/Ultra) in tooltip
- Fixed "Not started" showing incorrectly in some cases
- Added "Weekly Quota Exceeded" warning in tooltip for Pro/Ultra users

## [1.4.0] - 2026-01-06

- Redesigned tooltip with more detailed cards
- Added session usage tracking with optional per-window isolation (`trackSessionUsage`, `perWindowSession`, `showSessionUsageInStatusBar`)
- Added configurable reset time display with 12h/24h format support (`resetTimeDisplay`, `absoluteTimeFormat`)
- Added quota notifications for full and low thresholds (`notifyOnFullQuota`, `lowQuotaNotificationThreshold`)
- Optimized bundling with `esbuild` and general stability improvements

## [1.3.2] - 2025-12-31

- Fix: Resolved "spawn ss ENOENT" error on Linux systems missing the `ss` command by adding proper fallbacks to `lsof` and `netstat`

## [1.3.1] - 2025-12-29

- Fix: Added process ownership and $HOME validation to ensure correct quota display in multi-user environments (thanks to @costis-t)

## [1.3.0] - 2025-12-29

- Added Open Settings button in the status bar item tooltip
- Refactored code to use classes for better maintainability and stability
- Fixed some connection issues
- Added extension logging (check `Output` > `AG Usage`) for debugging purposes

## [1.2.0] - 2025-12-27

- Fix: Tooltip text was hard to read on light themes
- Added support for customizing the status bar displayed information (`ag-usage.statusBarDisplay`)

## [1.1.0] - 2025-12-26

- Added support for customizing the refresh interval (`ag-usage.refreshInterval`)
- The timer is now visible only when the reset quota time is triggered
- Parallelized port discovery for faster connection

## [1.0.0] - 2025-12-24

- Initial release
