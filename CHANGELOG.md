# Changelog

All notable changes to this project are documented here.

## [0.8.6] - 2026-10-26

### Changed
- README: removed the pinned-version example from the install section; it went stale on every release.

## [0.8.5] - 2026-10-26

### Changed
- README: the install command now appears directly under the title.

## [0.8.4] - 2026-10-26

### Changed
- README: the pinned install example now names the current version.

## [0.8.3] - 2026-10-25

### Changed
- Panel, tuning metadata and audit warnings now say "精简" instead of "瘦身"; README follows the same wording.
- No behavior change.

## [0.8.2] - 2026-10-25

### Changed
- README: added a "相关工具" section that lists three adjacent context tools as design references only (compatibility and their effects were not evaluated).
- README: renamed "为什么值得装" to "特点" and removed promotional wording.
- README: clarified that the package is distributed via npm and installed with `dsh plugin add`.
- package.json: replaced the internal description with a user-facing one.

## [0.8.1] - 2026-10-25

### Changed
- Rewrote README for public consumption: focused on what the plugin does, how it works, installation and usage; removed internal design notes, endpoint tables and limitation lists.

## [0.8.0] - 2026-10-25

### Added
- Added a read-only provider usage measurement channel from `session/event` `assistant/message.usage` numeric fields; prompt content is not read.
- Added measured hit-rate and measurement-basis sections to the panel, distinct from estimates.
- Added two JSONL record kinds: assemble statistics and provider usage measurements.

### Fixed
- Release the statistics file handle during plugin disposal/reload.

## [0.7.1] - 2026-10-25

### Added
- Added window slimming percentages and per-conversation slimming rates to the statistics view.
- Added byte/token before-and-after values to the statistics API for rate calculations.

### Changed
- Reordered statistics cards by impact for consistent scanning.

## [0.7.0] - 2026-10-25

### Added
- Added a three-tab panel for statistics, configuration, and fine tuning.
- Added persistent per-conversation statistics with today, 7-day, and 30-day windows.
- Added saved tuning configuration, automatic backups, restore, and return-to-defaults support.
- Added metadata describing all 31 configuration items.

### Changed
- Configuration saves now persist and take precedence over profile configuration until restored to defaults.

## [0.6.0] - 2026-10-25

### Added
- Preserved JSON Schema `enum` and `items` constraints during slimming, with counters for retained constraints and over-budget results.
- Added official pricing snapshots and four estimate bands for cache hit/miss and peak/off-peak pricing.

### Changed
- Kept the visibility → slimming → key-ordering pipeline and session-frozen configuration behavior.

## [0.5.0] - 2026-10-25

### Added
- Added tool visibility controls, including dry-run measurement, with visibility performed before slimming and ordering.
- Added pricing estimates and a bounded decision ledger for diagnostics.

### Changed
- Renamed the read-only Inspect provider to `RiceGuard`.

## [Earlier]

### Added
- Added deterministic tool-schema slimming and object-key ordering while preserving array order and leaving tool execution definitions untouched.
- Added session-frozen configuration so changes apply to new sessions by default.
- Added the read-only Inspect provider and the Rice Guard panel with statistics and configuration controls.
