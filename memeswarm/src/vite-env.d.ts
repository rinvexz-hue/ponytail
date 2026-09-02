/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of AlphaRadar's feed/ service, e.g. http://localhost:8787.
   *  Unset = no live feed, dashboard stays fully simulated. */
  readonly VITE_ALPHARADAR_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
