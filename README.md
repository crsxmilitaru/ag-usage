<!-- markdownlint-disable MD033 -->

<h1 align="center">🚀 AG Usage</h1>

<p align="center">
  <strong>Real-time usage tracking for Antigravity AI models</strong>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/crsx/ag-usage"><img src="https://img.shields.io/open-vsx/v/crsx/ag-usage?logo=open-vsx&label=Open%20VSX&logoColor=white" alt="Open VSX Version"></a>
  <a href="https://open-vsx.org/extension/crsx/ag-usage"><img src="https://img.shields.io/open-vsx/dt/crsx/ag-usage" alt="Open VSX Downloads"></a>
  <br>
  <a href="https://github.com/crsxmilitaru/ag-usage"><img src="https://img.shields.io/badge/GitHub-Repository-181717?logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://github.com/crsxmilitaru/ag-usage/stargazers"><img src="https://img.shields.io/github/stars/crsxmilitaru/ag-usage" alt="GitHub Stars"></a>
  <a href="https://github.com/crsxmilitaru/ag-usage/blob/main/LICENSE"><img src="https://img.shields.io/github/license/crsxmilitaru/ag-usage?style=flat" alt="License"></a>
  <a href="https://www.paypal.com/donate?hosted_button_id=MZQS5CZ68NGEW"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white" alt="Donate"></a>
</p>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/crsxmilitaru/ag-usage/main/assets/preview.png" alt="AG Usage Preview" style="width: 100%; max-width: 800px; border-radius: 8px; border: 1px solid #30363d; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
</p>

## ✨ Features

- **Webview panel**: Includes a dashboard showing your current quotas, Extra Credits, a complete history log of all usage changes, a usage activity heatmap with monthly navigation, and a button to open the official Models page.

- **Status bar integration**: Displays a configurable status bar item showing your model quota usage.

- **Auto-refresh**: Usage data is automatically updated every 60 seconds by default, but can be configured. By default, it also pauses background refreshes when the IDE window is unfocused.

- **Detailed tooltip**: Hover over the status bar item to see a detailed breakdown and visual progress bars for model categories (as they are calculated by Antigravity):
  - **Gemini** - Gemini Pro and Gemini Flash models
  - **Other** - Claude and GPT models

- **Quota reset timer**: Each model category displays the time remaining until quota resets, highlighted in green when less than 10 minutes remains. Time is displayed only when the Antigravity quota reset timer is triggered (first use of the AI model after a 100% usage).

- **Cross-platform**: Fully compatible with **Windows**, **macOS**, and **Linux**.

- **Public service status**: Shows StatusGator public health information for Google Antigravity alongside the local connection status.

## 📖 Usage

1. **Install** the extension.
2. Look for the 🚀 icon in the right part of the bottom status bar.
3. **Hover** over the icon to view detailed usage per model category.
4. **Click** the icon to refresh data manually.

## 📝 Configuration

- `ag-usage.refreshInterval`: Set the interval (in seconds) between automatic refreshes. Set to `0` to disable auto-refresh. Default is `60` seconds.

- `ag-usage.pauseWhenUnfocused`: Pause automatic background refresh when the VS Code window is not focused. Default is `true`.

- `ag-usage.statusBarDisplay`: Control what information is shown in the status bar. Options:
  - `average` - Shows the average usage across all groups
  - `all` (default) - Shows both groups side by side (e.g., `Gemini: 80% | Other: 50%`)
  - `gemini` - Shows only Gemini usage
  - `other` - Shows only Other usage

- `ag-usage.statusBarLimitDisplay`: Control how to display the quota limits in the status bar. Options:
  - `only5h` - Shows only the 5-hour quota (e.g., `Gemini 77%`)
  - `both` (default) - Shows both 5-hour and weekly quotas (e.g., `Gemini 21% (99%)`)

- `ag-usage.statusBarAlignment`: Control the alignment of the status bar item. Options: `Left`, `Right` (default).

- `ag-usage.statusBarPriority`: Control the priority of the status bar item. Higher values move the item further to the left (for Right alignment). Default is `100`.

- `ag-usage.statusBarCountdown`: Show time remaining until next reset in the status bar when quota reaches 0%. Default is `true`.

- `ag-usage.notifyOnFullQuota`: Show a notification when a model category reaches 100% usage. Default is `false`.

- `ag-usage.lowQuotaNotificationThreshold`: Percentage threshold to show a warning when quota drops below this value. Default is `0` (disabled). Set to a value like `10` to enable.

- `ag-usage.resetTimeDisplay`: How to display the quota reset time. Options: `relative`, `absolute`, `both` (default).

- `ag-usage.absoluteTimeFormat`: Time format for absolute reset time display. Options: `24h` (default), `12h`.

- `ag-usage.dateFormatLocale`: Locale for date formatting (e.g., `'en-US'`, `'ro-RO'`, `'default'`). Default is `'default'`.

- `ag-usage.enableHistoryTracking`: Enable tracking of quota usage history over time. Default is `true`.

- `ag-usage.enablePublicStatus`: Fetch public Google Antigravity service health from StatusGator. When disabled, the dashboard only checks the local usage API. Default is `true`.

- `ag-usage.maxHistoryItems`: Maximum number of history items to persist per group. Default is `50`.

## ⚙️ Commands

- `ag-usage.refresh`: Manually triggers a scan for the Antigravity process and updates usage statistics.

- `ag-usage.openSettings`: Opens the AG Usage configuration page.

- `ag-usage.openPanel`: Opens the AG Usage detailed webview panel that shows current quotas and history of quota changes.

- `ag-usage.exportHistory`: Export the metadata history log to a JSON file (available in the dashboard title bar).

## 🔒 Security & Privacy

- **Local quota communication:** The extension reads quota data from your local Antigravity process over localhost.
- **Public status check:** The dashboard fetches public Google Antigravity service health from StatusGator. Disable it with the `ag-usage.enablePublicStatus` setting.
- **Limited local persistence:** It stores quota history metadata locally in VS Code global state (category, quota delta, timestamps, reset time) to power the history panel.

## 📝 Notes

- Data from server may have a 3-5 minute margin of error. This can result in a "Soon" status or temporary delays in quota synchronization.

- At the moment, it is not possible to retrieve the actual token quota.

- Starting with Antigravity 1.18.3, native quota tracking is available under the `Antigravity User Settings > Models` page.

## 💡 Inspiration

- This extension was inspired by the [AntigravityQuota](https://github.com/ArataAI/AntigravityQuota) extension, which provides similar functionality.
- Also, inspired by the [progressbar](https://github.com/guibranco/progressbar) idea for creating progress bars in markdown tooltips because VS Code extension API does not support popup menus like the GitHub Copilot one.

---

<p align="center">
  <strong>💖 Support the Development</strong><br><br>
  If you find this extension useful, consider buying me a coffee!<br><br>
  <a href="https://www.paypal.com/donate?hosted_button_id=MZQS5CZ68NGEW">
    <img src="https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif" alt="Donate with PayPal" />
  </a>

---

<p align="center">
  <strong>🙏 Thank you for using AG Usage!</strong>
</p>
