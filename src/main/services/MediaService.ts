import { spawn } from "child_process";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";

import logger from "@utilities/logging";
import {
  HardwareAccelerationInfo,
  MediaAnalysis,
  SegmentMediaOptions,
} from "@shared/types";

let ffmpegPath: string;
let ffprobePath: string;
function mapArch(arch: NodeJS.Architecture): string {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  if (arch === "ia32") return "ia32";
  if (arch === "arm") return "armv7l";
  return arch;
}

if (app.isPackaged) {
  // In packaged app, binaries are in resources
  const resourcesPath = process.resourcesPath;
  const isWindows = process.platform === "win32";
  const exe = isWindows ? ".exe" : "";
  ffmpegPath = path.join(resourcesPath, `ffmpeg${exe}`);
  ffprobePath = path.join(resourcesPath, `ffprobe${exe}`);
} else {
  const arch = mapArch(process.arch);
  const isWindows = process.platform === "win32";
  const exe = isWindows ? ".exe" : "";
  const base = path.join(
    process.cwd(),
    "resources",
    "bin",
    process.platform,
    arch,
  );
  ffmpegPath = path.join(base, `ffmpeg${exe}`);
  ffprobePath = path.join(base, `ffprobe${exe}`);
}

export class MediaService {
  private runProcess(
    command: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args);
      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("error", (error) => reject(error));
      process.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async getHardwareAccelerationInfo(): Promise<HardwareAccelerationInfo> {
    if (!ffmpegPath) {
      return {
        cudaCompiled: false,
        cudaAvailable: false,
        details: "ffmpeg binary not found",
      };
    }

    try {
      const hwaccelsResult = await this.runProcess(ffmpegPath, [
        "-hide_banner",
        "-hwaccels",
      ]);
      const hwaccelOutput =
        `${hwaccelsResult.stdout}\n${hwaccelsResult.stderr}`.toLowerCase();
      const cudaCompiled = hwaccelOutput.includes("cuda");

      if (!cudaCompiled) {
        return {
          cudaCompiled: false,
          cudaAvailable: false,
          details: "ffmpeg does not report CUDA hwaccel support",
        };
      }

      const probeResult = await this.runProcess(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-hwaccel",
        "cuda",
        "-i",
        "color=c=black:s=16x16:d=0.1",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ]);

      if (probeResult.code === 0) {
        return {
          cudaCompiled: true,
          cudaAvailable: true,
          details: "CUDA hardware acceleration is available",
        };
      }

      const reason = (
        probeResult.stderr ||
        probeResult.stdout ||
        "unknown error"
      ).trim();
      return {
        cudaCompiled: true,
        cudaAvailable: false,
        details: `CUDA reported by ffmpeg but failed to initialize: ${reason}`,
      };
    } catch (error) {
      return {
        cudaCompiled: false,
        cudaAvailable: false,
        details: `Failed to probe CUDA support: ${String(error)}`,
      };
    }
  }

  async analyze(filePath: string): Promise<MediaAnalysis> {
    logger.info("Analyzing file:", filePath);
    return new Promise((resolve, reject) => {
      logger.info("Using ffprobe at:", ffprobePath);

      const process = spawn(ffprobePath, [
        "-v",
        "fatal",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ]);

      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (data) => (stdout += data));
      process.stderr.on("data", (data) => (stderr += data));

      process.on("error", (err) => {
        logger.error("Spawn error:", err);
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });

      process.on("close", (code) => {
        if (code !== 0) {
          logger.error("ffprobe stderr:", stderr);
          return reject(
            new Error(`ffprobe failed with code ${code}: ${stderr}`),
          );
        }

        try {
          const metadata = JSON.parse(stdout);

          const videoStream = metadata.streams.find(
            (s: { codec_type: string; codec_name: string }) =>
              s.codec_type === "video",
          );
          const audioStream = metadata.streams.find(
            (s: { codec_type: string; codec_name: string }) =>
              s.codec_type === "audio",
          );
          const subtitleStreams = metadata.streams.filter(
            (s: { codec_type: string }) => s.codec_type === "subtitle",
          );

          const videoCodec = videoStream?.codec_name || "unknown";
          const audioCodec = audioStream?.codec_name || "unknown";
          const formatName = metadata.format.format_name || "unknown";
          const duration = parseFloat(metadata.format.duration || "0");
          const width = Number(videoStream?.width || 0);
          const height = Number(videoStream?.height || 0);

          // Simple check for normalization need (h264 + aac is standard)
          const needsNormalization =
            videoCodec !== "h264" ||
            (audioCodec !== "aac" && audioCodec !== "mp3");

          const subtitles = subtitleStreams.map(
            (s: {
              index: number;
              codec_name: string;
              tags?: { language?: string; title?: string };
            }) => ({
              index: s.index,
              language: s.tags?.language || "und",
              codec: s.codec_name,
              title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            }),
          );

          resolve({
            needsNormalization,
            format: formatName,
            codecs: {
              video: videoCodec,
              audio: audioCodec,
            },
            video: {
              width,
              height,
            },
            subtitles,
            duration,
          });
        } catch (e: unknown) {
          reject(new Error(`Failed to parse ffprobe output: ${String(e)}`));
        }
      });
    });
  }

  async normalize(
    filePath: string,
    outputDir: string,
    progressCallback?: (percent: number) => void,
  ): Promise<string> {
    // Create a normalized filename
    const fileName = path.basename(filePath, path.extname(filePath));
    const outputPath = path.join(outputDir, `${fileName}_normalized.mp4`); // Using .mp4 container

    // First, get duration for progress calculation if callback is provided
    let duration = 0;
    if (progressCallback) {
      try {
        const analysis = await this.analyze(filePath);
        duration = analysis.duration;
      } catch (_e) {
        logger.warn("Could not determine duration for progress tracking");
      }
    }

    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        return reject(new Error("ffmpeg binary not found"));
      }

      // ffmpeg -i input -c:v libx264 -c:a aac -f mp4 output
      // -y to overwrite output if exists
      const args = [
        "-y",
        "-i",
        filePath,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-f",
        "mp4",
        outputPath,
      ];

      const process = spawn(ffmpegPath, args);

      let stderr = "";

      if (progressCallback && duration > 0) {
        process.stderr.on("data", (data) => {
          const chunk = data.toString();
          stderr += chunk; // collecting for error reporting

          // Parse time=HH:MM:SS.mm
          const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
          if (timeMatch) {
            const hours = parseFloat(timeMatch[1]);
            const minutes = parseFloat(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;

            const percent = Math.min(100, (totalSeconds / duration) * 100);
            progressCallback(percent);
          }
        });
      } else {
        process.stderr.on("data", (data) => {
          stderr += data;
        });
      }

      process.on("close", (code) => {
        if (code === 0) {
          if (progressCallback) progressCallback(100);
          resolve(outputPath);
        } else {
          console.error("FFmpeg error:", stderr);
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      process.on("error", (err) => {
        reject(err);
      });
    });
  }

  private normalizeEvenDimension(value: number): number {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  }

  private escapeFilterPath(filePath: string): string {
    return filePath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");
  }

  async segmentMedia(
    filePath: string,
    outputDir: string,
    options: SegmentMediaOptions,
    progressCallback?: (percent: number) => void,
  ): Promise<string> {
    let hardwareAccelerationInfo: HardwareAccelerationInfo | null = null;
    if (options.useHardwareAcceleration) {
      hardwareAccelerationInfo = await this.getHardwareAccelerationInfo();
      if (!hardwareAccelerationInfo.cudaAvailable) {
        throw new Error(
          `Hardware acceleration requested but CUDA is unavailable: ${hardwareAccelerationInfo.details}`,
        );
      }
    }

    const masterPlaylist = "master.m3u8";

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      await fs.promises.mkdir(outputDir, { recursive: true });
    }

    let duration = 0;
    let analysis: MediaAnalysis;

    try {
      analysis = await this.analyze(filePath);
      duration = analysis.duration;
    } catch (_e) {
      logger.warn("Could not determine duration or analyze media");
      throw new Error("Failed to analyze media before segmentation");
    }

    if (
      !options.reEncodeVideo &&
      (options.burnAssSubtitles || options.scaleVideo)
    ) {
      throw new Error(
        "Burning ASS subtitles and scaling require video re-encoding to be enabled.",
      );
    }

    const selectedBurnTrack =
      options.burnSubtitleStreamIndex === null
        ? null
        : analysis.subtitles.find(
            (sub) => sub.index === options.burnSubtitleStreamIndex,
          );

    if (options.burnAssSubtitles) {
      if (!selectedBurnTrack) {
        throw new Error("Selected ASS subtitle track is missing.");
      }

      if (!["ass", "ssa"].includes(selectedBurnTrack.codec.toLowerCase())) {
        throw new Error("Burn-in supports ASS/SSA tracks only.");
      }
    }

    const shouldScale = options.reEncodeVideo && options.scaleVideo;
    const requestedWidth = options.targetWidth ?? analysis.video.width;
    const requestedHeight = options.targetHeight ?? analysis.video.height;
    const scaledWidth = shouldScale
      ? this.normalizeEvenDimension(requestedWidth || 2)
      : null;
    const scaledHeight = shouldScale
      ? this.normalizeEvenDimension(requestedHeight || 2)
      : null;

    if (shouldScale && (!scaledWidth || !scaledHeight)) {
      throw new Error("Scaling requires target width and height.");
    }

    // 1. Prepare Subtitle Extraction (VTT sidecars only)
    const subtitleManifest: Array<{
      index: number;
      language: string;
      label: string;
      src: string;
      format: "vtt";
    }> = [];
    const sidecarArgs: string[] = [];

    // Analyze subtitles to extract
    for (const sub of analysis.subtitles) {
      if (isNaN(sub.index)) continue;
      if (["ass", "ssa"].includes(sub.codec.toLowerCase())) continue;

      const filename = `sub_${sub.index}_${sub.language}.vtt`;

      // Add to manifest
      subtitleManifest.push({
        index: sub.index,
        language: sub.language,
        label: sub.title,
        src: filename,
        format: "vtt",
      });

      // Add extraction command args
      sidecarArgs.push("-map", `0:${sub.index}`);
      sidecarArgs.push("-c:s", "webvtt");
      sidecarArgs.push(filename);
    }

    // Write manifest
    await fs.promises.writeFile(
      path.join(outputDir, "subtitles.json"),
      JSON.stringify(subtitleManifest, null, 2),
    );

    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        return reject(new Error("ffmpeg binary not found"));
      }

      const args = ["-y"];

      if (options.useHardwareAcceleration) {
        args.push("-hwaccel", "cuda");
      }

      args.push("-i", filePath);

      // Video and Audio mapping
      args.push("-map", "0:v:0", "-map", "0:a:0");

      if (options.reEncodeVideo) {
        const filters: string[] = [];

        if (shouldScale && scaledWidth && scaledHeight) {
          filters.push(`scale=${scaledWidth}:${scaledHeight}`);
        }

        if (options.burnAssSubtitles && selectedBurnTrack) {
          const subtitleTrackPosition = analysis.subtitles.findIndex(
            (sub) => sub.index === selectedBurnTrack.index,
          );
          if (subtitleTrackPosition < 0) {
            throw new Error(
              "Selected ASS subtitle track position could not be resolved.",
            );
          }

          const escapedPath = this.escapeFilterPath(filePath);
          filters.push(
            `subtitles='${escapedPath}':si=${subtitleTrackPosition}`,
          );
        }

        if (filters.length > 0) {
          args.push("-vf", filters.join(","));
        }

        args.push("-c:v", "libx264", "-crf", "23", "-preset", options.preset);
      } else {
        args.push("-c:v", "copy");
      }

      args.push("-c:a", "aac", "-b:a", "128k");

      // HLS Settings
      args.push(
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_list_size",
        "0",
      );

      // Check for a compatible subtitle track for HLS fallback (VLC support)
      const textSubtitleCodecs = ["subrip", "mov_text", "webvtt", "text"];
      const validHlsSubtitle = analysis.subtitles.find((s) =>
        textSubtitleCodecs.includes(s.codec),
      );

      // HLS Map logic
      if (validHlsSubtitle) {
        // Map the first compatible subtitle track for HLS embedding
        args.push("-map", `0:${validHlsSubtitle.index}`);
        args.push("-c:s", "webvtt");

        // Use sgroup to link the video variant to the subtitle group
        args.push("-master_pl_name", masterPlaylist);
        args.push("-var_stream_map", "v:0,a:0,s:0,sgroup:subs");
        args.push("stream_%v.m3u8");
      } else {
        // Simple output without subtitles in HLS
        args.push("-hls_segment_filename", "segment_%03d.ts");
        args.push(masterPlaylist);
      }

      args.push(...sidecarArgs);

      logger.info(`Spawning ffmpeg at: ${ffmpegPath}`);
      logger.info(`With cwd: ${outputDir}`);
      logger.info(`Args: ${args.join(" ")}`);

      const process = spawn(ffmpegPath, args, { cwd: outputDir });

      let stderr = "";

      process.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;

        if (progressCallback && duration > 0) {
          const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
          if (timeMatch) {
            const hours = parseFloat(timeMatch[1]);
            const minutes = parseFloat(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;

            const percent = Math.min(100, (totalSeconds / duration) * 100);
            progressCallback(percent);
          }
        }
      });

      process.on("close", (code) => {
        if (code === 0) {
          if (progressCallback) progressCallback(100);
          resolve(path.join(outputDir, masterPlaylist));
        } else {
          logger.error("FFmpeg error:", stderr);
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      process.on("error", (err) => {
        reject(err);
      });
    });
  }
}
