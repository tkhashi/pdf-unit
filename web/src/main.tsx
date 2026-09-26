import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { AppControllerContext } from "./app/app-context";
import { createAppController } from "./controllers/app-controller";
import { pick } from "./domain/spatial-index";
import "./index.css";

const controller = createAppController();
if (import.meta.env.MODE === "e2e") {
  // E2E(新旧比較)用のビルドだけ、状態を外から読めるようにする
  Object.assign(window, { __pdfUnit: { controller, pick } });
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppControllerContext value={controller}>
        <App />
      </AppControllerContext>
    </StrictMode>
  );
}
