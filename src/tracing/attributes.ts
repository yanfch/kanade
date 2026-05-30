/**
 * OTel attribute key constants.
 * Centralized to avoid magic strings scattered across layers.
 */

// ── GenAI (OpenTelemetry semantic conventions) ──────────────────────────────

export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens";
export const GEN_AI_USAGE_CACHE_READ = "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_USAGE_CACHE_CREATION = "gen_ai.usage.cache_creation.input_tokens";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";

// ── kanade task ─────────────────────────────────────────────────────────────

export const TASK_ID = "kanade.task.id";
export const TASK_SOURCE = "kanade.task.source";
export const TASK_STATUS = "kanade.task.status";
export const TASK_RERUN_OF = "kanade.task.rerun_of";

// ── kanade workflow / agent ─────────────────────────────────────────────────

export const WORKFLOW_NAME = "kanade.workflow.name";
export const PHASE_NAME = "kanade.workflow.phase";
export const AGENT_LABEL = "kanade.agent.label";
export const AGENT_ROLE = "kanade.agent.role";
export const AGENT_MODEL = "kanade.agent.model";
export const AGENT_FROM_CACHE = "kanade.agent.from_cache";

// ── kanade isolation ────────────────────────────────────────────────────────

export const ISOLATION_MODE = "kanade.isolation.mode";
export const ISOLATION_BRANCH = "kanade.isolation.branch";
export const ISOLATION_WORKTREE_PATH = "kanade.isolation.worktree_path";

// ── kanade human ────────────────────────────────────────────────────────────

export const HUMAN_REQUEST_ID = "kanade.human.request_id";
export const HUMAN_DECISION = "kanade.human.decision";
