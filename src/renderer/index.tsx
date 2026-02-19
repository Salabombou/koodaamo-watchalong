import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "@fontsource/space-grotesk";
import "./index.css";
import "@fortawesome/fontawesome-free/css/fontawesome.css";
import "@fortawesome/fontawesome-free/css/solid.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
