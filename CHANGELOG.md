# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow the
extension's `version-name`.

## [1.0.1]

### Changed
- Use `connectObject()`/`disconnectObject()` for all signal handling so cleanup
  is easier to track.
- Keep the attach/lifecycle logic as instance methods on the extension
  (`_ensureOn`/`_mediaMessages`); each bar is stored on its media message and
  `destroy()`ed individually on `disable()`.

### Fixed
- Tear down the polling timer and D-Bus call when the player goes away and the
  shell destroys the parent message: clean-up now runs from the actor's
  `'destroy'` signal too, not only the explicit `destroy()` path.

### Removed
- `license` field from `metadata.json` (not part of the metadata schema).

## [1.0.0]

### Added
- Initial release: progress/seek bar with elapsed and total time injected into
  the media controls of the date/notifications menu.
- Drag, scroll and keyboard seeking via MPRIS `SetPosition` (fallback `Seek`).
- Live position polling and automatic hide for tracks with no duration.
- Support for GNOME Shell 48, 49 and 50.
