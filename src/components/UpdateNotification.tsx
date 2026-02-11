import React, { useEffect, useState } from "react";

const UpdateNotification = () => {
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "available" | "downloading" | "ready" | "error"
  >("idle");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [downloadProgress, setDownloadProgress] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unsubAvailable = window.electronAPI.onUpdateAvailable(() => {
      setUpdateStatus("available");
    });

    const unsubProgress = window.electronAPI.onUpdateProgress((progress) => {
      setUpdateStatus("downloading");
      setDownloadProgress(progress);
    });

    const unsubDownloaded = window.electronAPI.onUpdateDownloaded(() => {
      setUpdateStatus("ready");
    });

    const unsubError = window.electronAPI.onUpdateError((err) => {
      setUpdateStatus("error");
      setErrorMessage(err);
      // Auto-dismiss error after 5 seconds
      setTimeout(() => setUpdateStatus("idle"), 5000);
    });

    return () => {
      unsubAvailable();
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  const handleRestart = () => {
    window.electronAPI.restartApp();
  };

  if (updateStatus === "idle") return null;

  return (
    <div className="toast toast-bottom toast-end z-50">
      {/* Update Available / Downloading */}
      {(updateStatus === "available" || updateStatus === "downloading") && (
        <div className="alert alert-info shadow-lg">
          <div>
            <i className="fas fa-cloud-download-alt text-2xl"></i>
            <div>
              <h3 className="font-bold">Update Available</h3>
              <div className="text-xs">
                {updateStatus === "downloading" && downloadProgress
                  ? `Downloading... ${Math.round(downloadProgress.percent)}%`
                  : "Preparing download..."}
              </div>
            </div>
          </div>
          {updateStatus === "downloading" && downloadProgress && (
            <div className="w-full mt-2">
              <progress
                className="progress progress-primary w-56"
                value={downloadProgress.percent}
                max="100"
              ></progress>
            </div>
          )}
        </div>
      )}

      {/* Update Ready */}
      {updateStatus === "ready" && (
        <div className="alert alert-success shadow-lg">
          <div>
            <i className="fas fa-check-circle text-2xl"></i>
            <div>
              <h3 className="font-bold">Update Ready!</h3>
              <div className="text-xs">Restart to apply changes.</div>
            </div>
          </div>
          <div className="flex-none">
            <button
              onClick={handleRestart}
              className="btn btn-sm btn-ghost border border-white"
            >
              Restart Now
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {updateStatus === "error" && (
        <div className="alert alert-error shadow-lg">
          <div>
            <i className="fas fa-exclamation-triangle"></i>
            <span>Error: {errorMessage}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default UpdateNotification;
