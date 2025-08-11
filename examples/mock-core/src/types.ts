export type Intent = {
  id: string;
  ts: string;
  actor: string;
  goal: string;
  project?: string;
  inputs?: Record<string, unknown>;
  constraints?: string[];
  autonomy?: "S0" | "S1" | "S2" | "S3" | "S4";
};

export type ToolCall = {
  capability: string;
  tool?: string;
  input: Record<string, unknown>;
  budget?: { seconds?: number; dollars?: number; tokens?: number };
};

export type PlanStep = {
  id: string;
  kind: "tool" | "ask" | "write" | "decision";
  description: string;
  requiresApproval?: boolean;
  requires?: string[];
  toolCall?: ToolCall;
};

export type Plan = {
  id: string;
  intentId: string;
  project?: string;
  steps: PlanStep[];
  assumptions: string[];
  risks: string[];
  expectedArtifacts: string[];
};

export type StepResult = {
  stepId: string;
  status: string;
  attempt?: number;
  error?: string;
  output?: unknown;
};
