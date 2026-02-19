const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_PLATFORM_DIRS = new Set(["win32", "darwin", "linux"]);
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
  };
}

function pruneFfprobeStatic(nodeModulesRoot, platformName) {
  const ffprobeBinDirectory = path.join(
    nodeModulesRoot,
    "ffprobe-static",
    "bin",
  );

  for (const entry of listDirectoryEntries(ffprobeBinDirectory)) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (
      SUPPORTED_PLATFORM_DIRS.has(entry.name) &&
      entry.name !== platformName
    ) {
      removeDirectoryIfExists(path.join(ffprobeBinDirectory, entry.name));
    }
  }

  if (platformName === "win32") {
    removeDirectoryIfExists(path.join(ffprobeBinDirectory, "win32", "ia32"));
  }
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

function pruneBundledMediaModules(
  nodeModulesRoot,
  resourcesRoot,
  platformName,
) {
  const binaryNames = resolveBinaryNames(platformName);
  const ffmpegResourcePath = path.join(resourcesRoot, binaryNames.ffmpeg);
  const ffprobeResourcePath = path.join(resourcesRoot, binaryNames.ffprobe);

  if (
    !fs.existsSync(ffmpegResourcePath) ||
    !fs.existsSync(ffprobeResourcePath)
  ) {
    console.warn(
      "[afterPackPrune] Skipped ffmpeg/ffprobe module pruning: expected resource binaries were not found",
    );
    return;
  }

  removeDirectoryIfExists(path.join(nodeModulesRoot, "ffmpeg-static"));
  removeDirectoryIfExists(path.join(nodeModulesRoot, "ffprobe-static"));
}

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  const nodeModulesRoot = resolveNodeModulesRoot(appOutDir);
  const resourcesRoot = resolveResourcesRoot(appOutDir);

  if (!nodeModulesRoot || !resourcesRoot) {
    console.log("[afterPackPrune] Skipped: required app paths not found");
    return;
  }

  pruneFfprobeStatic(nodeModulesRoot, electronPlatformName);
  pruneNativePrebuilds(nodeModulesRoot, electronPlatformName);
  pruneBundledMediaModules(
    nodeModulesRoot,
    resourcesRoot,
    electronPlatformName,
  );
};
