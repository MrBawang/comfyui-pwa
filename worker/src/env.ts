export interface Env {
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  GPU_QUEUE: DurableObjectNamespace;
  AI: Ai;
  APP_ENV: string;
  DEV_USER_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  MODAL_WORKSPACE: string;
  MODAL_API_URL?: string;
  MODAL_API_TOKEN?: string;
  MODAL_BUDGET_CONFIRMED?: string;
  MODAL_LLM_URL?: string;
  MODAL_LLM_TOKEN?: string;
  LORACHEF_AGENT_TOKEN?: string;
  R2_BROWSER_PASSWORD_SHA256?: string;
  WORKERS_AI_MODEL: string;
  STORAGE_WARNING_BYTES: string;
  STORAGE_STOP_BYTES: string;
  R2_CLASS_A_STOP: string;
  R2_CLASS_B_STOP: string;
  WORKERS_AI_STOP_NEURONS: string;
  MODAL_POLL_SECONDS: string;
}

export interface UserContext {
  Variables: {
    ownerEmail: string;
  };
  Bindings: Env;
}
