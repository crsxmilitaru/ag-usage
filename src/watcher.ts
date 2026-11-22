import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CONVERSATION_WATCH_DEBOUNCE_MS,
	CONVERSATION_WATCH_MAX_WAIT_MS,
	MODEL_USAGE_CONVERSATION_DIRS
} from './constants';
import { getGeminiDir, isMissingPathError } from './utils';

type WatcherLogger = (message: string, error?: unknown) => void;

const CONVERSATION_FILE_PATTERN = /\.(?:db(?:-wal|-journal)?|pb)$/i;

interface FileStamp {
	mtimeMs: number;
	size: number;
}

export class ConversationWatcher implements vscode.Disposable {
	private readonly watchers = new Map<string, fs.FSWatcher>();
	private readonly fileStamps = new Map<string, FileStamp>();
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private maxWaitTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(
		private readonly onActivity: () => void,
		private readonly log: WatcherLogger
	) {
		this.ensureWatchers();
	}

	public ensureWatchers(): void {
		if (this.disposed) {
			return;
		}
		const geminiRoot = getGeminiDir();
		this.watchDirectory(geminiRoot, (_eventType, filename) => {
			if (filename === null || (MODEL_USAGE_CONVERSATION_DIRS as readonly string[]).includes(filename)) {
				this.ensureWatchers();
			}
		});

		for (const dirName of MODEL_USAGE_CONVERSATION_DIRS) {
			const appDir = path.join(geminiRoot, dirName);
			const conversationsDir = path.join(appDir, 'conversations');
			if (this.watchDirectory(conversationsDir, (_eventType, filename) => {
				void this.handleConversationChange(conversationsDir, filename);
			})) {
				this.closeWatcher(appDir);
			} else {
				this.watchDirectory(appDir, (_eventType, filename) => {
					if (filename === null || filename === 'conversations') {
						this.ensureWatchers();
					}
				});
			}
		}
	}

	private watchDirectory(
		dirPath: string,
		listener: (eventType: string, filename: string | null) => void
	): boolean {
		if (this.watchers.has(dirPath)) {
			return true;
		}
		try {
			if (!fs.statSync(dirPath).isDirectory()) {
				return false;
			}
			const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
				if (this.disposed) {
					return;
				}
				const name = typeof filename === 'string' ? filename : filename ? String(filename) : null;
				listener(eventType, name);
			});
			watcher.on('error', (error) => {
				this.log(`Conversation watcher error on ${dirPath}`, error);
				this.closeWatcher(dirPath);
			});
			this.watchers.set(dirPath, watcher);
			return true;
		} catch (error) {
			if (!isMissingPathError(error)) {
				this.log(`Failed to watch ${dirPath}`, error);
			}
			return false;
		}
	}

	private closeWatcher(dirPath: string): void {
		const watcher = this.watchers.get(dirPath);
		if (!watcher) {
			return;
		}
		this.watchers.delete(dirPath);
		try {
			watcher.close();
		} catch (error) {
			this.log(`Failed to close watcher for ${dirPath}`, error);
		}
	}

	private async handleConversationChange(dirPath: string, filename: string | null): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (filename === null) {
			this.scheduleActivity();
			return;
		}
		if (!CONVERSATION_FILE_PATTERN.test(filename)) {
			return;
		}

		const fullPath = path.join(dirPath, filename);
		try {
			const stats = await fs.promises.stat(fullPath);
			if (this.disposed || !stats.isFile()) {
				return;
			}
			const previous = this.fileStamps.get(fullPath);
			if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
				return;
			}
			this.fileStamps.set(fullPath, { mtimeMs: stats.mtimeMs, size: stats.size });
			this.scheduleActivity();
		} catch (error) {
			if (isMissingPathError(error)) {
				if (this.fileStamps.delete(fullPath)) {
					this.scheduleActivity();
				}
				return;
			}
			this.log(`Failed to inspect conversation file ${filename}`, error);
		}
	}

	private scheduleActivity(): void {
		if (this.disposed) {
			return;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => this.flushActivity(), CONVERSATION_WATCH_DEBOUNCE_MS);

		if (!this.maxWaitTimer) {
			this.maxWaitTimer = setTimeout(() => this.flushActivity(), CONVERSATION_WATCH_MAX_WAIT_MS);
		}
	}

	private flushActivity(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		if (this.maxWaitTimer) {
			clearTimeout(this.maxWaitTimer);
			this.maxWaitTimer = undefined;
		}
		if (this.disposed) {
			return;
		}
		this.onActivity();
	}

	public dispose(): void {
		this.disposed = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		if (this.maxWaitTimer) {
			clearTimeout(this.maxWaitTimer);
			this.maxWaitTimer = undefined;
		}
		for (const dirPath of [...this.watchers.keys()]) {
			this.closeWatcher(dirPath);
		}
		this.fileStamps.clear();
	}
}
