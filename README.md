# ducpm8 Home Assistant Add-ons

## Install

In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, paste:

```
https://github.com/ducpm8/youtube_cast_addon
```

Then install **YouTube Music Cinematic** from the store.

## Addons

- [youtube_cast_addon](./youtube_cast_addon/) — YouTube Music player with Cast, proxy stream, playlists, timer.

## Source

Forked + extracted from `ghcr.io/trankhanhduy2929-beep/youtube_cast_addon-amd64`, then perf-tuned for weak HA hosts (Pi 3 / 1GB / SD card).

## Image publishing

Multi-arch images (amd64, aarch64, armhf, armv7) built by GitHub Actions on every push to `main` and published to:

```
ghcr.io/ducpm8/youtube_cast_addon-{arch}
```

HA pulls the matching arch tag (== addon `version:` in `config.yaml`). `build.yaml` + `Dockerfile` remain as fallback in case the image is unavailable.
