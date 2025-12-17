import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const VIVID_HOOKS_DIR = path.join(os.homedir(), '.vivid', 'hooks');
const HOOK_SCRIPT_PATH = path.join(VIVID_HOOKS_DIR, 'pre-edit.sh');

// The shell script that runs before Claude edits files
const HOOK_SCRIPT = `#!/bin/bash
# Vivid pre-edit hook - prompts user if chain.cpp has unsaved changes
# Read tool input from stdin
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Call VS Code extension's hook server
RESPONSE=$(curl -s -X POST http://127.0.0.1:9877/prepare-for-edit \\
  -H "Content-Type: application/json" \\
  -d "{\\"file_path\\": \\"$FILE_PATH\\"}" 2>/dev/null)

ACTION=$(echo "$RESPONSE" | jq -r '.action // "proceed"')

if [ "$ACTION" = "cancel" ]; then
  echo '{"permissionDecision": "deny", "permissionDecisionReason": "User cancelled edit due to unsaved changes in chain.cpp"}'
else
  echo '{"permissionDecision": "allow"}'
fi
`;

interface ClaudeConfig {
    hooks?: {
        PreToolUse?: Array<{
            matcher: string;
            hooks: Array<{
                type: string;
                command: string;
            }>;
        }>;
    };
    [key: string]: unknown;
}

/**
 * Check if the Vivid hook is already configured in Claude's settings
 */
export function isHookConfigured(): boolean {
    try {
        if (!fs.existsSync(CLAUDE_CONFIG_FILE)) {
            return false;
        }

        const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8');
        const config: ClaudeConfig = JSON.parse(content);

        // Check if our hook is already configured
        const preToolUseHooks = config.hooks?.PreToolUse;
        if (!preToolUseHooks) {
            return false;
        }

        return preToolUseHooks.some(hook =>
            hook.hooks?.some(h => h.command?.includes('vivid') && h.command?.includes('pre-edit'))
        );
    } catch {
        return false;
    }
}

/**
 * Install the hook script to ~/.vivid/hooks/
 */
export function installHookScript(): boolean {
    try {
        // Ensure hooks directory exists
        if (!fs.existsSync(VIVID_HOOKS_DIR)) {
            fs.mkdirSync(VIVID_HOOKS_DIR, { recursive: true });
        }

        // Write the hook script
        fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

        return true;
    } catch (error) {
        console.error('Failed to install hook script:', error);
        return false;
    }
}

/**
 * Configure the hook in Claude's ~/.claude.json
 */
export function configureHook(): boolean {
    try {
        // Read existing config or create new
        let config: ClaudeConfig = {};
        if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
            const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8');
            config = JSON.parse(content);
        }

        // Ensure hooks object exists
        if (!config.hooks) {
            config.hooks = {};
        }
        if (!config.hooks.PreToolUse) {
            config.hooks.PreToolUse = [];
        }

        // Check if our hook is already there
        const existingHookIndex = config.hooks.PreToolUse.findIndex(hook =>
            hook.hooks?.some(h => h.command?.includes('vivid') && h.command?.includes('pre-edit'))
        );

        const vividHook = {
            matcher: 'Edit|Write',
            hooks: [
                {
                    type: 'command',
                    command: HOOK_SCRIPT_PATH
                }
            ]
        };

        if (existingHookIndex >= 0) {
            // Update existing hook
            config.hooks.PreToolUse[existingHookIndex] = vividHook;
        } else {
            // Add new hook
            config.hooks.PreToolUse.push(vividHook);
        }

        // Write config back
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(config, null, 2));

        return true;
    } catch (error) {
        console.error('Failed to configure hook:', error);
        return false;
    }
}

/**
 * Install both the hook script and configure Claude
 * Returns true if successful
 */
export async function installVividHook(): Promise<boolean> {
    const scriptInstalled = installHookScript();
    if (!scriptInstalled) {
        return false;
    }

    const hookConfigured = configureHook();
    return hookConfigured;
}

/**
 * Get the path where the hook script is installed
 */
export function getHookScriptPath(): string {
    return HOOK_SCRIPT_PATH;
}
