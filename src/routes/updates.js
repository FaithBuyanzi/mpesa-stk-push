const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// ============================================================
// APP UPDATE MANIFESTS
// ============================================================
//
// GET /updates/android
// GET /updates/windows
//
// Tells the app which build is current, where to get it, and what its
// SHA-256 is. The app compares build numbers, downloads, verifies against
// that checksum, and only then hands the file to the operating system —
// see lib/services/update_service.dart.
//
// ------------------------------------------------------------
// Why a manifest and not the file
// ------------------------------------------------------------
//
// Three reasons, and the third is the one that matters:
//
//  1. The app has to compare before it downloads. Serving the file here
//     would mean fetching 30 MB to discover you already have it.
//  2. The binaries are served by Caddy from the website's downloads
//     folder. Streaming them through Express on a 1 GB box would put a
//     long transfer on the same event loop that answers Safaricom's
//     payment callbacks, which have a deadline.
//  3. `minSupportedBuild` has nowhere to live in a bare file. It is the
//     whole of "mandatory": set it to a build number and every older
//     install is stopped until it updates. Leave it alone and older
//     installs get an offer they can dismiss. Forcing every release
//     instead would mean a farm hand who wants to record the evening's
//     eggs being stopped by a cosmetic change, on a slow connection, at
//     7pm.
//
// ------------------------------------------------------------
// Where the content comes from
// ------------------------------------------------------------
//
// Two JSON files on disk, read per request rather than at start-up:
//
//   updates/android.json
//   updates/windows.json
//
// Read per request so publishing a release does not mean restarting the
// payments service. Editing a file is the whole of a release, and the one
// thing that must never take the Till offline is shipping a new version
// of the app.
//
// Override the directory with UPDATE_MANIFEST_DIR if the files live
// somewhere else on the box.

const MANIFEST_DIR =
  process.env.UPDATE_MANIFEST_DIR ||
  path.join(__dirname, "..", "..", "updates");

// The platforms the app knows how to update itself on. An allow-list
// rather than trusting the path segment: this reads a file named after
// it, and `/updates/..%2f..%2fetc%2fpasswd` is the obvious thing to try.
const PLATFORMS = ["android", "windows"];

// Everything the app needs to verify a download. A manifest missing any
// of these is refused here rather than being sent on for the app to
// refuse — a release published wrongly should fail where somebody is
// looking, not silently stop updating every phone on the farm.
const REQUIRED = ["version", "build", "url", "sha256"];

function readManifest(platform) {
  const file = path.join(MANIFEST_DIR, `${platform}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { missing: true };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { invalid: `not valid JSON (${err.message})` };
  }

  const missing = REQUIRED.filter(
    (key) => parsed[key] === undefined || parsed[key] === null || parsed[key] === ""
  );
  if (missing.length > 0) {
    return { invalid: `missing ${missing.join(", ")}` };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(String(parsed.sha256))) {
    return { invalid: "sha256 is not a SHA-256 digest" };
  }

  if (!/^https:\/\//i.test(String(parsed.url))) {
    // The app refuses this too. Refusing it here as well means a release
    // published over plain HTTP is caught by whoever published it rather
    // than by silence on every phone.
    return { invalid: "url must be https" };
  }

  const build = Number(parsed.build);
  if (!Number.isInteger(build) || build <= 0) {
    return { invalid: "build must be a positive whole number" };
  }

  return { manifest: { ...parsed, build, sha256: String(parsed.sha256).toLowerCase() } };
}

router.get("/:platform", (req, res) => {
  const platform = String(req.params.platform || "").toLowerCase();

  if (!PLATFORMS.includes(platform)) {
    return res.status(404).json({
      error: `Unknown platform. Expected one of: ${PLATFORMS.join(", ")}.`,
    });
  }

  let result;
  try {
    result = readManifest(platform);
  } catch (err) {
    console.error(`Could not read the ${platform} update manifest:`, err);
    return res.status(500).json({ error: "Could not read the manifest." });
  }

  if (result.missing) {
    // Not an error. A platform with nothing published yet is a normal
    // state, and 204 says "no update" without the app having to treat a
    // 404 as ordinary.
    return res.status(204).end();
  }

  if (result.invalid) {
    console.error(
      `The ${platform} update manifest is unusable: ${result.invalid}`
    );
    return res.status(500).json({
      error: `The published manifest is unusable: ${result.invalid}`,
    });
  }

  // Not cached. A release goes out when somebody edits the file, and a
  // proxy holding yesterday's answer would mean a mandatory update that
  // does not arrive — which is exactly the case it exists for.
  res.set("Cache-Control", "no-store");
  return res.json(result.manifest);
});

module.exports = router;
