import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    // AskGPT 扩展状态
    readerSelection?: string;
    readerSelectionItemID?: number | string;
    notifierID?: string;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
  }
}

export default Addon;
