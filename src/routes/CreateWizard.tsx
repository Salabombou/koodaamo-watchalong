import { useState } from "react";
import { useNavigate } from "react-router-dom";

const STEPS = [
  { title: "Select File", description: "Choose video file" },
  { title: "Analysis", description: "Check codecs" },
  { title: "Preparing", description: "Create HLS stream" },
  { title: "Launch", description: "Start room" },
];

interface MediaAnalysis {
  needsNormalization: boolean;
  format: string;
  codecs: {
    video: string;
    audio: string;
  };
  duration: number;
}

export default function CreateWizard() {
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [filePath, setFilePath] = useState<string>("");
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
  const [segmenting, setSegmenting] = useState(false);
  const [segmentedPath, setSegmentedPath] = useState<string>("");
  const [reEncode, setReEncode] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [creating, setCreating] = useState(false);
  const [trackerType, setTrackerType] = useState<
    "lan" | "localtunnel" | "untun"
  >("localtunnel");
  const navigate = useNavigate();

  const canContinue = () => {
    if (step === 0) return !!filePath;
    if (step === 1) return analysis && !analyzing;
    if (step === 2) return !!segmentedPath && !segmenting;
    return true;
  };

  const nextStep = () => {
    if (canContinue()) {
      setStep((s) => {
        const next = Math.min(s + 1, STEPS.length - 1);
        setMaxStep((ms) => Math.max(ms, next));
        return next;
      });
    }
  };
  const prevStep = () => {
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      const path = window.electronAPI.getFilePath(selectedFile);
      setFilePath(path);

      setAnalyzing(true);
      if (step === 0) {
        setStep(1); // Auto advance to analysis view
        setMaxStep(1); // Reset max progress since file changed
      }

      try {
        const result = await window.electronAPI.analyzeMedia(path);
        setAnalysis(result);
      } catch (error) {
        console.error("Analysis failed", error);
        alert("Failed to analyze video file.");
      } finally {
        setAnalyzing(false);
      }
    }
  };

  const handleSegmentation = async () => {
    if (!filePath) return;
    setSegmenting(true);
    setProgress(0);

    const cleanup = window.electronAPI.onMediaProgress((p) => {
      setProgress(p);
    });

    try {
      const resultPath = await window.electronAPI.segmentMedia(
        filePath,
        reEncode,
      );
      setSegmentedPath(resultPath);
      nextStep(); // Auto advance to launch step
      setMaxStep(3);
    } catch (e) {
      console.error(e);
      alert("Segmentation failed");
    } finally {
      cleanup();
      setSegmenting(false);
    }
  };

  const handleCreate = async () => {
    if (!segmentedPath) return;
    setCreating(true);
    try {
      // For HLS, we seed the folder containing the m3u8 and ts files.
      // The segmentedPath points to the .m3u8 file.
      // We rely on the backend to handle the seeding of the folder if we pass the m3u8 path, or we pass the folder.
      // However, `webtorrent` usually takes a folder path to seed a folder.
      // Let's assume on the backend, if `segmentMedia` was used, the path is already in the right place.
      // BUT `seedTorrent` in `TorrentService` just calls `client.seed(filePath)`.
      // If we pass `.../video.m3u8`, it seeds just that file.
      // We need to pass the directory.
      // Since we can't do path manipulation easily here, the `segmentMedia` returns the playlist path.
      // Let's modify `TorrentService` to handle this or modify `handleSegmentation` return value?
      // Actually, if we pass a directory to `client.seed`, it seeds the directory.
      // I'll update `seedTorrent` in the backend to check if it's an .m3u8 file inside a folder and seed the folder?
      // Or easier: I'll hack it here by not changing backend too much if I can avoid it.
      // But verify: `window.electronAPI.seedTorrent` takes a string.

      // Let's modify `seedTorrent` in `TorrentService` to detect if the path is an m3u8 and seed its parent dir?
      // No, that's implicit magic.
      // Better: Update `MediaService` to return the FOLDER path?
      // Or update `CreateWizard` to ask backend to seed the folder.
      // I'll assume for now `segmentedPath` is the m3u8 file.
      // I need to change `TorrentService.seed` to handle this case:
      // if path ends in .m3u8, seed path.dirname(path).

      const magnet = await window.electronAPI.seedTorrent(
        segmentedPath,
        trackerType,
      );
      navigate(`/dashboard?magnet=${encodeURIComponent(magnet)}&host=true`);
    } catch (e) {
      console.error(e);
      alert("Failed to create room");
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-base-200 font-sans">
      {/* Sidebar */}
      <div className="w-80 bg-neutral text-neutral-content p-8 flex flex-col justify-between">
        <div>
          <h1 className="text-3xl font-black mb-12 text-neutral-content tracking-tighter">
            SETUP WIZARD
          </h1>
          <ul className="steps steps-vertical w-full">
            {STEPS.map((s, i) => (
              <li
                key={i}
                className={`step ${i <= step ? "step-primary" : ""} cursor-pointer text-left`}
                onClick={() => (i <= maxStep ? setStep(i) : null)}
              >
                <div className="flex flex-col items-start ml-2 opacity-90">
                  <span className="font-bold uppercase text-sm">{s.title}</span>
                  <span className="text-xs opacity-60 font-mono hidden md:inline">
                    {s.description}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={() => navigate("/")}
          className="btn btn-ghost btn-outline btn-error btn-sm w-full gap-2"
        >
          ← CANCEL & EXIT
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-8 md:p-12 flex flex-col relative h-screen">
        <div className="flex-1 card bg-base-100 shadow-xl overflow-y-auto relative flex flex-col mb-8">
          <div className="card-body">
            {/* Step 1: File Selection */}
            {step === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <h2 className="card-title text-3xl font-black mb-8 uppercase">
                  Drop Video File
                </h2>
                <label className="h-full cursor-pointer w-full border-4 border-dashed border-base-300 rounded-box hover:bg-base-200 transition-colors flex flex-col items-center justify-center gap-4">
                  <i className="fa-solid fa-folder-open text-6xl"></i>
                  <span className="font-bold text-xl">
                    Click to browse or drag file here
                  </span>
                  <input
                    type="file"
                    onChange={handleFileChange}
                    className="hidden"
                    accept="video/*,.mkv"
                  />
                </label>
              </div>
            )}

            {/* Step 2: Analysis */}
            {step === 1 && (
              <div className="w-full">
                <h2 className="text-3xl font-black mb-6 uppercase border-b-4 border-base-content/10 inline-block pb-2">
                  Analysis
                </h2>
                {analyzing ? (
                  <div className="flex flex-col items-center py-12 gap-4">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                    <span className="font-bold text-xl">
                      SCANNING CODECS...
                    </span>
                  </div>
                ) : analysis ? (
                  <div className="space-y-6">
                    <div className="stats shadow w-full">
                      <div className="stat">
                        <div className="stat-title font-bold">Video Codec</div>
                        <div className="stat-value text-2xl font-mono">
                          {analysis.codecs.video}
                        </div>
                      </div>
                      <div className="stat">
                        <div className="stat-title font-bold">Audio Codec</div>
                        <div className="stat-value text-2xl font-mono">
                          {analysis.codecs.audio}
                        </div>
                      </div>
                    </div>

                    {analysis.needsNormalization ? (
                      <div className="alert alert-warning shadow-lg">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="stroke-current shrink-0 h-6 w-6"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div>
                          <h3 className="font-bold">Conversion Required</h3>
                          <div className="text-xs">
                            Format requires processing. Click Continue to
                            proceed to segmentation.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="alert alert-success shadow-lg">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="stroke-current shrink-0 h-6 w-6"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <span className="font-bold">
                          Analysis Complete. Ready for HLS Segmentation.
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
            {/* Step 2: Segmentation */}
            {step === 2 && (
              <div className="w-full">
                <h2 className="text-3xl font-black mb-6 uppercase border-b-4 border-base-content/10 inline-block pb-2">
                  Create Stream
                </h2>
                <div className="space-y-6">
                  <div className="form-control">
                    <label className="label cursor-pointer justify-start gap-4">
                      <span className="label-text text-lg font-bold">
                        Re-encode Video (Recommended)
                      </span>
                      <input
                        type="checkbox"
                        className="toggle toggle-primary"
                        checked={reEncode}
                        onChange={(e) => setReEncode(e.target.checked)}
                        disabled={segmenting || !!segmentedPath}
                      />
                    </label>
                    <div className="text-xs opacity-70 ml-2">
                      Disable this only if you know the video is already H.264
                      compatible. Re-encoding ensures compatibility but takes
                      longer.
                    </div>
                  </div>

                  {segmenting ? (
                    <div className="flex flex-col gap-2 w-full">
                      <div className="flex justify-between font-bold">
                        <span>PROCESSING...</span>
                        <span>{Math.round(progress)}%</span>
                      </div>
                      <progress
                        className="progress progress-primary w-full h-4"
                        value={progress}
                        max="100"
                      ></progress>
                    </div>
                  ) : segmentedPath ? (
                    <div className="alert alert-success shadow-lg">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="stroke-current shrink-0 h-6 w-6"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <div>
                        <h3 className="font-bold">Stream Ready!</h3>
                        <div className="text-xs">
                          Files are segmented and playlist created.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={handleSegmentation}
                      className="btn btn-primary btn-lg w-full"
                    >
                      START SEGMENTATION
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Step 3: Launch */}
            {step === 3 && (
              <div className="h-full flex flex-col justify-center items-center text-center">
                <h2 className="text-4xl font-black mb-4 text-primary">
                  READY TO LAUNCH?
                </h2>
                <p className="font-bold mb-8 max-w-md opacity-70">
                  By clicking continue, you will start hosting. Keep this app
                  open to seed the content!
                </p>

                <div className="card w-full max-w-md bg-base-200 shadow-inner">
                  <div className="card-body p-6 text-left font-mono text-sm">
                    <div className="mb-4">
                      <span className="font-bold text-base-content/60 block mb-1">
                        FILE:
                      </span>
                      <span className="break-all">
                        {filePath.split(/[/\\]/).pop()}
                      </span>
                    </div>

                    <div className="divider my-2"></div>

                    <div className="form-control">
                      <span className="font-bold text-base-content/60 block mb-2">
                        CONNECTION TYPE:
                      </span>

                      <label className="label cursor-pointer justify-start gap-3 p-2 hover:bg-base-100 rounded-lg transition-colors">
                        <input
                          type="radio"
                          name="tracker"
                          className="radio radio-sm radio-primary"
                          checked={trackerType === "lan"}
                          onChange={() => setTrackerType("lan")}
                        />
                        <div className="flex flex-col">
                          <span className="font-bold">Local Network</span>
                          <span className="text-xs opacity-60">
                            LAN only (Fastest)
                          </span>
                        </div>
                      </label>

                      <label className="label cursor-pointer justify-start gap-3 p-2 hover:bg-base-100 rounded-lg transition-colors">
                        <input
                          type="radio"
                          name="tracker"
                          className="radio radio-sm radio-primary"
                          checked={trackerType === "localtunnel"}
                          onChange={() => setTrackerType("localtunnel")}
                        />
                        <div className="flex flex-col">
                          <span className="font-bold">Localtunnel</span>
                          <span className="text-xs opacity-60">
                            Public Internet (Default)
                          </span>
                        </div>
                      </label>

                      <label className="label cursor-pointer justify-start gap-3 p-2 hover:bg-base-100 rounded-lg transition-colors">
                        <input
                          type="radio"
                          name="tracker"
                          className="radio radio-sm radio-primary"
                          checked={trackerType === "untun"}
                          onChange={() => setTrackerType("untun")}
                        />
                        <div className="flex flex-col">
                          <span className="font-bold">Cloudflare Tunnel</span>
                          <span className="text-xs opacity-60">
                            Public Internet (Alternative)
                          </span>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex justify-between items-center">
          <button
            onClick={prevStep}
            disabled={step === 0}
            className="btn btn-neutral"
          >
            BACK
          </button>

          {step === 3 ? (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="btn btn-secondary btn-lg shadow-lg"
            >
              {creating ? (
                <>
                  <span className="loading loading-spinner"></span>
                  STARTING...
                </>
              ) : (
                <>
                  START PARTY <i className="fa-solid fa-rocket ml-2"></i>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={nextStep}
              disabled={!canContinue()}
              className="btn btn-primary px-8"
            >
              CONTINUE
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
