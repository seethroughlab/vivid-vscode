/**
 * Vivid VS Code Extension
 *
 * Features:
 * - Auto-download Vivid runtime from GitHub releases
 * - WGSL syntax highlighting (via language contribution)
 * - Operator library browser sidebar
 *
 * The extension no longer manages the runtime or edits code.
 * Claude Code controls Vivid via the CLI directly.
 */

import * as vscode from 'vscode';
import { RuntimeManager } from './runtimeManager';
import { OperatorCatalog } from './operatorCatalog';
import { OperatorLibraryPanel } from './operatorLibraryPanel';
import { handleClaudeCodeSetup, ensureClaudeCodeConfig } from './claudeCodeIntegration';

let runtimeManager: RuntimeManager;
let outputChannel: vscode.OutputChannel;
let operatorCatalog: OperatorCatalog;
let operatorLibraryPanel: OperatorLibraryPanel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Vivid');
    runtimeManager = new RuntimeManager(outputChannel);

    // Check vividRoot setting for development builds
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot');
    if (vividRoot) {
        runtimeManager.setVividRoot(vividRoot);
    }

    // Set up operator catalog and library panel
    operatorCatalog = new OperatorCatalog();
    operatorCatalog.setOutputChannel(outputChannel);

    operatorLibraryPanel = new OperatorLibraryPanel(context.extensionUri);

    // Register the webview view provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OperatorLibraryPanel.viewType,
            operatorLibraryPanel
        )
    );

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
        }),

        vscode.commands.registerCommand('vivid.refreshOperatorLibrary', async () => {
            await refreshOperatorCatalog();
        }),

        vscode.commands.registerCommand('vivid.configureClaudeCode', async () => {
            if (!runtimeManager.isInstalled()) {
                vscode.window.showWarningMessage('Vivid runtime not installed. Install it first.');
                return;
            }
            const result = await ensureClaudeCodeConfig(runtimeManager.executablePath);
            if (result.status === 'error') {
                vscode.window.showErrorMessage(`Failed: ${result.message}`);
            } else {
                vscode.window.showInformationMessage(
                    'Vivid MCP configured for Claude Code. Restart Claude Code to use Vivid tools.'
                );
            }
        })
    );

    // Function to refresh the operator catalog
    async function refreshOperatorCatalog() {
        if (!runtimeManager.isInstalled()) {
            operatorLibraryPanel.setLoadError('Vivid runtime not installed');
            return;
        }

        operatorLibraryPanel.setLoading(true);

        const success = await operatorCatalog.loadFromRuntime(runtimeManager.executablePath);

        if (success) {
            operatorLibraryPanel.setCatalog(operatorCatalog);
        } else {
            operatorLibraryPanel.setLoadError('Failed to load operators from runtime');
        }
    }

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

        // Load operator catalog on startup
        refreshOperatorCatalog();

        // Check Claude Code MCP configuration
        handleClaudeCodeSetup(runtimeManager.executablePath, outputChannel);
    }

    outputChannel.appendLine('Vivid extension activated');
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}
