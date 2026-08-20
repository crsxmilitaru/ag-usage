import * as vscode from 'vscode';

export function isAntigravityIde(): boolean {
	return vscode.env.appName.toLowerCase().includes('antigravity');
}
