import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { AppController } from "../controllers/app-controller";
import type { AppState } from "../state/state";

export const AppControllerContext = createContext<AppController | null>(null);

export const useAppController = (): AppController => {
  const controller = useContext(AppControllerContext);
  if (!controller) {
    throw new Error("AppControllerContext が設定されていません");
  }
  return controller;
};

/** store の一部を購読する(値が変わったときだけ再レンダーする) */
export const useAppState = <T>(selector: (s: AppState) => T): T =>
  useStore(useAppController().app.store, selector);
