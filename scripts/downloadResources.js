const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { spawnSync } = require("node:child_process");

const CLOUD_TORRENT_RELEASE_URL =
  "https://api.github.com/repos/jpillora/cloud-torrent/releases/latest";
const FFMPEG_RELEASE_URL =
  "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FFMPEG_RELEASES_URL =
  "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=20";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ALLOW_SYSTEM_FFMPEG_FALLBACK =
  process.env.ALLOW_SYSTEM_FFMPEG_FALLBACK !== "0";

const OUTPUT_ROOT = path.join(process.cwd(), "resources");
const CLOUD_OUTPUT_ROOT = path.join(OUTPUT_ROOT, "cloud-torrent");
const BIN_OUTPUT_ROOT = path.join(OUTPUT_ROOT, "bin");
const TMP_ROOT = path.join(process.cwd(), ".tmp", "resources-download");

const PLATFORM_MAP = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux",
};

const ARCH_MAP = {
  x64: "amd64",
  arm64: "arm64",
  ia32: "386",
  armv6l: "armv6",
  armv7l: "armv7",
  arm: "armv7",
};

const FFMPEG_PLATFORM_TOKEN = {
  win32: {
    x64: "win64",
    arm64: "winarm64",
  },
  darwin: {
    x64: "macos64",
    arm64: "macosarm64",
  },
  linux: {
    x64: "linux64",
    arm64: "linuxarm64",
  },
};

function parseCliValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }
  return process.argv[index + 1];
}

function hasCliFlag(flagName) {
  return process.argv.includes(flagName);
}

function normalizePlatform(platform) {
  if (!platform) {
    return process.platform;
  }

  if (platform === "windows") return "win32";
  if (platform === "mac" || platform === "macos" || platform === "osx") {
    return "darwin";
  }

  return platform;
}

function normalizeArch(arch) {
  if (!arch) {
    return process.arch;
  }

  if (arch === "amd64") return "x64";
  if (arch === "386") return "ia32";
  if (arch === "armv7") return "armv7l";
  if (arch === "armv6") return "armv6l";

  return arch;
}

function getTargetBuild() {
  const platform = normalizePlatform(
    parseCliValue("--platform") ||
      process.env.BUILD_PLATFORM ||
      process.env.npm_config_platform ||
      process.env.npm_config_target_platform ||
      process.platform,
  );

  const arch = normalizeArch(
    parseCliValue("--arch") ||
      process.env.BUILD_ARCH ||
      process.env.npm_config_arch ||
      process.env.npm_config_target_arch ||
      process.arch,
  );

  return { platform, arch };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestHandle = https.get(url, { headers }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        resolve(request(response.headers.location, headers));
        return;
      }

      if (response.statusCode !== 200) {
        reject(
          new Error(
            `Failed request ${url}. Status: ${response.statusCode ?? "unknown"}`,
          ),
        );
        return;
      }

      resolve(response);
    });

    requestHandle.on("error", reject);
  });
}

async function downloadText(url) {
  const stream = await request(url, {
    "User-Agent": "koodaamo-watchalong-build",
    Accept: "application/vnd.github+json",
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  });
  let raw = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    raw += chunk;
  }
  return raw;
}

async function downloadJson(url) {
  return JSON.parse(await downloadText(url));
}

