export type ImageryMode =
  | { kind: "live" }
  | { kind: "discovering" }
  | { kind: "historical"; releaseNum: number };

export type ImageryModeAction =
  | { type: "use-live" }
  | { type: "browse-history" }
  | { type: "select-release"; releaseNum: number };

export const LIVE_IMAGERY_MODE: ImageryMode = { kind: "live" };

export const imageryModeReducer = (
  state: ImageryMode,
  action: ImageryModeAction,
): ImageryMode => {
  switch (action.type) {
    case "use-live":
      return LIVE_IMAGERY_MODE;
    case "browse-history":
      return state.kind === "historical" ? state : { kind: "discovering" };
    case "select-release":
      return { kind: "historical", releaseNum: action.releaseNum };
  }
};
