# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow the
extension's `version-name`.

## [1.0.1]

### Changed
- Use `connectObject()`/`disconnectObject()` for all signal handling so cleanup
  is easier to track.
- Move the media-message attach and lifecycle logic into the `MediaSeekBar`
  class (`ensureOn`/`patchExisting`/`destroyAll`); the extension entry point is
  now just `enable()`/`disable()`.
- Replace `_onDestroy()` with a proper `destroy()` override calling
  `super.destroy()`.

### Removed
- `license` field from `metadata.json` (not part of the metadata schema).

## [1.0.0]

### Added
- Initial release: progress/seek bar with elapsed and total time injected into
  the media controls of the date/notifications menu.
- Drag, scroll and keyboard seeking via MPRIS `SetPosition` (fallback `Seek`).
- Live position polling and automatic hide for tracks with no duration.
- Support for GNOME Shell 48, 49 and 50.
