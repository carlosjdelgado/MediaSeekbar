# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow the
extension's `version-name`.

## [1.1.2]

### Fixed
- Seek bar no longer disappears when seeking in Firefox: a transient
  `Metadata` without `mpris:length` for the same `mpris:trackid` is now
  ignored.

## [1.1.1]

### Changed
- `SeekBar` cleanup runs in a `destroy()` override instead of a `destroy`
  signal handler, per EGO reviewer feedback.

## [1.1.0]

### Changed
- Rewritten implementation: drops the `MediaMessage._update()` override
  (`InjectionManager`) in favour of subscribing to the message view directly
  and to the session bus' `NameOwnerChanged` for player tracking.
- Position display is now driven by a local monotonic clock and only resynced
  from D-Bus on state/metadata changes, avoiding the jitter caused by polling
  latency.

## [1.0.0]

### Added
- Initial release: progress/seek bar with elapsed and total time injected into
  the media controls of the date/notifications menu.
- Drag, scroll and keyboard seeking via MPRIS `SetPosition` (fallback `Seek`).
- Live position polling and automatic hide for tracks with no duration.
- Support for GNOME Shell 48, 49 and 50.
