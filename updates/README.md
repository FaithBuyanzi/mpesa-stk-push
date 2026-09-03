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

The full release procedure — versioning, building, signing, hashing,
uploading and the website — lives in `RELEASING.md` at the root of the
`selete-agro` app repository. It is one loop across three repositories and
is kept in one place so it cannot drift.

What belongs here is only the last part of it: edit `android.json` and
`windows.json` with the new `version`, `build`, `url`, `sha256`,
`sizeBytes`, `notes` and `releasedAt`, then confirm:

```bash
curl -s https://api.seleteagro.store/updates/android | jq .
curl -sI https://info.seleteagro.store/downloads/<the file named in url> | head -1
```

Android ships as a **bare .apk**, not a zip — the installer needs the file
itself. Windows ships as a zip of the release folder, and it must never be
password-protected: the updater unpacks it without a person present.

## The checksum is the whole of the security

The app downloads a file and hands it to the operating system's installer.
The only thing standing between that and installing whatever arrived over
the wire is the SHA-256 in this file. A stale one means every update fails
verification and nobody can update; a wrong one means worse.

Copy it from `sha256sum` output for the exact file you uploaded, after
uploading it.
