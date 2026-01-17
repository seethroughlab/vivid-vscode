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
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { RuntimeManager } from './runtimeManager';
import { OperatorCatalog } from './operatorCatalog';
import { OperatorLibraryPanel } from './operatorLibraryPanel';
import { handleClaudeCodeSetup, ensureClaudeCodeConfig } from './claudeCodeIntegration';
import { StatusBarManager } from './statusBar';
import { DiagnosticsManager } from './diagnostics';
import { CompletionProvider } from './completion';
import { PendingChangesPanel } from './pendingChangesPanel';
import { ChainGraphPanel } from './chainGraphPanel';

/**
 * Find a Vivid project path from context:
 * 1. If a chain.cpp is open, use its directory
 * 2. If workspace has a chain.cpp, use that folder
 * 3. Prompt user to select folder
 */
async function findProjectPath(): Promise<string | undefined> {
    // Check active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const filePath = activeEditor.document.uri.fsPath;
        if (path.basename(filePath) === 'chain.cpp') {
            return path.dirname(filePath);
        }
        // Check if chain.cpp exists in the same directory
        const dir = path.dirname(filePath);
        if (fs.existsSync(path.join(dir, 'chain.cpp'))) {
            return dir;
        }
    }

    // Check workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const chainPath = path.join(folder.uri.fsPath, 'chain.cpp');
            if (fs.existsSync(chainPath)) {
                return folder.uri.fsPath;
            }
        }
    }

    // Prompt user to select
    const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select Vivid Project Folder',
        openLabel: 'Select Project'
    });

    if (folderUri && folderUri.length > 0) {
        const selected = folderUri[0].fsPath;
        if (!fs.existsSync(path.join(selected, 'chain.cpp'))) {
            vscode.window.showWarningMessage('Selected folder does not contain a chain.cpp file');
            return undefined;
        }
        return selected;
    }

    return undefined;
}

/**
 * Convert project name to CamelCase for app name
 */
