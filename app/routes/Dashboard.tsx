import { useEffect, useState, useRef, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";

export default function Dashboard() {
  const [searchParams] = useSearchParams();
  const magnet = searchParams.get("magnet");
  const isHost = searchParams.get("host") === "true";
  const initRef = useRef(false);
  const [copied, setCopied] = useState(false);

  const [stats, setStats] = useState({
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    peerProgress: {} as Record<string, number>,
  });

  const [isReady, setIsReady] = useState(isHost);

  useEffect(() => {
    if (!initRef.current && magnet && !isHost) {
      initRef.current = true;
      window.electronAPI.addTorrent(magnet);
    }

    if (isHost) {
      setStats((prev) => ({ ...prev, progress: 1 }));
    }

    const cleanup = window.electronAPI.onTorrentProgress((data) => {
      setStats((prev) => ({ ...prev, ...data }));
      window.electronAPI.broadcastCommand({
        type: "progress",
        payload: { percent: data.progress },
        timestamp: Date.now(),
      });
      if (data.progress > 0 || isHost) {
        setIsReady(true);
      }
    });

    const cleanupDone = window.electronAPI.onTorrentDone(() => {
      setStats((prev) => ({ ...prev, progress: 1 }));
      window.electronAPI.broadcastCommand({
        type: "progress",
        payload: { percent: 1 },
        timestamp: Date.now(),
      });
      setIsReady(true);
    });

    const cleanupSync = window.electronAPI.onSyncCommand((cmd) => {
      if (cmd.type === "start-room") {
        window.electronAPI.openPlayerWindow();
      }
    });

    return () => {
      cleanup();
      cleanupDone();
      cleanupSync();
    };
  }, [magnet, isHost]);

  const startParty = async () => {
    const cmd = { type: "start-room", timestamp: Date.now() };
    await window.electronAPI.broadcastCommand(cmd);
    window.electronAPI.openPlayerWindow();
  };

  const copyMagnet = () => {
    if (magnet) {
      navigator.clipboard.writeText(magnet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-base-200 font-sans p-8 flex flex-col items-center">
      <header className="w-full max-w-4xl flex flex-col md:flex-row justify-between items-center mb-12 gap-4">
        <h1 className="text-4xl font-black uppercase text-base-content tracking-tight text-center md:text-left">
          {isHost ? "Hosting Party" : "Connected to Room"}
        </h1>
        <div className="badge badge-lg badge-neutral gap-2 p-4 h-10">
          <div
            className={`badge badge-xs ${stats.numPeers > 0 ? "badge-success animate-pulse" : "badge-error"}`}
          ></div>
          <span className="font-bold">{stats.numPeers} PEERS</span>
        </div>
      </header>

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
        {/* Stats Card */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title text-xl font-black mb-6 text-primary">
              YOUR STATUS
            </h2>

            <div className="mb-6">
              <div className="flex justify-between text-sm font-bold mb-2">
                <span>DOWNLOAD PROGRESS</span>
                <span>{Math.round(stats.progress * 100)}%</span>
              </div>
              <progress
                className="progress progress-primary w-full h-4"
                value={Math.round(stats.progress * 100)}
                max="100"
              ></progress>
            </div>

            <div className="stats shadow w-full bg-base-200">
              <div className="stat p-4">
                <div className="stat-title text-xs font-bold opacity-60">
                  DOWN SPEED
                </div>
                <div className="stat-value text-lg font-mono">
                  {(stats.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s
                </div>
              </div>
              <div className="stat p-4">
                <div className="stat-title text-xs font-bold opacity-60">
                  UP SPEED
                </div>
                <div className="stat-value text-lg font-mono">
                  {(stats.uploadSpeed / 1024 / 1024).toFixed(2)} MB/s
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Peers Card */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title text-xl font-black mb-6 text-secondary">
              FRIEND STATUS
            </h2>

            {Object.keys(stats.peerProgress || {}).length === 0 ? (
              <div className="h-32 flex items-center justify-center text-base-content/40 font-bold italic border-2 border-dashed border-base-200 rounded-box">
                WAITING FOR FRIENDS...
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                {Object.entries(stats.peerProgress || {}).map(
                  ([peerId, percent]) => (
                    <div key={peerId} className="flex flex-col items-center">
                      <div
                        className="radial-progress text-secondary font-extrabold text-sm bg-base-200 border-4 border-base-200 mb-2"
                        style={
                          {
                            "--value": Math.round(
                              (typeof percent === "number" ? percent : 0) * 100,
                            ),
                            "--size": "4rem",
                          } as CSSProperties
                        }
                      >
                        {Math.round(
                          (typeof percent === "number" ? percent : 0) * 100,
                        )}
                        %
                      </div>
                      <div className="badge badge-neutral badge-sm font-mono truncate max-w-full">
                        {peerId.substring(0, 6)}..
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Magnet Link */}
      <div className="w-full max-w-4xl mb-12">
        <div className="card bg-accent text-accent-content shadow-xl">
          <div className="card-body flex-row items-center gap-4 p-4">
            <div className="hidden md:block font-black text-xl transform origin-center whitespace-nowrap opacity-60">
              INVITE
            </div>
            <div className="flex-1">
              <input
                readOnly
                value={magnet || ""}
                className="input w-full bg-base-100 text-base-content font-mono text-sm"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
            </div>
            <div className="indicator">
              {copied && (
                <span className="indicator-item badge badge-primary font-bold">
                  Copied!
                </span>
              )}
              <button
                onClick={copyMagnet}
                className="btn bg-base-100 border-none hover:bg-white/90 text-base-content font-bold"
              >
                COPY
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Action Area */}
      <div className="w-full max-w-xl text-center">
        {isHost ? (
          <button
            onClick={startParty}
            disabled={!isReady}
            className="btn btn-secondary btn-lg w-full h-auto py-6 text-2xl font-black shadow-xl"
          >
            START WATCH PARTY <i className="fa-solid fa-rocket ml-2"></i>
          </button>
        ) : (
          <div className="card bg-neutral text-neutral-content shadow-xl border-t-4 border-primary">
            <div className="card-body items-center text-center">
              {isReady ? (
                <div>
                  <div className="loading loading-ring loading-lg mb-4 text-primary"></div>
                  <h2 className="text-2xl font-black mb-2 uppercase tracking-tight">
                    Waiting for Host...
                  </h2>
                  <p className="font-bold mb-6 opacity-80">
                    The video will launch automatically!
                  </p>

                  <button
                    onClick={() => window.electronAPI.openPlayerWindow()}
                    className="btn btn-outline btn-primary btn-sm"
                  >
                    FORCE JOIN NOW
                  </button>
                </div>
              ) : (
                <div className="text-xl font-bold italic opacity-50 flex flex-col items-center gap-4">
                  <span className="loading loading-dots loading-lg"></span>
                  SYNCHRONIZING METADATA...
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
