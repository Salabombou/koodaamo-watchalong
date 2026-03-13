import { HashRouter, Routes, Route } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import UpdateNotification from "@components/UpdateNotification";

const Home = lazy(() => import("@routes/Home"));
const About = lazy(() => import("@routes/About"));
const CreateWizard = lazy(() => import("@routes/CreateWizard"));
const Dashboard = lazy(() => import("@routes/Dashboard"));
const Player = lazy(() => import("@routes/Player"));

export default function App() {
  useEffect(() => {
    const cleanup = window.electronAPI.onInviteOpened((inviteUrl) => {
      window.location.hash = `#/dashboard?invite=${encodeURIComponent(inviteUrl)}`;
    });

    return cleanup;
  }, []);

  useEffect(() => {
    const storedTheme = localStorage.getItem("theme");

    let theme = "lofi";
    if (storedTheme === "lofi" || storedTheme === "lofi-inverted") {
      theme = storedTheme;
    }

    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  return (
    <HashRouter>
      <UpdateNotification />
      <div className="font-sans text-base-content min-h-screen bg-base-200">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/create" element={<CreateWizard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/player" element={<Player />} />
          </Routes>
        </Suspense>
      </div>
    </HashRouter>
  );
}
