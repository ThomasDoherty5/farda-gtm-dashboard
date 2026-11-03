import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { selectAdapter } from "./adapter/selectAdapter";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "./design-system/tokens.css";

const adapter = selectAdapter(import.meta.env, window.location.search);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App adapter={adapter} />
  </StrictMode>,
);
