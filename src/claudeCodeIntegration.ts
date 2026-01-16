/**
 * Claude Code Integration
 *
 * Manages the MCP server configuration in ~/.claude.json so that
 * Claude Code can use Vivid's MCP tools automatically.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

/** Result of checking/updating the Claude Code config */
export interface ConfigResult {
    status: 'ok' | 'created' | 'updated' | 'error';
    message: string;
}

/** Structure of ~/.claude.json */
interface ClaudeConfig {
    mcpServers?: {
        [key: string]: {
            command: string;
            args?: string[];
        };
    };
    [key: string]: unknown; // Preserve other fields
}

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

/** MCP enabled status for a project */
export interface McpEnabledStatus {
    configured: boolean;      // Is vivid MCP configured globally?
    enabled: boolean;         // Is it enabled for this specific project?
    disabledReason?: string;  // Why it's disabled (if applicable)
}

/**
 * Check if Vivid MCP is enabled for a specific project path.
 * This checks both global config and per-project disabled servers.
 */
export async function getMcpEnabledStatus(projectPath: string | undefined): Promise<McpEnabledStatus> {
    try {
        const config = await readClaudeConfig();

        // Check if vivid is configured globally
        if (!config?.mcpServers?.vivid) {
            return {
                configured: false,
                enabled: false,
                disabledReason: 'Vivid MCP not configured in ~/.claude.json'
            };
        }

        // Check if disabled for this specific project
        if (projectPath && config.projects) {
            const projects = config.projects as Record<string, { disabledMcpServers?: string[] }>;

            // Try exact match first, then check parent paths
            for (const [configPath, projectConfig] of Object.entries(projects)) {
                if (projectPath.startsWith(configPath) || configPath.startsWith(projectPath)) {
                    if (projectConfig.disabledMcpServers?.includes('vivid')) {
                        return {
                            configured: true,
                            enabled: false,
                            disabledReason: `Disabled for project: ${configPath}`
                        };
                    }
                }
            }
        }

        return {
            configured: true,
            enabled: true
        };
    } catch (error) {
        return {
            configured: false,
            enabled: false,
            disabledReason: 'Failed to read Claude config'
        };
    }
}

/**
 * Read the Claude Code configuration file
 */
async function readClaudeConfig(): Promise<ClaudeConfig | null> {
    try {
        if (!fs.existsSync(CLAUDE_CONFIG_PATH)) {
            return null;
        }
        const content = fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8');
        return JSON.parse(content) as ClaudeConfig;
    } catch (error) {
        return null;
    }
}

/**
 * Write the Claude Code configuration file
 */
async function writeClaudeConfig(config: ClaudeConfig): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(CLAUDE_CONFIG_PATH, content, 'utf8');
}

/**
 * Validate that the MCP server works by running `vivid mcp --help`
 */
async function validateMcpBinary(vividPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const proc = spawn(vividPath, ['mcp', '--help'], {
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let hasOutput = false;

            proc.stdout.on('data', () => {
                hasOutput = true;
            });

            proc.on('close', (code) => {
                // Accept exit code 0 or any output as success
                resolve(code === 0 || hasOutput);
            });

            proc.on('error', () => {
                resolve(false);
            });

            // Timeout fallback
            setTimeout(() => {
                proc.kill();
                resolve(false);
            }, 5000);
        } catch {
            resolve(false);
        }
    });
}

/**
 * Ensure the Claude Code config has the Vivid MCP server configured correctly.
 * Creates or updates the config as needed.
 */