function toCamelCase(input: string): string {
    return input
        .split(/[-_\s]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

let runtimeManager: RuntimeManager;
let outputChannel: vscode.OutputChannel;
let operatorCatalog: OperatorCatalog;
let operatorLibraryPanel: OperatorLibraryPanel;
let statusBarManager: StatusBarManager;
let diagnosticsManager: DiagnosticsManager;
let pendingChangesPanel: PendingChangesPanel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Vivid');
    outputChannel.appendLine('[Vivid] Extension activating...');

    try {
    runtimeManager = new RuntimeManager(outputChannel);
    outputChannel.appendLine('[Vivid] RuntimeManager created');

    // Check vividRoot setting
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot', '~/.vivid');
    runtimeManager.setInstallDir(vividRoot);

    // Set up operator catalog and library panel
    operatorCatalog = new OperatorCatalog();
    operatorCatalog.setOutputChannel(outputChannel);

    operatorLibraryPanel = new OperatorLibraryPanel(context.extensionUri);
    operatorLibraryPanel.setVividRoot(runtimeManager.getInstallDir());

    // Register the webview view provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OperatorLibraryPanel.viewType,
            operatorLibraryPanel
        )
    );

    // Initialize status bar and diagnostics
    outputChannel.appendLine('[Vivid] Creating StatusBarManager...');
    statusBarManager = new StatusBarManager(outputChannel);
    outputChannel.appendLine('[Vivid] StatusBarManager created');
    diagnosticsManager = new DiagnosticsManager(statusBarManager);
    outputChannel.appendLine('[Vivid] DiagnosticsManager created');
    context.subscriptions.push(statusBarManager);
    context.subscriptions.push(diagnosticsManager);

    // Initialize pending changes panel
    pendingChangesPanel = new PendingChangesPanel(
        context.extensionUri,
        context.extensionPath,
        statusBarManager,
        outputChannel
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PendingChangesPanel.viewType,
            pendingChangesPanel
        )
    );
    context.subscriptions.push(pendingChangesPanel);

    // Register completion provider for C++ files
    const completionProvider = new CompletionProvider(operatorCatalog);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'cpp', pattern: '**/chain.cpp' },
            completionProvider,
            '<', '.', '"'  // Trigger characters
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vivid.checkForUpdates', () => {
            runtimeManager.checkForUpdates();
        }),

        vscode.commands.registerCommand('vivid.statusBarClick', () => {
            statusBarManager.handleStatusBarClick();
        }),

        vscode.commands.registerCommand('vivid.mcpStatusBarClick', () => {
            statusBarManager.handleMcpStatusBarClick();
        }),

        vscode.commands.registerCommand('vivid.reinstallRuntime', async () => {
            const success = await runtimeManager.installOrUpdate(true);
            if (success) {
                // After reinstall, ensure MCP config is correct
                handleClaudeCodeSetup(runtimeManager.executablePath, outputChannel);
                refreshOperatorCatalog();
            }
        }),

        vscode.commands.registerCommand('vivid.downloadRuntime', async () => {
            const success = await runtimeManager.ensureInstalled();
            if (success) {
                // After install, ensure MCP config is correct
                handleClaudeCodeSetup(runtimeManager.executablePath, outputChannel);
                refreshOperatorCatalog();
            }
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
        }),

        vscode.commands.registerCommand('vivid.createProject', async () => {
            if (!runtimeManager.isInstalled()) {
                vscode.window.showWarningMessage('Vivid runtime not installed. Install it first.');
                return;
            }

            // Prompt for project name
            const projectName = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'my-vivid-project',
                validateInput: (value) => {
                    if (!value) {
                        return 'Project name is required';
                    }
                    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                        return 'Project name can only contain letters, numbers, hyphens, and underscores';
                    }
                    return null;
                }
            });

            if (!projectName) {
                return;
            }

            // Prompt for template
            const templates = [
                { label: 'blank', description: 'Empty project with basic noise effect' },
                { label: 'noise-demo', description: 'Animated noise patterns' },
                { label: 'feedback', description: 'Visual feedback loop effect' },
                { label: 'audio-visualizer', description: 'Audio-reactive visuals (requires vivid-audio)' },
                { label: '3d-orbit', description: '3D scene with orbiting camera (requires vivid-render3d)' }
            ];

            const selectedTemplate = await vscode.window.showQuickPick(templates, {
                placeHolder: 'Select a template',
                title: 'Project Template'
            });

            if (!selectedTemplate) {
                return;
            }

            // Prompt for addons (multi-select)
            const addonOptions = [
                { label: 'vivid-audio', description: 'Audio input, FFT analysis, beat detection', picked: selectedTemplate.label === 'audio-visualizer' },
                { label: 'vivid-video', description: 'Video playback (HAP codec, platform decoders)' },
                { label: 'vivid-render3d', description: '3D rendering with PBR materials, GLTF loading', picked: selectedTemplate.label === '3d-orbit' }
            ];

            const selectedAddons = await vscode.window.showQuickPick(addonOptions, {
                placeHolder: 'Select addons (optional)',
                title: 'Addons',
                canPickMany: true
            });

            // Prompt for location
            const workspaceFolders = vscode.workspace.workspaceFolders;
            let targetDir: string | undefined;

            if (workspaceFolders && workspaceFolders.length > 0) {
                const locationOptions = [
                    { label: '$(folder) Current Workspace', description: workspaceFolders[0].uri.fsPath, uri: workspaceFolders[0].uri },
                    { label: '$(folder-opened) Choose Folder...', description: 'Select a different location', uri: undefined }
                ];

                const selectedLocation = await vscode.window.showQuickPick(locationOptions, {
                    placeHolder: 'Where to create the project?',
                    title: 'Project Location'
                });

                if (!selectedLocation) {
                    return;
                }

                if (selectedLocation.uri) {
                    targetDir = selectedLocation.uri.fsPath;
                }
            }

            if (!targetDir) {
                const folderUri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Select Parent Folder for Project',
                    openLabel: 'Select Folder'
                });

                if (!folderUri || folderUri.length === 0) {
                    return;
                }

                targetDir = folderUri[0].fsPath;
            }

            // Build command arguments
            const args = ['new', projectName, '-t', selectedTemplate.label, '-y'];

            if (selectedAddons && selectedAddons.length > 0) {
                args.push('-a', selectedAddons.map(a => a.label).join(','));
            }

            // Run vivid new command
            outputChannel.appendLine(`Creating project: ${runtimeManager.executablePath} ${args.join(' ')}`);
            outputChannel.appendLine(`In directory: ${targetDir}`);

            const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
                const proc = spawn(runtimeManager.executablePath, args, {
                    cwd: targetDir,
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                    outputChannel.append(data.toString());
                });

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                    outputChannel.append(data.toString());
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: stderr || stdout || `Exit code ${code}` });
                    }
                });

                proc.on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
            });

            if (!result.success) {
                vscode.window.showErrorMessage(`Failed to create project: ${result.error}`);
                return;
            }

            const projectPath = path.join(targetDir, projectName);

            // Ask user what to do next
            const action = await vscode.window.showInformationMessage(
                `Project "${projectName}" created successfully!`,
                'Open in New Window',
                'Add to Workspace',
                'Open Folder'
            );

            if (action === 'Open in New Window') {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), true);
            } else if (action === 'Add to Workspace') {
                vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders?.length || 0,
                    0,
                    { uri: vscode.Uri.file(projectPath) }
                );
            } else if (action === 'Open Folder') {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), false);
            }
        }),

        vscode.commands.registerCommand('vivid.runProject', async (options?: { quick?: boolean }) => {
            if (!runtimeManager.isInstalled()) {
                vscode.window.showWarningMessage('Vivid runtime not installed. Install it first.');
                return;
            }

            const projectPath = await findProjectPath();
            if (!projectPath) {
                return;
            }

            let args: string[] = [projectPath];

            // Quick mode: skip menu, run with --show-ui
            if (options?.quick) {
                args.push('--show-ui');
            } else {
                // Show run options
                const runOptions = [
                    { label: '$(play) Run', description: 'Run with default settings', args: [] as string[] },
                    { label: '$(screen-full) Fullscreen', description: 'Run in fullscreen mode', args: ['--fullscreen'] },
                    { label: '$(symbol-structure) Show UI', description: 'Run with chain visualizer', args: ['--show-ui'] },
                    { label: '$(window) Custom Size...', description: 'Specify window size', args: ['custom'] }
                ];

                const selected = await vscode.window.showQuickPick(runOptions, {
                    placeHolder: 'How to run the project?',
                    title: 'Run Vivid Project'
                });

                if (!selected) {
                    return;
                }

                if (selected.args[0] === 'custom') {
                    const sizeInput = await vscode.window.showInputBox({
                        prompt: 'Enter window size (e.g., 1920x1080)',
                        placeHolder: '1280x720',
                        validateInput: (value) => {
                            if (!value) {
                                return null; // Allow empty for default
                            }
                            if (!/^\d+x\d+$/i.test(value)) {
                                return 'Format: WIDTHxHEIGHT (e.g., 1920x1080)';
                            }
                            return null;
                        }
                    });

                    if (sizeInput) {
                        args.push('--window', sizeInput);
                    }
                } else {
                    args = args.concat(selected.args);
                }
            }

            // Create terminal and run
            const terminal = vscode.window.createTerminal({
                name: `Vivid: ${path.basename(projectPath)}`,
                cwd: projectPath
            });

            const command = `"${runtimeManager.executablePath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
            terminal.sendText(command);
            terminal.show();

            outputChannel.appendLine(`Running: ${command}`);
        }),

        vscode.commands.registerCommand('vivid.bundleProject', async () => {
            if (!runtimeManager.isInstalled()) {
                vscode.window.showWarningMessage('Vivid runtime not installed. Install it first.');
                return;
            }

            const projectPath = await findProjectPath();
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const defaultAppName = toCamelCase(projectName);

            // Prompt for app name
            const appName = await vscode.window.showInputBox({
                prompt: 'Enter application name',
                value: defaultAppName,
                placeHolder: defaultAppName
            });

            if (!appName) {
                return;
            }

            // Prompt for output directory
            const defaultOutput = path.dirname(projectPath);
            const outputOptions = [
                { label: '$(folder) Parent Folder', description: defaultOutput, path: defaultOutput },
                { label: '$(folder-opened) Choose Folder...', description: 'Select a different location', path: undefined }
            ];

            const selectedOutput = await vscode.window.showQuickPick(outputOptions, {
                placeHolder: 'Where to save the bundle?',
                title: 'Output Location'
            });

            if (!selectedOutput) {
                return;
            }

            let outputDir = selectedOutput.path;
            if (!outputDir) {
                const folderUri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Select Output Folder',
                    openLabel: 'Select'
                });

                if (!folderUri || folderUri.length === 0) {
                    return;
                }
                outputDir = folderUri[0].fsPath;
            }

            // Platform selection
            const currentPlatform = process.platform === 'darwin' ? 'mac' :
                                   process.platform === 'win32' ? 'windows' : 'linux';

            const platformOptions = [
                { label: `$(device-desktop) ${currentPlatform}`, description: 'Current platform (Recommended)', platform: currentPlatform }
            ];

            // Add other platforms (cross-compilation support varies)
            if (currentPlatform === 'mac') {
                // macOS can only build for mac currently
            } else if (currentPlatform === 'windows') {
                // Windows can only build for windows currently
            } else {
                // Linux can only build for linux currently
            }

            const selectedPlatform = await vscode.window.showQuickPick(platformOptions, {
                placeHolder: 'Select target platform',
                title: 'Target Platform'
            });

            if (!selectedPlatform) {
                return;
            }

            // Build command
            const args = ['bundle', projectPath, '-n', appName, '-o', outputDir, '-p', selectedPlatform.platform];

            outputChannel.appendLine(`Bundling: ${runtimeManager.executablePath} ${args.join(' ')}`);
            outputChannel.show();

            // Run with progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Bundling ${appName}...`,
                cancellable: false
            }, async () => {
                return new Promise<void>((resolve) => {
                    const proc = spawn(runtimeManager.executablePath, args, {
                        cwd: projectPath,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });

                    proc.stdout.on('data', (data) => {
                        outputChannel.append(data.toString());
                    });

                    proc.stderr.on('data', (data) => {
                        outputChannel.append(data.toString());
                    });

                    proc.on('close', async (code) => {
                        if (code === 0) {
                            const bundlePath = selectedPlatform.platform === 'mac'
                                ? path.join(outputDir!, `${appName}.app`)
                                : path.join(outputDir!, appName);

                            const action = await vscode.window.showInformationMessage(
                                `Bundle created: ${appName}`,
                                'Reveal in Finder'
                            );

                            if (action === 'Reveal in Finder') {
                                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(bundlePath));
                            }
                        } else {
                            vscode.window.showErrorMessage(`Bundling failed. Check Output for details.`);
                        }
                        resolve();
                    });

                    proc.on('error', (err) => {
                        outputChannel.appendLine(`Error: ${err.message}`);
                        vscode.window.showErrorMessage(`Bundling failed: ${err.message}`);
                        resolve();
                    });
                });
            });
        }),

        vscode.commands.registerCommand('vivid.showChainGraph', () => {
            ChainGraphPanel.createOrShow(context.extensionUri, statusBarManager);
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

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('vivid.vividRoot')) {
                const newConfig = vscode.workspace.getConfiguration('vivid');
                const newVividPath = newConfig.get<string>('vividRoot', '~/.vivid');

                runtimeManager.setInstallDir(newVividPath);
                operatorLibraryPanel.setVividRoot(runtimeManager.getInstallDir());
                outputChannel.appendLine(`Vivid path changed to: ${newVividPath}`);

                // Refresh operator catalog with new path
                await refreshOperatorCatalog();

                // Check if MCP config needs updating
                if (runtimeManager.isInstalled()) {
                    handleClaudeCodeSetup(runtimeManager.executablePath, outputChannel);
                }
            }
        })
    );

    // Check if runtime is installed, offer to download if not
    if (!runtimeManager.isInstalled()) {
        const checkUpdates = config.get<boolean>('checkUpdatesOnStart', true);
        if (checkUpdates) {
            runtimeManager.ensureInstalled().then((success) => {
                if (success) {
                    // After install, ensure MCP config is correct
                    handleClaudeCodeSetup(runtimeManager.executablePath, outputChannel);
                    refreshOperatorCatalog();
                }
            });
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

    outputChannel.appendLine('[Vivid] Extension activated successfully');
    } catch (e) {
        outputChannel.appendLine(`[Vivid] ERROR during activation: ${e}`);
        console.error('[Vivid] Activation error:', e);
    }
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}