async function downloadFile(url, outputPath) {
  ensureDirectory(path.dirname(outputPath));
  const stream = await request(url, {
    "User-Agent": "koodaamo-watchalong-build",
    Accept: "application/octet-stream",
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  });
  await pipeline(stream, fs.createWriteStream(outputPath));
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function parseChecksums(content) {
  const entries = new Map();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+[* ]?(.+)$/);
    if (!match) continue;
    entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

async function verifyChecksum(filePath, filename, checksumMap) {
  const expected = checksumMap.get(filename);
  if (!expected) {
    throw new Error(`Missing checksum entry for ${filename}`);
  }

  const actual = await sha256OfFile(filePath);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${filename}. expected=${expected} actual=${actual}`,
    );
  }
}

function resolveCloudTorrentAsset(release, target) {
  const releasePlatform = PLATFORM_MAP[target.platform];
  const releaseArch = ARCH_MAP[target.arch];

  if (!releasePlatform || !releaseArch) {
    throw new Error(
      `Unsupported cloud-torrent target: ${target.platform}/${target.arch}`,
    );
  }

  const matcher = new RegExp(
    `^cloud-torrent_[^_]+_${releasePlatform}_${releaseArch}\\.gz$`,
  );
  const asset = (release.assets || []).find((candidate) =>
    matcher.test(candidate.name),
  );

  if (!asset) {
    throw new Error(
      `cloud-torrent asset not found for ${target.platform}/${target.arch}`,
    );
  }

  const checksumsAsset = (release.assets || []).find(
    (candidate) =>
      candidate.name === "cloud-torrent_0.9.4_checksums.txt" ||
      /checksums\.txt$/.test(candidate.name),
  );

  if (!checksumsAsset) {
    throw new Error("cloud-torrent checksums asset not found");
  }

  return { asset, checksumsAsset };
}

function parseFfmpegVersionFromName(name) {
  const versionMatch = name.match(/ffmpeg-n(\d+\.\d+)-latest/);
  if (!versionMatch) {
    return -1;
  }
  return Number.parseFloat(versionMatch[1]);
}

function getFfmpegTokenAliases(platform, arch) {
  const canonicalToken = FFMPEG_PLATFORM_TOKEN[platform]?.[arch];
  if (!canonicalToken) {
    return [];
  }

  const aliases = new Set([canonicalToken]);
  if (platform === "darwin") {
    if (arch === "arm64") {
      aliases.add("mac-arm64");
      aliases.add("darwinarm64");
      aliases.add("macos-aarch64");
    }
    if (arch === "x64") {
      aliases.add("mac64");
      aliases.add("darwin64");
    }
  }

  return Array.from(aliases);
}

function resolveFfmpegAssetInRelease(release, target) {
  const tokenAliases = getFfmpegTokenAliases(target.platform, target.arch);
  if (tokenAliases.length === 0) {
    throw new Error(
      `Unsupported ffmpeg target: ${target.platform}/${target.arch}`,
    );
  }

  const matcher =
    /^ffmpeg-(?:n\d+\.\d+|master)-latest-(.+)-(gpl|lgpl)(?:-\d+\.\d+)?\.(zip|tar\.xz)$/i;

  const candidates = (release.assets || [])
    .map((candidate) => {
      const match = candidate.name.match(matcher);
      if (!match) {
        return null;
      }

      const assetToken = match[1].toLowerCase();
      const matchedAlias = tokenAliases.find(
        (tokenAlias) => assetToken === tokenAlias.toLowerCase(),
      );

      if (!matchedAlias) {
        return null;
      }

      const license = match[2].toLowerCase();
      const version = parseFfmpegVersionFromName(candidate.name);
      return {
        candidate,
        license,
        version,
      };
    })
    .filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const aLicenseScore = a.license === "gpl" ? 2 : 1;
    const bLicenseScore = b.license === "gpl" ? 2 : 1;
    if (aLicenseScore !== bLicenseScore) {
      return bLicenseScore - aLicenseScore;
    }
    if (a.version !== b.version) {
      return b.version - a.version;
    }
    return a.candidate.name.localeCompare(b.candidate.name);
  });

  const checksumsAsset = (release.assets || []).find(
    (candidate) => candidate.name === "checksums.sha256",
  );

  if (!checksumsAsset) {
    return null;
  }

  return {
    asset: candidates[0].candidate,
    checksumsAsset,
  };
}

function extractTarArchive(archivePath, outputDir) {
  ensureDirectory(outputDir);
  const result = spawnSync("tar", ["-xf", archivePath, "-C", outputDir], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to extract archive ${archivePath}: ${result.stderr || result.stdout}`,
    );
  }
}

function extractZipArchive(archivePath, outputDir) {
  ensureDirectory(outputDir);

  const commands =
    process.platform === "win32"
      ? [
          [
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outputDir}' -Force`,
            ],
          ],
          ["tar", ["-xf", archivePath, "-C", outputDir]],
        ]
      : [
          ["unzip", ["-o", archivePath, "-d", outputDir]],
          ["tar", ["-xf", archivePath, "-C", outputDir]],
        ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) {
      return;
    }
  }

  throw new Error(`Failed to extract zip archive ${archivePath}`);
}