export async function ensureClaudeCodeConfig(vividPath: string): Promise<ConfigResult> {
    try {
        // First validate the binary works
        const isValid = await validateMcpBinary(vividPath);
        if (!isValid) {
            return {
                status: 'error',
                message: `Vivid binary at ${vividPath} is not responding correctly`
            };
        }

        // Read existing config or create new
        let config = await readClaudeConfig();
        const configExists = config !== null;

        if (!config) {
            config = {};
        }

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Check if vivid entry exists and is correct
        const existingEntry = config.mcpServers.vivid;
        const correctConfig = {
            command: vividPath,
            args: ['mcp']
        };

        if (existingEntry) {
            // Check if path matches
            if (existingEntry.command === vividPath) {
                return { status: 'ok', message: 'Claude Code MCP config is up to date' };
            }

            // Update with new path
            config.mcpServers.vivid = correctConfig;
            await writeClaudeConfig(config);
            return {
                status: 'updated',
                message: `Updated Vivid path from ${existingEntry.command} to ${vividPath}`
            };
        }

        // Add new entry
        config.mcpServers.vivid = correctConfig;
        await writeClaudeConfig(config);

        if (configExists) {
            return { status: 'updated', message: 'Added Vivid MCP server to existing config' };
        } else {
            return { status: 'created', message: 'Created Claude Code config with Vivid MCP server' };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { status: 'error', message: `Failed to configure: ${errorMessage}` };
    }
}

/**
 * Check if Claude Code config exists and has Vivid configured
 */
export async function checkClaudeCodeConfig(vividPath: string): Promise<ConfigResult> {
    try {
        const config = await readClaudeConfig();

        if (!config) {
            return { status: 'error', message: 'Claude Code config (~/.claude.json) does not exist' };
        }

        if (!config.mcpServers?.vivid) {
            return { status: 'error', message: 'Vivid MCP server not configured in Claude Code' };
        }

        const entry = config.mcpServers.vivid;

        // Check if path matches current vivid installation
        if (entry.command !== vividPath) {
            return {
                status: 'error',
                message: `Vivid path mismatch: config has ${entry.command}, expected ${vividPath}`
            };
        }

        // Validate binary works
        const isValid = await validateMcpBinary(vividPath);
        if (!isValid) {
            return { status: 'error', message: 'Vivid MCP server is not responding' };
        }

        return { status: 'ok', message: 'Claude Code MCP config is valid' };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { status: 'error', message: `Config check failed: ${errorMessage}` };
    }
}

/**
 * Show appropriate warning/info messages and handle user actions
 */
export async function handleClaudeCodeSetup(
    vividPath: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const checkResult = await checkClaudeCodeConfig(vividPath);

    if (checkResult.status === 'ok') {
        outputChannel.appendLine('Claude Code MCP: ' + checkResult.message);
        return;
    }

    // Config needs attention - try to fix or warn user
    outputChannel.appendLine('Claude Code MCP: ' + checkResult.message);

    // Check if config file exists at all
    const configExists = fs.existsSync(CLAUDE_CONFIG_PATH);

    if (!configExists) {
        // No config - offer to create
        const selection = await vscode.window.showInformationMessage(
            'Vivid can integrate with Claude Code for AI-assisted development. Configure now?',
            'Configure Now',
            'Learn More',
            'Not Now'
        );

        if (selection === 'Configure Now') {
            await configureAndNotify(vividPath, outputChannel);
        } else if (selection === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/anthropics/claude-code'));
        }
    } else {
        // Config exists but has issues
        const selection = await vscode.window.showWarningMessage(
            `Vivid MCP configuration issue: ${checkResult.message}`,
            'Fix Automatically',
            'Open Config',
            'Dismiss'
        );

        if (selection === 'Fix Automatically') {
            await configureAndNotify(vividPath, outputChannel);
        } else if (selection === 'Open Config') {
            const doc = await vscode.workspace.openTextDocument(CLAUDE_CONFIG_PATH);
            await vscode.window.showTextDocument(doc);
        }
    }
}

/**
 * Configure Claude Code and show result notification
 */
async function configureAndNotify(
    vividPath: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const result = await ensureClaudeCodeConfig(vividPath);

    if (result.status === 'error') {
        vscode.window.showErrorMessage(`Failed to configure Claude Code: ${result.message}`);
        outputChannel.appendLine('Claude Code MCP: ERROR - ' + result.message);
    } else {
        vscode.window.showInformationMessage(
            'Vivid MCP configured for Claude Code. Restart Claude Code to use Vivid tools.'
        );
        outputChannel.appendLine('Claude Code MCP: ' + result.message);
    }
}
