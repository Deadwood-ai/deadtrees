import type { ComponentType } from "react";
import ReactPlayerModule from "react-player";

type ReactPlayerComponent = ComponentType<Record<string, unknown>>;
type ReactPlayerModuleShape = ReactPlayerComponent & {
  default?: ReactPlayerComponent;
};

const playerModule = ReactPlayerModule as unknown as ReactPlayerModuleShape;

// Vite 8 can preserve react-player's CommonJS wrapper as a double default.
const ReactPlayer = (playerModule.default ?? playerModule) as ReactPlayerComponent;

export default ReactPlayer;
