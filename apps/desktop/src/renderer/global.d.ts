import type { ModelRelayApi } from "../shared/contracts";

declare global {
  interface Window {
    modelRelay: ModelRelayApi;
  }
}

export {};
