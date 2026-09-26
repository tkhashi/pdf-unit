// 状態は1つの store に集め、変更は dispatch(action) → 純粋関数 reduce だけで行う
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Action } from "./actions";
import { reduce } from "./reducer";
import { type AppState, INITIAL_STATE } from "./state";

export interface AppStore {
  readonly dispatch: (action: Action) => void;
  readonly getState: () => AppState;
  readonly store: StoreApi<AppState>;
  readonly subscribe: StoreApi<AppState>["subscribe"];
}

export const createAppStore = (initial: AppState = INITIAL_STATE): AppStore => {
  const store = createStore<AppState>()(() => initial);
  return {
    dispatch: (action) => {
      const prev = store.getState();
      const next = reduce(prev, action);
      if (next !== prev) {
        store.setState(next, true);
      }
    },
    getState: store.getState,
    store,
    subscribe: store.subscribe,
  };
};
