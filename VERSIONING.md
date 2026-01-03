# Versioning Conventions

Vivid VS Code Extension follows [Semantic Versioning 2.0.0](https://semver.org/) with pre-release extensions for testing builds.

## Independent Versioning

The extension version is **independent** from the Vivid runtime version. Each project evolves at its own pace:

- Extension-only changes (UI improvements, new VS Code features) don't require a Vivid release
- Vivid runtime updates don't require an extension release unless compatibility breaks
- The extension declares which Vivid runtime versions it supports

## Compatibility Matrix

| Extension Version | Supported Vivid Versions | Notes |
|-------------------|--------------------------|-------|
| 0.1.0-alpha.1     | 0.1.x                    | Initial alpha release |

When releasing a new extension version, update this matrix to document supported Vivid versions.

## Version Format

```
MAJOR.MINOR.PATCH[-PRERELEASE]

Examples:
  0.1.0          Stable release
  0.1.1-alpha.1  Alpha pre-release
  0.1.1-beta.1   Beta pre-release
  0.1.1-rc.1     Release candidate
  1.0.0          First stable major release
```

## Release Types

### Major Release (`X.0.0`)

**When to bump:** Breaking changes that require users to modify their configuration or workflows.

Examples:
- Removing or renaming commands
- Changing settings keys in incompatible ways
- Major changes to extension behavior
- Dropping support for older VS Code versions

### Minor Release (`0.X.0`)

**When to bump:** New features that are backwards-compatible.

Examples:
- Adding new commands
- Adding new settings (with defaults)
- New UI panels or views
- Enhanced syntax highlighting
- New integrations

### Patch Release (`0.0.X`)

**When to bump:** Bug fixes and small improvements that are backwards-compatible.

Examples:
- Bug fixes
- Documentation updates
- Build system fixes
- Dependency updates

## Pre-release Versions

Pre-releases are for testing before a stable release. They are **not** published to the VS Code Marketplace by default.

### Alpha (`-alpha.N`)

Early development, may be unstable. For internal testing.

### Beta (`-beta.N`)

Feature complete, testing phase. For adventurous users.

### Release Candidate (`-rc.N`)

Final testing before stable release. Should be production-ready.

## Creating a Release

1. Ensure CI passes on `main`
2. Update version in `package.json`
3. Update the Compatibility Matrix above if Vivid support changed
4. Commit changes
5. Create and push the tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The release workflow will:
- Build and package the extension
- Publish to VS Code Marketplace (stable releases only)
- Create GitHub Release with VSIX artifact

## Release Targets

| Tag Format | VS Code Marketplace | GitHub Release |
|------------|---------------------|----------------|
| `v1.2.3` | Published | Created with VSIX |
| `v1.2.3-alpha.1` | Not published | Created with VSIX |
| `v1.2.3-beta.1` | Not published | Created with VSIX |
| `v1.2.3-rc.1` | Not published | Created with VSIX |

Pre-releases can be manually installed via the VSIX file from GitHub Releases.

## Version in Code

The version is defined in `package.json`. Access in TypeScript:

```typescript
import * as vscode from 'vscode';

const extension = vscode.extensions.getExtension('seethroughlab.vivid-vscode');
const version = extension?.packageJSON.version;
```

## Coordinating with Vivid Runtime

This extension auto-downloads the Vivid runtime. When a new Vivid runtime version is released:

1. Test the extension with the new runtime version
2. Update the Compatibility Matrix if the supported range changes
3. Release a new extension version only if changes are required
