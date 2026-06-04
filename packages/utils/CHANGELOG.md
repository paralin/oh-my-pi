# Changelog

## [Unreleased]

### Fixed

- Added `OMP_NO_PROJECT_ENV=1` so omp skips its `$PWD/.env` merge and scrubs Bun-autoloaded project keys without deleting explicit parent environment values ([#1804](https://github.com/can1357/oh-my-pi/issues/1804)).

## [15.7.3] - 2026-05-31
### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.omp/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.