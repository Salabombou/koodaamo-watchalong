import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import path from "path";

export interface MediaAnalysis {
  needsNormalization: boolean;
  format: string;
  codecs: {
    video: string;
    audio: string;
  };
  duration: number;
}

export class MediaService {
  async analyze(filePath: string): Promise<MediaAnalysis> {
    console.log("Analyzing file:", filePath);
    return new Promise((resolve, reject) => {
      if (!ffprobePath || !ffprobePath.path) {
        return reject(new Error("ffprobe binary not found"));
      }

      // Fix for ASAR path if necessary (though usually handled by externalizing)
      const binPath = ffprobePath.path.replace("app.asar", "app.asar.unpacked");
      console.log("Using ffprobe at:", binPath);

      const process = spawn(binPath, [
        // '-v', 'quiet', // Commented out to see errors
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
        console.error("Spawn error:", err);
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });

      process.on("close", (code) => {
        if (code !== 0) {
          console.error("ffprobe stderr:", stderr);
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

          const videoCodec = videoStream?.codec_name || "unknown";
          const audioCodec = audioStream?.codec_name || "unknown";
          const formatName = metadata.format.format_name || "unknown";
          const duration = parseFloat(metadata.format.duration || "0");

          // Simple check for normalization need (h264 + aac is standard)
          const needsNormalization =
            videoCodec !== "h264" ||
            (audioCodec !== "aac" && audioCodec !== "mp3");

          resolve({
            needsNormalization,
            format: formatName,
            codecs: {
              video: videoCodec,
              audio: audioCodec,
            },
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
        console.warn("Could not determine duration for progress tracking");
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
}
