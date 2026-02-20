const fs = require("node:fs");
const path = require("node:path");

const PREBUILD_MODULES = [
  "bufferutil",
  "fs-native-extensions",
  "node-datachannel",
  "utf-8-validate",
  "utp-native",
];

function listDirectoryEntries(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs.readdirSync(directoryPath, { withFileTypes: true });
}

function removeDirectoryIfExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return;
  }

  fs.rmSync(directoryPath, { recursive: true, force: true });
  console.log(`[afterPackPrune] Removed: ${directoryPath}`);
}

function resolveNodeModulesRoot(appOutDir) {
  const candidateRoots = [
    path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules"),
    path.join(
      appOutDir,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
    ),
  ];

  return candidateRoots.find((candidatePath) => fs.existsSync(candidatePath));
}

function resolveResourcesRoot(appOutDir) {
  const candidateRoots = [
    path.join(appOutDir, "resources"),
    path.join(appOutDir, "Contents", "Resources"),
  ];

  return candidateRoots.find((candidatePath) => fs.existsSync(candidatePath));
}

function resolveBinaryNames(platformName) {
  const isWindows = platformName === "win32";
  return {
    ffmpeg: isWindows ? "ffmpeg.exe" : "ffmpeg",
    ffprobe: isWindows ? "ffprobe.exe" : "ffprobe",
    cloudTorrent: isWindows ? "cloud-torrent.exe" : "cloud-torrent",
  };
}

function mapArchName(archName) {
  if (archName === 1) return "x64";
  if (archName === 2) return "ia32";
  if (archName === 3) return "armv7l";
  if (archName === 4) return "arm64";

  if (archName === "x64") return "x64";
  if (archName === "arm64") return "arm64";
  if (archName === "ia32") return "ia32";
  if (archName === "armv7l") return "armv7l";
  if (archName === "arm") return "armv7l";
  return String(archName);
}

function pruneNativePrebuilds(nodeModulesRoot, platformName) {
  const expectedPrefix = `${platformName}-`;

  for (const moduleName of PREBUILD_MODULES) {
    const prebuildsDirectory = path.join(
      nodeModulesRoot,
      moduleName,
      "prebuilds",
    );

    for (const entry of listDirectoryEntries(prebuildsDirectory)) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (!entry.name.startsWith(expectedPrefix)) {
        removeDirectoryIfExists(path.join(prebuildsDirectory, entry.name));
      }

      if (platformName === "win32" && entry.name === "win32-ia32") {
        removeDirectoryIfExists(path.join(prebuildsDirectory, entry.name));
      }
    }
  }
}

function pruneDownloadedMediaResources(resourcesRoot, platformName, archName) {
  const mediaRoot = path.join(resourcesRoot, "bin");
  const normalizedArch = mapArchName(archName);

  if (!fs.existsSync(mediaRoot)) {
    console.log("[afterPackPrune] Skipped media resource pruning: resources/bin not found");
    return;
  }

  for (const platformEntry of listDirectoryEntries(mediaRoot)) {
    if (!platformEntry.isDirectory()) {
      continue;
    }

    if (platformEntry.name !== platformName) {
      removeDirectoryIfExists(path.join(mediaRoot, platformEntry.name));
      continue;
    }

    const platformRoot = path.join(mediaRoot, platformEntry.name);
    for (const archEntry of listDirectoryEntries(platformRoot)) {
      if (!archEntry.isDirectory()) {
        continue;
      }

      if (archEntry.name !== normalizedArch) {
        removeDirectoryIfExists(path.join(platformRoot, archEntry.name));
      }
    }

    const binaryNames = resolveBinaryNames(platformName);
    const ffmpegPath = path.join(platformRoot, normalizedArch, binaryNames.ffmpeg);
    const ffprobePath = path.join(platformRoot, normalizedArch, binaryNames.ffprobe);

    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
      console.warn(
        `[afterPackPrune] Expected ffmpeg/ffprobe binaries not found for ${platformName}/${normalizedArch}`,
      );
    }
  }
}

function pruneCloudTorrentResources(resourcesRoot, platformName, archName) {
  const cloudTorrentRoot = path.join(resourcesRoot, "cloud-torrent");
  const normalizedArch = mapArchName(archName);

  if (!fs.existsSync(cloudTorrentRoot)) {
    console.log("[afterPackPrune] Skipped cloud-torrent pruning: resource not found");
    return;
  }

  for (const platformEntry of listDirectoryEntries(cloudTorrentRoot)) {
    if (!platformEntry.isDirectory()) {
      continue;
    }

    if (platformEntry.name !== platformName) {
      removeDirectoryIfExists(path.join(cloudTorrentRoot, platformEntry.name));
      continue;
    }

    const platformRoot = path.join(cloudTorrentRoot, platformEntry.name);
    for (const archEntry of listDirectoryEntries(platformRoot)) {
      if (!archEntry.isDirectory()) {
        continue;
      }

      if (archEntry.name !== normalizedArch) {
        removeDirectoryIfExists(path.join(platformRoot, archEntry.name));
      }
    }

    const binaryNames = resolveBinaryNames(platformName);
    const selectedBinary = path.join(
      platformRoot,
      normalizedArch,
      binaryNames.cloudTorrent,
    );

    if (!fs.existsSync(selectedBinary)) {
      console.warn(
        `[afterPackPrune] Expected cloud-torrent binary not found: ${selectedBinary}`,
      );
    }
  }
}

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const nodeModulesRoot = resolveNodeModulesRoot(appOutDir);
  const resourcesRoot = resolveResourcesRoot(appOutDir);

  if (!resourcesRoot) {
    console.log("[afterPackPrune] Skipped: required app paths not found");
    return;
  }

  pruneCloudTorrentResources(resourcesRoot, electronPlatformName, arch);
  pruneDownloadedMediaResources(resourcesRoot, electronPlatformName, arch);

  if (!nodeModulesRoot) {
    console.log("[afterPackPrune] Skipped node_modules pruning: app.asar.unpacked not found");
    return;
  }

  pruneNativePrebuilds(nodeModulesRoot, electronPlatformName);
};
