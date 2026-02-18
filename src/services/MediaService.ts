import { spawn } from "child_process";
import { app } from "electron";
import { createRequire } from "module";
import * as path from "path";
import * as fs from "fs";

import logger from "../utilities/logging";

export interface MediaAnalysis {
  needsNormalization: boolean;
  format: string;
  codecs: {
    video: string;
    audio: string;
  };
  subtitles: {
    index: number;
    language: string;
    codec: string;
    title: string;
  }[];
  duration: number;
}

let ffmpegPath: string;
let ffprobePath: string;
if (app.isPackaged) {
  // In packaged app, binaries are in resources
  const resourcesPath = process.resourcesPath;
  const isWindows = process.platform === "win32";
  const exe = isWindows ? ".exe" : "";
  ffmpegPath = path.join(resourcesPath, `ffmpeg${exe}`);
  ffprobePath = path.join(resourcesPath, `ffprobe${exe}`);
} else {
  const requireFunc = createRequire(import.meta.url);
  ffmpegPath = requireFunc("ffmpeg-static");
  ffprobePath = requireFunc("ffprobe-static").path;
}

export class MediaService {
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

  async segmentMedia(
    filePath: string,
    outputDir: string,
    reEncode = true,
    progressCallback?: (percent: number) => void,
  ): Promise<string> {
    // The master playlist name
    const masterPlaylist = "master.m3u8";

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      await fs.promises.mkdir(outputDir, { recursive: true });
    }

    let duration: number;
    let hasSubtitles = false;
    let subtitleIndexToMap = -1;

    try {
      const analysis = await this.analyze(filePath);
      duration = analysis.duration;
      // Only consider text-based subtitles for HLS WebVTT conversion
      // Image-based subtitles (PGS, VobSub) cannot be easily converted to WebVTT by FFmpeg and will cause errors
      const textSubtitleCodecs = ["subrip", "ass", "ssa", "mov_text", "webvtt", "text"];
      const validSubtitle = analysis.subtitles.find(s => textSubtitleCodecs.includes(s.codec));
      if (validSubtitle) {
        hasSubtitles = true;
        subtitleIndexToMap = validSubtitle.index;
      }
    } catch (_e) {
      logger.warn("Could not determine duration or analyze media");
      duration = 0;
    }

    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        return reject(new Error("ffmpeg binary not found"));
      }

      const args = ["-y", "-i", filePath];

      // Video and Audio mapping
      args.push("-map", "0:v:0", "-map", "0:a:0");

      if (hasSubtitles && subtitleIndexToMap >= 0) {
        // Map only the first compatible text-based subtitle track
        args.push("-map", `0:${subtitleIndexToMap}`);
      }

      // Codecs
      if (reEncode) {
        args.push("-c:v", "libx264", "-crf", "23", "-preset", "veryfast");
      } else {
        args.push("-c:v", "copy");
      }

      args.push("-c:a", "aac", "-b:a", "128k");

      if (hasSubtitles) {
        args.push("-c:s", "webvtt");
      }

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

      // If subtitles exist, we use master playlist structure
      if (hasSubtitles) {
        args.push("-master_pl_name", masterPlaylist);
        // Use sgroup to link the video variant to the subtitle group
        // We include s:0 in the same variant group to ensure ffmpeg handles it correctly as a WebVTT stream associated with this variant
        args.push("-var_stream_map", "v:0,a:0,s:0,sgroup:subs");
        
      // Output variant playlists
      // Important: this MUST be the last argument for the hls muxer output filename pattern
      // Because we use var_stream_map, we emit multiple playlists using the pattern.
      args.push("stream_%v.m3u8");
      } else {

        // Simple output
        args.push("-hls_segment_filename", "segment_%03d.ts");
        // If no subtitles, just output directly to masterPlaylist file
        // This will be a simple media playlist (segments only)
        args.push(masterPlaylist);
      }

      logger.info(`Spawning ffmpeg at: ${ffmpegPath}`);
      logger.info(`With cwd: ${outputDir}`);
      logger.info(`Args: ${args.join(" ")}`);

      const process = spawn(ffmpegPath, args, { cwd: outputDir });

      let stderr = "";

      // Capture all stderr for debugging purposes, not just progress
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