function extractArchive(archivePath, outputDir) {
  if (archivePath.endsWith(".zip")) {
    extractZipArchive(archivePath, outputDir);
    return;
  }

  extractTarArchive(archivePath, outputDir);
}

function summarizeRelease(release) {
  return release?.tag_name || release?.name || String(release?.id || "unknown");
}

function findExecutablePath(commandName) {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [commandName], { encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return lines[0];
}

function prepareSystemFfmpeg(target) {
  const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  const ffprobeCheck = spawnSync("ffprobe", ["-version"], {
    encoding: "utf8",
  });

  if (ffmpegCheck.status !== 0 || ffprobeCheck.status !== 0) {
    return false;
  }

  const ffmpegSource = findExecutablePath("ffmpeg");
  const ffprobeSource = findExecutablePath("ffprobe");
  if (!ffmpegSource || !ffprobeSource) {
    return false;
  }

  const ffmpegName = target.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = target.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const targetDir = path.join(BIN_OUTPUT_ROOT, target.platform, target.arch);
  ensureDirectory(targetDir);

  const ffmpegTarget = path.join(targetDir, ffmpegName);
  const ffprobeTarget = path.join(targetDir, ffprobeName);
  fs.copyFileSync(ffmpegSource, ffmpegTarget);
  fs.copyFileSync(ffprobeSource, ffprobeTarget);
  fs.chmodSync(ffmpegTarget, 0o755);
  fs.chmodSync(ffprobeTarget, 0o755);

  console.log(`[resources] ffmpeg fallback source: ${ffmpegSource}`);
  console.log(`[resources] ffprobe fallback source: ${ffprobeSource}`);
  console.log(`[resources] ffmpeg ready (system fallback): ${ffmpegTarget}`);
  console.log(`[resources] ffprobe ready (system fallback): ${ffprobeTarget}`);

  return true;
}

async function resolveFfmpegAsset(target) {
  const latestRelease = await downloadJson(FFMPEG_RELEASE_URL);
  const latestResolved = resolveFfmpegAssetInRelease(latestRelease, target);
  if (latestResolved) {
    return { release: latestRelease, ...latestResolved };
  }

  const recentReleases = await downloadJson(FFMPEG_RELEASES_URL);
  for (const release of recentReleases) {
    if (release.draft || release.prerelease) {
      continue;
    }
    if (release.id === latestRelease.id) {
      continue;
    }

    const resolved = resolveFfmpegAssetInRelease(release, target);
    if (resolved) {
      return { release, ...resolved };
    }
  }

  const aliases = getFfmpegTokenAliases(target.platform, target.arch);
  throw new Error(
    `ffmpeg asset not found for target ${target.platform}/${target.arch}. checked recent BtbN releases for tokens: ${aliases.join(", ")}`,
  );
}

function findFileRecursively(rootDir, filename) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.name.toLowerCase() === filename.toLowerCase()) {
        return fullPath;
      }
    }
  }
  return "";
}

function hasExistingCloudTorrentBinary(target) {
  const targetDir = path.join(CLOUD_OUTPUT_ROOT, target.platform, target.arch);
  const binaryName =
    target.platform === "win32" ? "cloud-torrent.exe" : "cloud-torrent";
  const binaryPath = path.join(targetDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    return false;
  }

  const stats = fs.statSync(binaryPath);
  return stats.isFile() && stats.size > 0;
}

function hasExistingFfmpegBinaries(target) {
  const targetDir = path.join(BIN_OUTPUT_ROOT, target.platform, target.arch);
  const ffmpegName = target.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = target.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const ffmpegPath = path.join(targetDir, ffmpegName);
  const ffprobePath = path.join(targetDir, ffprobeName);

  if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
    return false;
  }

  const ffmpegStats = fs.statSync(ffmpegPath);
  const ffprobeStats = fs.statSync(ffprobePath);

  return (
    ffmpegStats.isFile() &&
    ffprobeStats.isFile() &&
    ffmpegStats.size > 0 &&
    ffprobeStats.size > 0
  );
}

