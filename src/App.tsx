import { HashRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import Home from "./routes/Home";
import About from "./routes/About";
import CreateWizard from "./routes/CreateWizard";
import Dashboard from "./routes/Dashboard";
import Player from "./routes/Player";
import UpdateNotification from "./components/UpdateNotification";

export default function App() {
  useEffect(() => {
    // Initialize theme
    const stored = localStorage.getItem("darkMode");
    // Check for "true" (legacy) or "black"
    const isDark = stored === "true" || stored === "black"; // "true" was old boolean string
    const theme = isDark ? "black" : "lofi";

    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  return (
    <HashRouter>
      <div className="font-sans text-base-content min-h-screen bg-base-200">
        <UpdateNotification />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/create" element={<CreateWizard />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/player" element={<Player />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
