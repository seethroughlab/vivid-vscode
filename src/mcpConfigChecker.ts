import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const MCP_SERVER_SCRIPT = path.join(os.homedir(), '.vivid', 'mcp-server.js');

interface ClaudeSettings {
    mcpServers?: {
        [name: string]: {
            command: string;
            args?: string[];
            env?: Record<string, string>;
        };
    };
    [key: string]: unknown;
}

/**
 * Check if Claude Code is configured to use the Vivid MCP server
 */
export function isVividMcpConfigured(): boolean {
    try {
        if (!fs.existsSync(CLAUDE_CONFIG_FILE)) {
            return false;
        }

        const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8');
        const settings: ClaudeSettings = JSON.parse(content);

        // Check if vivid MCP server is configured
        return settings.mcpServers?.vivid !== undefined;
    } catch {
        return false;
    }
}

/**
 * Check if the MCP server script exists
 */
export function mcpServerScriptExists(): boolean {
    return fs.existsSync(MCP_SERVER_SCRIPT);
}

/**
 * Derive docs path from a custom runtime path
 * e.g., /Users/jeff/Developer/vivid/build/bin/vivid -> /Users/jeff/Developer/vivid/docs
 */
function deriveDocsPath(runtimePath: string): string | undefined {
    // Go up from build/bin/vivid to find docs/ directory
    // Typical structure: <repo>/build/bin/vivid
    const repoRoot = path.resolve(path.dirname(runtimePath), '..', '..');
    const docsDir = path.join(repoRoot, 'docs');

    if (fs.existsSync(docsDir)) {
        return docsDir;
    }
    return undefined;
}

/**
 * Configure Claude Code to use the Vivid MCP server
 */
export async function configureVividMcp(): Promise<boolean> {
    try {
        // Read existing config or create new
        let settings: ClaudeSettings = {};
        if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
            const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8');
            settings = JSON.parse(content);
        }

        // Ensure mcpServers object exists
        if (!settings.mcpServers) {
            settings.mcpServers = {};
        }

        // Check if custom runtime path is set
        const config = vscode.workspace.getConfiguration('vivid');
        const runtimePath = config.get<string>('runtimePath');

        // Build MCP server configuration
        const mcpConfig: { command: string; args: string[]; env?: Record<string, string> } = {
            command: 'node',
            args: [MCP_SERVER_SCRIPT]
        };

        // If custom runtime path is set, derive docs path for local dev
        if (runtimePath) {
            const docsPath = deriveDocsPath(runtimePath);
            if (docsPath) {
                mcpConfig.env = {
                    VIVID_DOCS_DIR: docsPath
                };
            }
        }

        // Add vivid MCP server configuration
        settings.mcpServers.vivid = mcpConfig;

        // Write config back
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(settings, null, 2));

        return true;
    } catch (error) {
        console.error('Failed to configure MCP:', error);
        return false;
    }
}

/**
 * Show warning if MCP is not configured and offer to configure it
 */
export async function checkAndPromptMcpConfiguration(outputChannel: vscode.OutputChannel): Promise<void> {
    // Only check if MCP server script exists (i.e., vivid is installed)
    if (!mcpServerScriptExists()) {
        outputChannel.appendLine('Vivid MCP server not found - will be available after runtime installation');
        return;
    }

    if (isVividMcpConfigured()) {
        outputChannel.appendLine('Vivid MCP server is configured for Claude Code');

        // Log which docs path the MCP server will use
        const docsPath = getMcpDocsPath();
        outputChannel.appendLine(`  Docs path: ${docsPath}`);
        return;
    }

    outputChannel.appendLine('Vivid MCP server is NOT configured for Claude Code');

    const action = await vscode.window.showWarningMessage(
        'Vivid MCP server is not configured for Claude Code. Claude won\'t have access to Vivid API documentation when helping with your projects.',
        'Configure Now',
        'Learn More',
        'Ignore'
    );

    if (action === 'Configure Now') {
        const success = await configureVividMcp();
        if (success) {
            vscode.window.showInformationMessage(
                'Vivid MCP server configured. Restart Claude Code for changes to take effect.'
            );
            outputChannel.appendLine('Successfully configured Vivid MCP server for Claude Code');
        } else {
            vscode.window.showErrorMessage(
                'Failed to configure Vivid MCP server. Please configure manually.'
            );
        }
    } else if (action === 'Learn More') {
        vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/seethroughlab/vivid-vscode#mcp-server'
        ));
    }
}

/**
 * Get the path where the MCP server script should be installed
 */
export function getMcpServerScriptPath(): string {
    return MCP_SERVER_SCRIPT;
}

/**
 * Get the docs path that the MCP server will use (from config or default)
 */
export function getMcpDocsPath(): string {
    const defaultDocsPath = path.join(os.homedir(), '.vivid', 'docs');

    try {
        if (!fs.existsSync(CLAUDE_CONFIG_FILE)) {
            return defaultDocsPath;
        }

        const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8');
        const settings: ClaudeSettings = JSON.parse(content);

        // Check if vivid MCP config has a custom docs path
        const vividConfig = settings.mcpServers?.vivid;
        if (vividConfig?.env?.VIVID_DOCS_DIR) {
            return vividConfig.env.VIVID_DOCS_DIR;
        }

        return defaultDocsPath;
    } catch {
        return defaultDocsPath;
    }
}
