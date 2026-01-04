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

**Git tags** are the single source of truth for versioning:
```
v0.1.0           Stable release
v0.1.0-alpha.2   Alpha pre-release
v0.1.0-beta.1    Beta pre-release
v0.1.0-rc.1      Release candidate
```

**package.json** contains a placeholder (`0.0.0-dev`) that is overwritten during CI from the git tag.

Pre-releases are published to the Marketplace with the `--pre-release` flag.

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
2. Update the Compatibility Matrix above if Vivid support changed
3. Create and push the tag:
   ```bash
   git tag v0.1.0-alpha.2
   git push origin v0.1.0-alpha.2
   ```

The release workflow will:
- Extract version from the git tag
- Build and package the extension
- Publish to VS Code Marketplace (with `--pre-release` flag for pre-release tags)
- Create GitHub Release with VSIX artifact

## Release Targets

| Tag Format | VS Code Marketplace | GitHub Release |
|------------|---------------------|----------------|
| `v0.1.0` | Published (stable) | Created with VSIX |
| `v0.1.0-alpha.2` | Published (pre-release) | Created with VSIX |
| `v0.1.0-beta.1` | Published (pre-release) | Created with VSIX |
| `v0.1.0-rc.1` | Published (pre-release) | Created with VSIX |

## Version in Code

At runtime, the version is available via the extension API (injected from git tag during CI):

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
