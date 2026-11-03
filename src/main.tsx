import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { selectAdapter } from "./adapter/selectAdapter";
import "./design-system/tokens.css";

const adapter = selectAdapter(import.meta.env, window.location.search);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App adapter={adapter} />
  </StrictMode>,
);
