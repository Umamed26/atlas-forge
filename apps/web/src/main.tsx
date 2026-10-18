import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadRenderFonts } from "./lib/fonts";
import "./styles.css";

// Register the bundled EB Garamond with the document before the first render so
// the preview map typography matches the server-side 4096² export.
void loadRenderFonts();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
