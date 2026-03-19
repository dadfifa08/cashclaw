import "./index.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { LiveProvider } from "./lib/live.js";

createRoot(document.getElementById("root")!).render(
  <LiveProvider>
    <App />
  </LiveProvider>,
);
