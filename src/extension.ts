/**
 * Vivid VS Code Extension (Minimal)
 *
 * Features:
 * - Auto-download Vivid runtime from GitHub releases
 * - WGSL syntax highlighting (via language contribution)
 *
 * The extension no longer manages the runtime or edits code.
 * Claude Code controls Vivid via the CLI directly.
 */

import * as vscode from 'vscode';
import { RuntimeManager } from './runtimeManager';

let runtimeManager: RuntimeManager;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Vivid');
    runtimeManager = new RuntimeManager(outputChannel);

    // Check vividRoot setting for development builds
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot');
    if (vividRoot) {
        runtimeManager.setVividRoot(vividRoot);
    }

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vivid.checkForUpdates', () => {
            runtimeManager.checkForUpdates();
        }),

        vscode.commands.registerCommand('vivid.reinstallRuntime', () => {
            runtimeManager.installOrUpdate(true);
        }),

        vscode.commands.registerCommand('vivid.downloadRuntime', () => {
            runtimeManager.ensureInstalled();
        }),

        vscode.commands.registerCommand('vivid.showOutput', () => {
            outputChannel.show();
        })
    );

    // Check if runtime is installed, offer to download if not
    if (!runtimeManager.isInstalled()) {
        const checkUpdates = config.get<boolean>('checkUpdatesOnStart', true);
        if (checkUpdates) {
            runtimeManager.ensureInstalled();
        }
    } else {
        // Check for updates on startup
        const checkUpdates = config.get<boolean>('checkUpdatesOnStart', true);
        if (checkUpdates) {
            runtimeManager.checkForUpdates();
        }

        // Show version info
        const version = runtimeManager.getInstalledVersion();
        if (version) {
            outputChannel.appendLine(`Vivid ${version.version} installed`);
        }
    }

    outputChannel.appendLine('Vivid extension activated');
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}
