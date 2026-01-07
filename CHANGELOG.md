# Changelog

## [0.1.0-alpha.7] - 2026-01-07

### Changed
- Replaced `vividRoot` setting with `vividPath` for specifying custom install locations
- Extension now responds to `vividPath` configuration changes without restart
- Simplified dev build support: point directly to `build/` directory containing `bin/vivid`

## [0.1.0-alpha.6] - 2026-01-06

### Added
- **Create New Project command**: Create Vivid projects from VS Code with template and addon selection
- **Run Project command**: Run projects in terminal with options for fullscreen, UI overlay, and custom window size
- **Bundle Project command**: Bundle projects as standalone apps with progress notification

## [0.1.0-alpha.5] - 2025-01-06

### Added
- **Operator documentation panel**: Click any operator in the sidebar to expand inline documentation showing:
  - Output type and input requirements
  - Full parameter list with types, defaults, and ranges
  - Usage code snippet
- Selection state persists across panel refreshes

## [0.1.0-alpha.4] - 2025-01-05

### Fixed
- Strip prerelease suffix from package.json version for marketplace compatibility

## [0.1.0-alpha.3] - 2025-01-05

### Fixed
- Include prereleases when checking for updates

## [0.1.0-alpha.2] - 2025-01-05

### Fixed
- Derive version from git tag instead of package.json for release workflow

## [0.1.0-alpha.1] - 2025-01-04

### Added
- Initial alpha release
- WGSL syntax highlighting
- Operator library sidebar panel
- Claude Code MCP integration setup
