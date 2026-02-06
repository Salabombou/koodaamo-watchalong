import { useState } from "react";
import { useNavigate } from "react-router-dom";

const STEPS = [
  { title: "Select File", description: "Choose video file" },
  { title: "Analysis", description: "Check codecs" },
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
  const [normalizing, setNormalizing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const canContinue = () => {
    if (step === 0) return !!filePath;
    if (step === 1) return analysis && !analyzing;
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

  const handleNormalize = async () => {
    if (!filePath) return;
    setNormalizing(true);
    setProgress(0);

    const cleanup = window.electronAPI.onMediaProgress((p) => {
      setProgress(p);
    });

    try {
      const newPath = await window.electronAPI.normalizeMedia(filePath);
      setFilePath(newPath);
      setAnalysis((prev) =>
        prev ? { ...prev, needsNormalization: false } : null,
      );
    } catch (e) {
      console.error(e);
      alert("Normalization failed");
    } finally {
      cleanup();
      setNormalizing(false);
    }
  };

  const handleCreate = async () => {
    if (!filePath) return;
    setCreating(true);
    try {
      const importedPath = await window.electronAPI.importFile(filePath);
      const magnet = await window.electronAPI.seedTorrent(importedPath, []);
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
                            This video format might not play in all browsers.
                          </div>
                        </div>
                        <div className="flex-none">
                          {normalizing ? (
                            <div className="flex flex-col gap-1 w-32">
                              <span className="text-xs font-bold text-center">
                                {Math.round(progress)}%
                              </span>
                              <progress
                                className="progress progress-neutral w-full"
                                value={progress}
                                max="100"
                              ></progress>
                            </div>
                          ) : (
                            <button
                              onClick={handleNormalize}
                              className="btn btn-sm btn-neutral"
                            >
                              FIX NOW
                            </button>
                          )}
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
                          File is ready for streaming!
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            {/* Step 3: Launch */}
            {step === 2 && (
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
                    <div className="mb-2">
                      <span className="font-bold text-base-content/60">
                        FILE:
                      </span>{" "}
                      {filePath.split(/[/\\]/).pop()}
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

          {step === 2 ? (
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
