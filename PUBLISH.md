# Publishing Vivid to the VS Code Marketplace

This guide explains how to publish the Vivid extension to the [VS Code Marketplace](https://marketplace.visualstudio.com/).

## Prerequisites

- Node.js 20+
- npm
- A Microsoft account
- Access to the GitHub repository

## One-Time Setup

### 1. Create an Azure DevOps Organization

1. Go to https://dev.azure.com/
2. Sign in with your Microsoft account
3. If prompted, create a new organization (any name works)

### 2. Create a Personal Access Token (PAT)

1. In Azure DevOps, click your profile icon (top right)
2. Select **Personal access tokens**
3. Click **New Token**
4. Configure the token:
   - **Name**: `vsce-publish` (or any descriptive name)
   - **Organization**: Select "All accessible organizations"
   - **Expiration**: Choose an appropriate duration (max 1 year)
   - **Scopes**: Select "Custom defined", then:
     - Expand **Marketplace**
     - Check **Manage**
5. Click **Create**
6. **Important**: Copy the token immediately. You won't be able to see it again.

### 3. Create a Publisher

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft account
3. Click **Create publisher**
4. Fill in the details:
   - **Publisher ID**: `seethroughlab` (must match the `publisher` field in `package.json`)
   - **Display name**: See Through Lab (or your preferred display name)
   - Other fields are optional
5. Click **Create**

### 4. Add the PAT to GitHub Secrets

1. Go to https://github.com/seethroughlab/vivid-vscode/settings/secrets/actions
2. Click **New repository secret**
3. Configure:
   - **Name**: `VSCE_PAT`
   - **Secret**: Paste your Personal Access Token
4. Click **Add secret**

## Publishing a New Version

### Option A: Automated Publishing (Recommended)

The repository includes a GitHub Actions workflow that automatically publishes when you push a version tag.

1. Update the version in `package.json`:
   ```json
   "version": "0.2.0"
   ```

2. Commit the version change:
   ```bash
   git add package.json
   git commit -m "Bump version to 0.2.0"
   git push
   ```

3. Create and push a version tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. The GitHub Action will:
   - Build the extension
   - Package it as a `.vsix` file
   - Publish to the VS Code Marketplace
   - Create a GitHub Release with the `.vsix` attached

5. Monitor progress at: https://github.com/seethroughlab/vivid-vscode/actions

### Option B: Manual Publishing

If you prefer to publish manually or need to troubleshoot:

1. Install dependencies and compile:
   ```bash
   npm ci
   npm run compile
   ```

2. Login to your publisher account:
   ```bash
   npx vsce login seethroughlab
   ```
   Enter your Personal Access Token when prompted.

3. Publish:
   ```bash
   npx vsce publish
   ```

   Or publish with a version bump:
   ```bash
   npx vsce publish minor  # 0.1.0 -> 0.2.0
   npx vsce publish patch  # 0.1.0 -> 0.1.1
   ```

### Option C: Manual Trigger via GitHub Actions

1. Go to https://github.com/seethroughlab/vivid-vscode/actions
2. Select the "Publish Extension" workflow
3. Click **Run workflow**
4. Choose whether to publish to the marketplace
5. Click **Run workflow**

## Creating a .vsix Package (Without Publishing)

To create a package for local testing or manual distribution:

```bash
npm run package
```

This creates a `vivid-<version>.vsix` file that can be:
- Installed locally: `code --install-extension vivid-0.1.0.vsix`
- Shared with others for manual installation
- Uploaded to the marketplace manually

## Verifying the Publication

1. Visit https://marketplace.visualstudio.com/items?itemName=seethroughlab.vivid
2. Check that the version number is correct
3. Test installation in VS Code:
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
   - Search for "Vivid"
   - Click Install

## Troubleshooting

### "Access Denied" or "Unauthorized" Error

- Verify your PAT hasn't expired
- Ensure the PAT has "Marketplace: Manage" scope
- Check that the publisher ID in `package.json` matches your publisher

### "Publisher not found" Error

- Create the publisher at https://marketplace.visualstudio.com/manage
- Ensure the publisher ID exactly matches the `publisher` field in `package.json`

### PAT Expired

1. Create a new PAT in Azure DevOps
2. Update the `VSCE_PAT` secret in GitHub repository settings
3. If publishing manually, run `npx vsce login seethroughlab` again

### Build Failures

Check the GitHub Actions logs for details:
https://github.com/seethroughlab/vivid-vscode/actions

Common issues:
- TypeScript compilation errors
- Missing dependencies
- Invalid `package.json` configuration

## Useful Links

- [VS Code Publishing Extensions Guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)
- [Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
- [Azure DevOps PAT Documentation](https://docs.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
