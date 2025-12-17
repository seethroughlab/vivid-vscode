import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { execSync, spawn } from 'child_process';

// GitHub repository info for vivid runtime
const GITHUB_OWNER = 'seethroughlab';
const GITHUB_REPO = 'vivid';

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GitHubRelease {
    tag_name: string;
    name: string;
    assets: ReleaseAsset[];
}

interface VersionInfo {
    version: string;
    installedAt: string;
    platform: string;
    arch: string;
}

export class RuntimeManager {
    private installDir: string;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.installDir = path.join(os.homedir(), '.vivid');
    }

    /**
     * Get the platform target string (matches release artifact names)
     */
    private get platformTarget(): string {
        const platform = process.platform === 'darwin' ? 'darwin' :
                        process.platform === 'win32' ? 'win32' : 'linux';
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        return `${platform}-${arch}`;
    }

    /**
     * Get the path to the vivid executable
     */
    get executablePath(): string {
        const ext = process.platform === 'win32' ? '.exe' : '';
        return path.join(this.installDir, 'bin', `vivid${ext}`);
    }

    /**
     * Get the lib directory path
     */
    get libPath(): string {
        return path.join(this.installDir, 'lib');
    }

    /**
     * Check if vivid is installed
     */
    isInstalled(): boolean {
        return fs.existsSync(this.executablePath);
    }

    /**
     * Get installed version info
     */
    getInstalledVersion(): VersionInfo | null {
        const versionFile = path.join(this.installDir, 'version.json');
        if (!fs.existsSync(versionFile)) {
            return null;
        }
        try {
            const content = fs.readFileSync(versionFile, 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    /**
     * Save version info after installation
     */
    private saveVersionInfo(version: string): void {
        const info: VersionInfo = {
            version,
            installedAt: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch
        };
        const versionFile = path.join(this.installDir, 'version.json');
        fs.writeFileSync(versionFile, JSON.stringify(info, null, 2));
    }

    /**
     * Get the platform-specific asset name
     */
    private getAssetName(): string {
        const platform = process.platform;
        const arch = process.arch;

        let platformStr: string;
        let archStr: string;

        switch (platform) {
            case 'darwin':
                platformStr = 'darwin';
                break;
            case 'win32':
                platformStr = 'win32';
                break;
            case 'linux':
                platformStr = 'linux';
                break;
            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }

        switch (arch) {
            case 'arm64':
                archStr = 'arm64';
                break;
            case 'x64':
                archStr = 'x64';
                break;
            default:
                throw new Error(`Unsupported architecture: ${arch}`);
        }

        const ext = platform === 'win32' ? 'zip' : 'tar.gz';
        return `vivid-${platformStr}-${archStr}.${ext}`;
    }

    /**
     * Fetch latest release info from GitHub
     */
    async getLatestRelease(): Promise<GitHubRelease> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
                headers: {
                    'User-Agent': 'vivid-vscode-extension',
                    'Accept': 'application/vnd.github.v3+json'
                }
            };

            https.get(options, (res) => {
                if (res.statusCode === 404) {
                    reject(new Error('No releases found. Please build vivid manually.'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`GitHub API error: ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse GitHub response'));
                    }
                });
            }).on('error', reject);
        });
    }

    /**
     * Download a file with progress reporting
     */
    private async downloadFile(
        url: string,
        destPath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        totalSize: number
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            let downloadedSize = 0;
            let lastPercent = 0;

            const request = (downloadUrl: string) => {
                https.get(downloadUrl, {
                    headers: { 'User-Agent': 'vivid-vscode-extension' }
                }, (res) => {
                    // Handle redirects
                    if (res.statusCode === 302 || res.statusCode === 301) {
                        const redirectUrl = res.headers.location;
                        if (redirectUrl) {
                            request(redirectUrl);
                            return;
                        }
                    }

                    if (res.statusCode !== 200) {
                        reject(new Error(`Download failed: ${res.statusCode}`));
                        return;
                    }

                    res.on('data', (chunk) => {
                        downloadedSize += chunk.length;
                        const percent = Math.round((downloadedSize / totalSize) * 100);
                        if (percent > lastPercent) {
                            progress.report({
                                message: `Downloading... ${percent}%`,
                                increment: percent - lastPercent
                            });
                            lastPercent = percent;
                        }
                    });

                    res.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                }).on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            };

            request(url);
        });
    }

    /**
     * Extract archive to install directory
     */
    private async extractArchive(archivePath: string): Promise<void> {
        const isZip = archivePath.endsWith('.zip');
        const tempExtractDir = path.join(os.tmpdir(), 'vivid-extract');

        // Clean up any previous extraction
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true });
        }
        fs.mkdirSync(tempExtractDir, { recursive: true });

        // Ensure install directory exists
        if (!fs.existsSync(this.installDir)) {
            fs.mkdirSync(this.installDir, { recursive: true });
        }

        // Extract to temp directory first
        if (isZip) {
            if (process.platform === 'win32') {
                execSync(
                    `powershell -command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${tempExtractDir}'"`,
                    { stdio: 'pipe' }
                );
            } else {
                execSync(`unzip -o "${archivePath}" -d "${tempExtractDir}"`, { stdio: 'pipe' });
            }
        } else {
            execSync(`tar -xzf "${archivePath}" -C "${tempExtractDir}"`, { stdio: 'pipe' });
        }

        // Find the extracted folder (should be vivid-{platform}-{arch})
        const extractedItems = fs.readdirSync(tempExtractDir);
        const vividFolder = extractedItems.find(item =>
            item.startsWith('vivid-') && fs.statSync(path.join(tempExtractDir, item)).isDirectory()
        );

        if (!vividFolder) {
            throw new Error('Invalid archive structure: expected vivid-{platform}-{arch} folder');
        }

        const sourceDir = path.join(tempExtractDir, vividFolder);

        // Copy contents to install directory
        const copyRecursive = (src: string, dest: string) => {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
            }
            for (const item of fs.readdirSync(src)) {
                const srcPath = path.join(src, item);
                const destPath = path.join(dest, item);
                if (fs.statSync(srcPath).isDirectory()) {
                    copyRecursive(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        };

        copyRecursive(sourceDir, this.installDir);

        // Clean up temp directory
        fs.rmSync(tempExtractDir, { recursive: true });

        // Make executable on Unix
        if (process.platform !== 'win32' && fs.existsSync(this.executablePath)) {
            fs.chmodSync(this.executablePath, 0o755);
        }

        // Fix rpath on macOS (the build process hardcodes the CI build path)
        if (process.platform === 'darwin') {
            this.fixMacOSRpath();
        }
    }

    /**
     * Fix the rpath in macOS binaries to use @executable_path/../lib
     * The CI build hardcodes /Users/runner/work/... which doesn't exist locally
     */
    private fixMacOSRpath(): void {
        const correctRpath = '@executable_path/../lib';

        try {
            // Get current rpath
            const result = execSync(`otool -l "${this.executablePath}" | grep -A2 LC_RPATH | grep path || true`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Extract the old rpath path
            const match = result.match(/path\s+(.+?)\s+\(/);
            if (match && match[1] && match[1] !== correctRpath) {
                const oldRpath = match[1];
                this.outputChannel.appendLine(`Fixing rpath: ${oldRpath} -> ${correctRpath}`);

                // Remove old rpath and add correct one
                execSync(`install_name_tool -delete_rpath "${oldRpath}" "${this.executablePath}"`, { stdio: 'pipe' });
                execSync(`install_name_tool -add_rpath "${correctRpath}" "${this.executablePath}"`, { stdio: 'pipe' });

                this.outputChannel.appendLine('Rpath fixed successfully');
            }
        } catch (e) {
            // Log but don't fail - DYLD_LIBRARY_PATH fallback should still work
            this.outputChannel.appendLine(`Warning: Could not fix rpath: ${e}`);
        }
    }

    /**
     * Install or update vivid runtime
     */
    async installOrUpdate(forceUpdate: boolean = false): Promise<boolean> {
        const installedVersion = this.getInstalledVersion();

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Vivid Runtime',
            cancellable: false
        }, async (progress) => {
            try {
                // Check for latest release
                progress.report({ message: 'Checking for updates...' });

                let release: GitHubRelease;
                try {
                    release = await this.getLatestRelease();
                } catch (e) {
                    if (this.isInstalled()) {
                        this.outputChannel.appendLine('Could not check for updates, using installed version');
                        return true;
                    }
                    throw e;
                }

                const latestVersion = release.tag_name;

                // Check if update needed
                if (!forceUpdate && installedVersion && installedVersion.version === latestVersion) {
                    this.outputChannel.appendLine(`Vivid ${latestVersion} is already installed`);
                    return true;
                }

                // Find the correct asset
                const assetName = this.getAssetName();
                const asset = release.assets.find(a => a.name === assetName);

                if (!asset) {
                    const availableAssets = release.assets.map(a => a.name).join(', ');
                    throw new Error(
                        `No release found for ${process.platform}-${process.arch}.\n` +
                        `Available: ${availableAssets}\n` +
                        `Please build vivid manually or wait for a compatible release.`
                    );
                }

                this.outputChannel.appendLine(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

                // Download
                const tempDir = os.tmpdir();
                const archivePath = path.join(tempDir, asset.name);

                progress.report({ message: 'Downloading...', increment: 0 });
                await this.downloadFile(asset.browser_download_url, archivePath, progress, asset.size);

                // Extract
                progress.report({ message: 'Extracting...' });
                await this.extractArchive(archivePath);

                // Cleanup temp file
                fs.unlinkSync(archivePath);

                // Save version info
                this.saveVersionInfo(latestVersion);

                this.outputChannel.appendLine(`Vivid ${latestVersion} installed successfully`);
                vscode.window.showInformationMessage(`Vivid ${latestVersion} installed successfully`);

                return true;

            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`Installation failed: ${message}`);
                vscode.window.showErrorMessage(`Failed to install Vivid: ${message}`);
                return false;
            }
        });
    }

    /**
     * Ensure vivid is installed, prompting user if not
     */
    async ensureInstalled(): Promise<boolean> {
        if (this.isInstalled()) {
            return true;
        }

        const choice = await vscode.window.showInformationMessage(
            'Vivid runtime is not installed. Would you like to download it?',
            'Download',
            'Browse...',
            'Cancel'
        );

        if (choice === 'Download') {
            return this.installOrUpdate();
        } else if (choice === 'Browse...') {
            // Let user select manually
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: 'Select vivid executable',
                filters: process.platform === 'win32'
                    ? { 'Executable': ['exe'] }
                    : undefined
            });

            if (result && result.length > 0) {
                const config = vscode.workspace.getConfiguration('vivid');
                await config.update('runtimePath', result[0].fsPath, vscode.ConfigurationTarget.Global);
                return true;
            }
        }

        return false;
    }

    /**
     * Parse a semver version string (e.g., "v0.1.0" or "0.1.0") into components
     */
    private parseVersion(version: string): { major: number; minor: number; patch: number } | null {
        const match = version.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
        if (!match) {
            return null;
        }
        return {
            major: parseInt(match[1], 10),
            minor: parseInt(match[2], 10),
            patch: parseInt(match[3], 10)
        };
    }

    /**
     * Check if an update is a minor/patch update (safe to auto-install)
     */
    private isMinorOrPatchUpdate(installed: string, latest: string): boolean {
        const installedVer = this.parseVersion(installed);
        const latestVer = this.parseVersion(latest);

        if (!installedVer || !latestVer) {
            return false;
        }

        // Same major version = safe to auto-update
        return latestVer.major === installedVer.major &&
               (latestVer.minor > installedVer.minor ||
                (latestVer.minor === installedVer.minor && latestVer.patch > installedVer.patch));
    }

    /**
     * Check for updates (called periodically or on command)
     * Auto-installs minor/patch updates, prompts for major updates
     */
    async checkForUpdates(): Promise<void> {
        if (!this.isInstalled()) {
            return;
        }

        try {
            const release = await this.getLatestRelease();
            const installed = this.getInstalledVersion();

            if (installed && installed.version !== release.tag_name) {
                if (this.isMinorOrPatchUpdate(installed.version, release.tag_name)) {
                    // Auto-install minor/patch updates
                    this.outputChannel.appendLine(`Auto-updating to ${release.tag_name} (from ${installed.version})`);
                    vscode.window.showInformationMessage(`Vivid: Auto-updating to ${release.tag_name}...`);
                    await this.installOrUpdate(true);
                } else {
                    // Prompt for major version updates
                    const choice = await vscode.window.showInformationMessage(
                        `Vivid ${release.tag_name} is available (installed: ${installed.version}). This is a major update.`,
                        'Update',
                        'Later'
                    );

                    if (choice === 'Update') {
                        await this.installOrUpdate(true);
                    }
                }
            }
        } catch (e) {
            // Silently ignore update check failures
            this.outputChannel.appendLine(`Update check failed: ${e}`);
        }
    }

    /**
     * Get environment variables for running vivid
     */
    getEnvironment(): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // Add lib path for dynamic libraries
        if (process.platform === 'darwin') {
            env['DYLD_LIBRARY_PATH'] = this.libPath + (env['DYLD_LIBRARY_PATH'] ? ':' + env['DYLD_LIBRARY_PATH'] : '');
        } else if (process.platform === 'linux') {
            env['LD_LIBRARY_PATH'] = this.libPath + (env['LD_LIBRARY_PATH'] ? ':' + env['LD_LIBRARY_PATH'] : '');
        } else if (process.platform === 'win32') {
            env['PATH'] = this.libPath + ';' + (env['PATH'] || '');
        }

        return env;
    }

    /**
     * Spawn vivid process
     */
    spawnVivid(projectPath: string): ReturnType<typeof spawn> {
        const execPath = this.executablePath;
        const env = this.getEnvironment();

        this.outputChannel.appendLine(`Starting vivid: ${execPath} "${projectPath}"`);

        return spawn(execPath, [projectPath], {
            env,
            cwd: path.dirname(execPath)
        });
    }
}
