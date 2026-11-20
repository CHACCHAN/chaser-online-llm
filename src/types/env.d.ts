declare module "bun" {
  interface Env {
    HOST_URL: string;
    LLM_API_URL: string;
    LLM_API_KEY: string;
    LLM_MODEL_NAME: string;
    LLM_MODEL_EFFORT?: string;
    LLM_SUB_MODEL_NAME?: string;
    LLM_SUB_MODEL_EFFORT?: string;
    AGENT_TURN_BUDGET_SEC?: string;
    CHASER_USER: string;
    CHASER_PASS: string;
    CHASER_ROOM?: string;
  }
}
