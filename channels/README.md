# Release channel manifests

One JSON file per channel. The game and the download page read these over
HTTPS from the published site, so the URL of each file is stable:

    https://<site>/channels/stable.json
    https://<site>/channels/dev.json

Schema (all fields required, `platforms` may be empty before the first release):

```json
{
  "channel": "stable",
  "version": "0.2.0",
  "released": "2026-09-04T18:30:00Z",
  "notes_url": "https://github.com/<owner>/<releases-repo>/releases/tag/v0.2.0",
  "platforms": {
    "windows-x64": {
      "url": "https://.../voxenite-0.2.0-windows-x64-setup.exe",
      "kind": "installer", "size": 12345678, "sha256": "...", "executable": "voxenite.exe"
    },
    "macos-universal": {
      "url": "https://.../voxenite-0.2.0-macos-universal.dmg",
      "kind": "dmg", "size": 12345678, "sha256": "...", "executable": "voxenite",
      "update": { "url": "https://.../voxenite-0.2.0-macos-universal.zip", "kind": "zip", "size": 12345678, "sha256": "..." }
    },
    "linux-x64": {
      "url": "https://.../voxenite-0.2.0-linux-x64.AppImage",
      "kind": "appimage", "size": 12345678, "sha256": "...", "executable": "voxenite"
    }
  }
}
```

- `url` is what the website's download button serves.
- `kind` is `installer` (Inno Setup exe), `dmg`, or `appimage`.
- `update`, present only for macOS, is the zipped `.app` the in-game updater
  downloads and swaps in place (a `.dmg` cannot be applied without mounting it).
  On Windows the updater runs the installer silently; on Linux it replaces the
  AppImage file with the new one. Both use `url` directly.
- `sha256` is verified by the updater before anything is executed or replaced.

Who writes what:

- `dev.json` is rewritten by CI (`.github/workflows/release.yml`) on every `v*` tag.
- `stable.json` is rewritten only by `release/promote.py`, run by hand when a
  build is ready for players. Nothing automatic ever touches it.
