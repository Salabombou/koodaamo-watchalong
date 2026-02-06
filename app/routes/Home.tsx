import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

export default function Home() {
  const [magnet, setMagnet] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Initialize state based on current theme for UI sync
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem("darkMode");
    return stored === "true" || stored === "black";
  });

  const navigate = useNavigate();

  const isValidMagnet = (url: string) => {
    return /^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}.*$/.test(url);
  };

  const handleJoin = () => {
    if (isValidMagnet(magnet)) {
      navigate(`/dashboard?magnet=${encodeURIComponent(magnet)}`);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setMagnet(text);
      setIsDirty(true);
    } catch (err) {
      console.error("Failed to read clipboard", err);
    }
  };

  const toggleDarkMode = () => {
    const newVal = !darkMode;
    setDarkMode(newVal);
    const theme = newVal ? "black" : "lofi";
    localStorage.setItem("darkMode", theme); // Store 'black' or 'light' ideally, but consistent w/ App logic
    document.documentElement.setAttribute("data-theme", theme);
  };

  const handleMagnetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMagnet(e.target.value);
    setIsDirty(true);
  };

  const valid = isValidMagnet(magnet);
  const showError = isDirty && magnet.length > 0 && !valid;

  return (
    <div className="hero min-h-screen bg-base-200 relative overflow-hidden transition-colors duration-300">
      <button
        className="absolute top-6 right-6 btn btn-circle btn-ghost z-10 hover:bg-transparent border-0 hover:animate-spin"
        onClick={() => setShowSettings(true)}
      >
        <i className="fa-solid fa-gear text-3xl"></i>
      </button>

      <div className="hero-content text-center flex-col z-10">
        <div className="mb-8 bg-neutral p-4 text-neutral-content select-none">
          <h1 className="text-6xl md:text-8xl font-black">KOODAAMO</h1>
          <h1 className="text-6xl md:text-8xl font-black">WATCHALONG</h1>
        </div>

        <div className="card w-full max-w-md bg-base-100 shadow-xl">
          <div className="card-body">
            <div className="mb-2">
              <Link
                to="/create"
                className="btn btn-primary btn-lg w-full text-xl font-bold"
              >
                CREATE NEW ROOM
              </Link>
            </div>

            <div className="divider font-black opacity-50">OR JOIN</div>

            <div className="form-control w-full">
              <label className="label">
                <span className="label-text font-bold uppercase">
                  Magnet Link
                </span>
              </label>
              <div className="join w-full">
                <input
                  value={magnet}
                  onChange={handleMagnetChange}
                  placeholder="magnet:?xt=urn:..."
                  className={`input input-bordered join-item w-full font-mono text-sm ${showError ? "input-error" : ""}`}
                />
                <button
                  onClick={handlePaste}
                  title="Paste from clipboard"
                  className="btn btn-accent join-item text-xl"
                >
                  <i className="fa-solid fa-paste"></i>
                </button>
              </div>
              {showError && (
                <label className="label">
                  <span className="label-text-alt text-error font-bold">
                    Invalid magnet link format
                  </span>
                </label>
              )}
              {!showError && <div className="mb-4"></div>}

              <button
                onClick={handleJoin}
                disabled={!valid}
                className="btn btn-neutral w-full font-bold"
              >
                JOIN ROOM
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal modal-open">
          <div className="modal-box relative">
            <button
              onClick={() => setShowSettings(false)}
              className="btn btn-sm btn-circle absolute right-2 top-2"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
            <h3 className="font-bold text-lg mb-6 border-b pb-2">SETTINGS</h3>

            <div className="space-y-6">
              <div className="alert shadow-lg bg-base-200">
                <div>
                  <h3 className="font-bold">About</h3>
                  <div className="text-xs">Koodaamo Watchalong v1.0</div>
                  <div className="text-xs font-mono opacity-70">
                    Open Source P2P Streaming
                  </div>
                </div>
              </div>

              <div className="form-control">
                <label className="label cursor-pointer">
                  <span className="label-text font-bold uppercase">
                    Dark Mode
                  </span>
                  <input
                    type="checkbox"
                    className="toggle toggle-secondary"
                    checked={darkMode}
                    onChange={toggleDarkMode}
                  />
                </label>
              </div>
            </div>
          </div>
          <div
            className="modal-backdrop"
            onClick={() => setShowSettings(false)}
          ></div>
        </div>
      )}
    </div>
  );
}
