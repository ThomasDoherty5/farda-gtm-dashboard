import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { httpTransportFactory } from "./adapter/httpTransport";
import { loadSessionScope } from "./adapter/sessionScope";
import { selectAdapter } from "./adapter/selectAdapter";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "./design-system/tokens.css";

const adapter = selectAdapter(import.meta.env, window.location.search, { createTransport: httpTransportFactory });
async function start() {
  let session = null;
  if (adapter.environment !== "demo" && import.meta.env.VITE_FARDA_ADAPTER_BASE_URL) {
    try { session = await loadSessionScope(import.meta.env.VITE_FARDA_ADAPTER_BASE_URL, adapter.environment); }
    catch { /* The existing live adapter renders denied/unavailable; no fixture scope or data is substituted. */ }
  }
  createRoot(document.getElementById("root")!).render(<StrictMode><App adapter={adapter} session={session} /></StrictMode>);
}
void start();
