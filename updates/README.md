# Publishing a new build

These two files are the release. `GET /updates/android` and
`GET /updates/windows` serve them verbatim, the app compares build numbers,
and everything else follows from what is written here.

They are read from disk **per request**, so editing one publishes a release
immediately — no restart. That is deliberate: shipping a new version of the
app must never take the Till offline.

## The fields

| field | what it does |
|---|---|
| `version` | Display only. Never compared. |
| `build` | The number that decides everything. Must increase. |
| `minSupportedBuild` | The oldest build still allowed to run. **This is what makes an update mandatory.** |
| `url` | Where the file is. Must be `https://`. |
| `sha256` | Checked by the app before it installs anything. Not optional. |
| `sizeBytes` | Shown to whoever is being asked to wait for a download. |
| `notes` | What changed, in a sentence or two. |
| `releasedAt` | ISO 8601. Display only. |

## Making an update mandatory

Set `minSupportedBuild` to the build that fixed the thing nobody can work
without — a wrong payment-matching rule, a Firestore rules change the app
depends on. Every install below it is stopped until it updates; everything
at or above it carries on.

Leave it where it is for an ordinary release. Older installs then get a
banner they can dismiss.

Forcing every release instead would mean a farm hand who wants to record
the evening's eggs being stopped by a cosmetic change, on a slow
connection, at 7pm. That is a worse failure than running one version
behind, so it is a decision made per release rather than a policy.

`minSupportedBuild` higher than `build` is a typo that would stop the newest
build with nothing to move to. The app clamps it, but do not rely on that.

## Steps

From the `selete-agro` repository:

```bash
# 1. Raise the version. The +N suffix is the build number.
#    Edit pubspec.yaml:  version: 0.2.0+2

flutter build apk --release
flutter build windows --release
```

Package and hash:

```bash
sha256sum build/app/outputs/flutter-apk/app-release.apk
```

Android ships as a **bare .apk**, not a zip — the installer needs the file
itself. The password-protected zips on the products page are a separate
thing, for reviewers.

Upload both to the website box:

```bash
scp -i <key.pem> \
  SeleteAgro-FarmManager-Android-v0.2.0.apk \
  SeleteAgro-FarmManager-Windows-x64-v0.2.0.zip \
  ubuntu@info.seleteagro.store:/var/www/selete-agro-website/downloads/
```

Then edit `android.json` and `windows.json` here — `version`, `build`,
`url`, `sha256`, `sizeBytes`, `notes`, `releasedAt` — and `git pull` on the
backend box. Confirm:

```bash
curl -s https://api.seleteagro.store/updates/android | jq .
```

## The checksum is the whole of the security

The app downloads a file and hands it to the operating system's installer.
The only thing standing between that and installing whatever arrived over
the wire is the SHA-256 in this file. A stale one means every update fails
verification and nobody can update; a wrong one means worse.

Copy it from `sha256sum` output for the exact file you uploaded, after
uploading it.
