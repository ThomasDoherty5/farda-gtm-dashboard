/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_FARDA_ADAPTER?: "demo" | "sandbox" | "production";
  readonly VITE_FARDA_ADAPTER_BASE_URL?: string;
}
