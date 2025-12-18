/**
 * Addon Manager for Vivid VS Code Extension
 *
 * Wraps the `vivid addons` CLI commands for use in VS Code.
 * Handles install, remove, update, and list operations.
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface InstalledAddon {
    name: string;
    version: string;
    gitUrl: string;
    gitRef: string;
    installedAt: string;
    builtFrom: string;
}

export class AddonManager {
    private outputChannel: vscode.OutputChannel;
    private runtimePath: string | undefined;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    setRuntimePath(path: string) {
        this.runtimePath = path;
    }

    /**
     * List installed addons
     */
    async listInstalled(): Promise<InstalledAddon[]> {
        if (!this.runtimePath) {
            return [];
        }

        return new Promise((resolve) => {
            const proc = spawn(this.runtimePath!, ['addons', 'list', '--json']);
            let stdout = '';

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    try {
                        const result = JSON.parse(stdout);
                        resolve(result.addons || []);
                    } catch {
                        resolve([]);
                    }
                } else {
                    resolve([]);
                }
            });

            proc.on('error', () => {
                resolve([]);
            });
        });
    }

    /**
     * Install an addon from a git URL
     */
    async install(gitUrl: string, gitRef?: string): Promise<boolean> {
        if (!this.runtimePath) {
            vscode.window.showErrorMessage('Vivid runtime not found');
            return false;
        }

        const args = ['addons', 'install', gitUrl];
        if (gitRef) {
            args.push('--ref', gitRef);
        }

        return this.runCommand(args, `Installing addon from ${gitUrl}...`);
    }

    /**
     * Remove an installed addon
     */
    async remove(name: string): Promise<boolean> {
        if (!this.runtimePath) {
            vscode.window.showErrorMessage('Vivid runtime not found');
            return false;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Remove addon "${name}"?`,
            { modal: true },
            'Remove'
        );

        if (confirm !== 'Remove') {
            return false;
        }

        return this.runCommand(['addons', 'remove', name], `Removing ${name}...`);
    }

    /**
     * Update an addon (or all addons if name is empty)
     */
    async update(name?: string): Promise<boolean> {
        if (!this.runtimePath) {
            vscode.window.showErrorMessage('Vivid runtime not found');
            return false;
        }

        const args = ['addons', 'update'];
        if (name) {
            args.push(name);
        }

        const title = name ? `Updating ${name}...` : 'Updating all addons...';
        return this.runCommand(args, title);
    }

    /**
     * Run a vivid command with progress indicator
     */
    private async runCommand(args: string[], title: string): Promise<boolean> {
        this.outputChannel.appendLine(`Running: vivid ${args.join(' ')}`);
        this.outputChannel.show();

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false
        }, async () => {
            return new Promise<boolean>((resolve) => {
                const proc = spawn(this.runtimePath!, args);

                proc.stdout?.on('data', (data) => {
                    this.outputChannel.append(data.toString());
                });

                proc.stderr?.on('data', (data) => {
                    this.outputChannel.append(data.toString());
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        this.outputChannel.appendLine('Command completed successfully');
                        resolve(true);
                    } else {
                        this.outputChannel.appendLine(`Command failed with code ${code}`);
                        resolve(false);
                    }
                });

                proc.on('error', (err) => {
                    this.outputChannel.appendLine(`Error: ${err.message}`);
                    vscode.window.showErrorMessage(`Failed to run vivid: ${err.message}`);
                    resolve(false);
                });
            });
        });
    }
}

/**
 * Show Quick Pick for addon management
 */
export async function showAddonManager(addonManager: AddonManager): Promise<void> {
    const actions = [
        { label: '$(add) Install Addon', description: 'Install from GitHub URL', action: 'install' },
        { label: '$(refresh) Update Addons', description: 'Update installed addons', action: 'update' },
        { label: '$(list-unordered) List Installed', description: 'View installed addons', action: 'list' },
        { label: '$(trash) Remove Addon', description: 'Uninstall an addon', action: 'remove' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: 'Select addon action',
        title: 'Vivid Addon Manager'
    });

    if (!selected) {
        return;
    }

    switch (selected.action) {
        case 'install':
            await installAddonDialog(addonManager);
            break;
        case 'update':
            await updateAddonsDialog(addonManager);
            break;
        case 'list':
            await listAddonsDialog(addonManager);
            break;
        case 'remove':
            await removeAddonDialog(addonManager);
            break;
    }
}

async function installAddonDialog(addonManager: AddonManager): Promise<void> {
    // Show some suggested addons
    const suggestions = [
        {
            label: 'vivid-ml',
            description: 'Machine learning inference via ONNX Runtime',
            url: 'https://github.com/seethroughlab/vivid-ml'
        },
        { label: '$(link) Enter URL...', description: 'Install from custom GitHub URL', url: '' }
    ];

    const selected = await vscode.window.showQuickPick(suggestions, {
        placeHolder: 'Select addon to install',
        title: 'Install Vivid Addon'
    });

    if (!selected) {
        return;
    }

    let gitUrl = selected.url;

    if (!gitUrl) {
        // Ask for URL
        gitUrl = await vscode.window.showInputBox({
            prompt: 'Enter Git repository URL',
            placeHolder: 'https://github.com/username/vivid-addon',
            validateInput: (value) => {
                if (!value || !value.includes('github.com')) {
                    return 'Please enter a valid GitHub URL';
                }
                return undefined;
            }
        }) || '';
    }

    if (!gitUrl) {
        return;
    }

    // Ask for optional ref (tag/branch)
    const gitRef = await vscode.window.showInputBox({
        prompt: 'Git ref (optional)',
        placeHolder: 'v1.0.0 or main (leave empty for latest)',
    });

    const success = await addonManager.install(gitUrl, gitRef || undefined);

    if (success) {
        const restart = await vscode.window.showInformationMessage(
            'Addon installed successfully! Restart the Vivid runtime to load new operators.',
            'Restart Runtime'
        );

        if (restart === 'Restart Runtime') {
            vscode.commands.executeCommand('vivid.stopRuntime');
            setTimeout(() => {
                vscode.commands.executeCommand('vivid.startRuntime');
            }, 1000);
        }
    } else {
        vscode.window.showErrorMessage('Failed to install addon. Check Output panel for details.');
    }
}

async function updateAddonsDialog(addonManager: AddonManager): Promise<void> {
    const addons = await addonManager.listInstalled();

    if (addons.length === 0) {
        vscode.window.showInformationMessage('No addons installed.');
        return;
    }

    const items = [
        { label: '$(sync) Update All', description: 'Update all installed addons', name: '' },
        ...addons.map(a => ({
            label: a.name,
            description: `v${a.version} - ${a.builtFrom}`,
            name: a.name
        }))
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select addon to update',
        title: 'Update Vivid Addons'
    });

    if (!selected) {
        return;
    }

    const success = await addonManager.update(selected.name || undefined);

    if (success) {
        const restart = await vscode.window.showInformationMessage(
            'Addon(s) updated! Restart the Vivid runtime to load changes.',
            'Restart Runtime'
        );

        if (restart === 'Restart Runtime') {
            vscode.commands.executeCommand('vivid.stopRuntime');
            setTimeout(() => {
                vscode.commands.executeCommand('vivid.startRuntime');
            }, 1000);
        }
    }
}

async function listAddonsDialog(addonManager: AddonManager): Promise<void> {
    const addons = await addonManager.listInstalled();

    if (addons.length === 0) {
        vscode.window.showInformationMessage('No addons installed. Use "Vivid: Manage Addons" to install one.');
        return;
    }

    const items = addons.map(a => ({
        label: `$(package) ${a.name}`,
        description: `v${a.version}`,
        detail: `Source: ${a.builtFrom} | Installed: ${new Date(a.installedAt).toLocaleDateString()}`
    }));

    await vscode.window.showQuickPick(items, {
        placeHolder: `${addons.length} addon(s) installed`,
        title: 'Installed Vivid Addons'
    });
}

async function removeAddonDialog(addonManager: AddonManager): Promise<void> {
    const addons = await addonManager.listInstalled();

    if (addons.length === 0) {
        vscode.window.showInformationMessage('No addons installed.');
        return;
    }

    const items = addons.map(a => ({
        label: a.name,
        description: `v${a.version}`,
        name: a.name
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select addon to remove',
        title: 'Remove Vivid Addon'
    });

    if (!selected) {
        return;
    }

    const success = await addonManager.remove(selected.name);

    if (success) {
        vscode.window.showInformationMessage(`Addon "${selected.name}" removed.`);
    }
}