async function downloadCloudTorrent(target) {
  const release = await downloadJson(CLOUD_TORRENT_RELEASE_URL);
  const { asset, checksumsAsset } = resolveCloudTorrentAsset(release, target);

  const checksumsText = await downloadText(checksumsAsset.browser_download_url);
  const checksums = parseChecksums(checksumsText);

  const archivePath = path.join(TMP_ROOT, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);
  await verifyChecksum(archivePath, asset.name, checksums);

  const targetDir = path.join(CLOUD_OUTPUT_ROOT, target.platform, target.arch);
  ensureDirectory(targetDir);

  const binaryName =
    target.platform === "win32" ? "cloud-torrent.exe" : "cloud-torrent";
  const outputPath = path.join(targetDir, binaryName);
  await pipeline(
    fs.createReadStream(archivePath),
    zlib.createGunzip(),
    fs.createWriteStream(outputPath),
  );
  fs.chmodSync(outputPath, 0o755);

  console.log(
    `[resources] cloud-torrent ready (${release.tag_name}): ${outputPath}`,
  );
}

async function downloadFfmpeg(target) {
  let selectedFfmpeg;
  try {
    selectedFfmpeg = await resolveFfmpegAsset(target);
  } catch (error) {
    if (
      target.platform === "darwin" &&
      ALLOW_SYSTEM_FFMPEG_FALLBACK &&
      prepareSystemFfmpeg(target)
    ) {
      console.warn(
        `[resources] Falling back to system ffmpeg because BtbN release lookup failed: ${error.message}`,
      );
      return;
    }

    throw error;
  }

  const { release, asset, checksumsAsset } = selectedFfmpeg;

  const checksumsText = await downloadText(checksumsAsset.browser_download_url);
  const checksums = parseChecksums(checksumsText);

  const archivePath = path.join(TMP_ROOT, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);
  await verifyChecksum(archivePath, asset.name, checksums);

  const extractDir = path.join(TMP_ROOT, "ffmpeg-extract");
  removeDirectory(extractDir);
  extractArchive(archivePath, extractDir);

  const ffmpegName = target.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = target.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const ffmpegSource = findFileRecursively(extractDir, ffmpegName);
  const ffprobeSource = findFileRecursively(extractDir, ffprobeName);

  if (!ffmpegSource || !ffprobeSource) {
    throw new Error(
      `Unable to locate ffmpeg/ffprobe binaries after extraction of ${asset.name}`,
    );
  }

  const targetDir = path.join(BIN_OUTPUT_ROOT, target.platform, target.arch);
  ensureDirectory(targetDir);
  const ffmpegTarget = path.join(targetDir, ffmpegName);
  const ffprobeTarget = path.join(targetDir, ffprobeName);
  fs.copyFileSync(ffmpegSource, ffmpegTarget);
  fs.copyFileSync(ffprobeSource, ffprobeTarget);
  fs.chmodSync(ffmpegTarget, 0o755);
  fs.chmodSync(ffprobeTarget, 0o755);

  console.log(
    `[resources] ffmpeg release selected: ${summarizeRelease(release)}`,
  );
  console.log(`[resources] ffmpeg ready (${asset.name}): ${ffmpegTarget}`);
  console.log(`[resources] ffprobe ready (${asset.name}): ${ffprobeTarget}`);
}

async function main() {
  const target = getTargetBuild();
  const forceDownload = hasCliFlag("--force");
  console.log(
    `[resources] Preparing binaries for ${target.platform}/${target.arch}`,
  );

  removeDirectory(TMP_ROOT);
  ensureDirectory(TMP_ROOT);

  if (forceDownload || !hasExistingCloudTorrentBinary(target)) {
    await downloadCloudTorrent(target);
  } else {
    console.log("[resources] cloud-torrent already present, skipping download");
  }

  if (forceDownload || !hasExistingFfmpegBinaries(target)) {
    await downloadFfmpeg(target);
  } else {
    console.log(
      "[resources] ffmpeg/ffprobe already present, skipping download",
    );
  }

  removeDirectory(TMP_ROOT);
  console.log("[resources] Resource preparation completed");
}

main().catch((error) => {
  console.error("[resources] Failed to prepare resources", error);
  process.exitCode = 1;
});
