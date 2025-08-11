import type {
  EventRecord,
  ArtifactMetadata,
} from "../../../specs/storage/contracts.js";
import { createLogger } from "./lib/logger.js";
const log = createLogger("stores");

export type EventLogStore = {
  put(event: EventRecord): Promise<void>;
  list(params: {
    fromTs?: number;
    toTs?: number;
    types?: string[];
    project?: string;
  }): Promise<EventRecord[]>;
  subscribe(fn: (e: EventRecord) => void): () => void;
};

class InMemoryEventLog implements EventLogStore {
  private events: EventRecord[] = [];
  private subscribers = new Set<(e: EventRecord) => void>();
  async put(event: EventRecord): Promise<void> {
    if (!this.events.find((e) => e.id === event.id)) {
      this.events.push(event);
      log.debug("event_put", { id: event.id, type: event.type });
      for (const fn of this.subscribers) {
        try {
          fn(event);
        } catch {}
      }
    }
  }
  subscribe(fn: (e: EventRecord) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  async list(params: {
    fromTs?: number;
    toTs?: number;
    types?: string[];
    project?: string;
  }): Promise<EventRecord[]> {
    return this.events.filter(
      (e) =>
        (params.fromTs === undefined || e.ts >= params.fromTs) &&
        (params.toTs === undefined || e.ts <= params.toTs) &&
        (!params.types || params.types.includes(e.type)) &&
        (!params.project || e.project === params.project)
    );
  }
}

class InMemoryArtifacts {
  private blobs = new Map<
    string,
    { bytes: Uint8Array; metadata: ArtifactMetadata }
  >();
  async put(
    id: string,
    bytes: Uint8Array,
    metadata: Omit<ArtifactMetadata, "id">
  ): Promise<void> {
    this.blobs.set(id, { bytes, metadata: { id, ...metadata } });
  }
  async head(id: string): Promise<ArtifactMetadata> {
    const v = this.blobs.get(id);
    if (!v) throw new Error("NOT_FOUND");
    return v.metadata;
  }
  async get(id: string): Promise<Uint8Array> {
    const v = this.blobs.get(id);
    if (!v) throw new Error("NOT_FOUND");
    return v.bytes;
  }
}

export const eventlog = new InMemoryEventLog();
export const artifacts = new InMemoryArtifacts();

export const plans = new Map<string, any>();

export const newId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
export const toEpoch = (ts: string | number | Date): number => {
  if (typeof ts === "number") return ts;
  if (ts instanceof Date) return Math.floor(ts.getTime() / 1000);
  const d = new Date(ts);
  return Math.floor(d.getTime() / 1000);
};

// Simple in-memory Graph store
type GraphNode = { type: string; id: string; props: Record<string, unknown> };
type GraphEdge = {
  from: string;
  rel: string;
  to: string;
  props?: Record<string, unknown>;
};

class InMemoryGraph {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const n of nodes) this.nodes.set(n.id, n);
    log.debug("graph_upsert_nodes", { count: nodes.length });
  }
  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    for (const e of edges) this.edges.push(e);
    log.debug("graph_upsert_edges", { count: edges.length });
  }
  async query(pattern: Partial<GraphEdge>): Promise<GraphEdge[]> {
    return this.edges.filter(
      (e) =>
        (!pattern.from || e.from === pattern.from) &&
        (!pattern.rel || e.rel === pattern.rel) &&
        (!pattern.to || e.to === pattern.to)
    );
  }
}

// Simple in-memory Vector index
class InMemoryVectors {
  private byCollection = new Map<
    string,
    Map<string, { embedding: number[]; meta?: Record<string, unknown> }>
  >();
  async upsert(
    collection: string,
    item: { id: string; embedding: number[]; meta?: Record<string, unknown> }
  ): Promise<void> {
    const col = this.byCollection.get(collection) ?? new Map();
    col.set(item.id, { embedding: item.embedding, meta: item.meta });
    this.byCollection.set(collection, col);
    log.debug("vector_upsert", { collection, id: item.id });
  }
  async search(
    collection: string,
    params: {
      embedding: number[];
      k: number;
      filters?: Record<string, unknown>;
    }
  ): Promise<
    Array<{ id: string; score: number; meta?: Record<string, unknown> }>
  > {
    const col = this.byCollection.get(collection);
    if (!col) return [];
    const q = params.embedding;
    const cosine = (a: number[], b: number[]) => {
      const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
      const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
      const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
      return na && nb ? dot / (na * nb) : 0;
    };
    const hits = Array.from(col.entries()).map(([id, { embedding, meta }]) => ({
      id,
      score: cosine(q, embedding),
      meta,
    }));
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, params.k);
    log.debug("vector_search", {
      collection,
      k: params.k,
      returned: top.length,
    });
    return top;
  }
}

export const graph = new InMemoryGraph();
export const vectors = new InMemoryVectors();

// Simple in-memory Policy and Approvals
export type PolicyConfig = {
  allowedCapabilities?: string[]; // patterns: '*', 'name@1.*', 'name@1.0'
  deniedCapabilities?: string[];
  requireApprovalCapabilities?: string[];
  allowedAuthScopes?: string[]; // '*' to allow any, otherwise all tool scopes must be within this set
  maxBudgetSeconds?: number; // if step budget exceeds, require approval
  requireApprovalAll?: boolean;
};

const policyConfig: PolicyConfig = {
  allowedCapabilities: ["*"],
  deniedCapabilities: [],
  requireApprovalCapabilities: [],
  allowedAuthScopes: ["*"],
  maxBudgetSeconds: 0,
  requireApprovalAll: false,
};

const planIdToApprovedSteps = new Map<string, Set<string>>();
const planIdToRejectedSteps = new Map<string, Set<string>>();

export function getPolicy(): PolicyConfig {
  return policyConfig;
}

export function setPolicy(update: Partial<PolicyConfig>) {
  Object.assign(policyConfig, update);
}

export function isStepApproved(planId: string, stepId: string): boolean {
  return planIdToApprovedSteps.get(planId)?.has(stepId) ?? false;
}

export function isStepRejected(planId: string, stepId: string): boolean {
  return planIdToRejectedSteps.get(planId)?.has(stepId) ?? false;
}

export function approveStep(planId: string, stepId: string): void {
  const set = planIdToApprovedSteps.get(planId) ?? new Set<string>();
  set.add(stepId);
  planIdToApprovedSteps.set(planId, set);
  // remove rejection if any
  planIdToRejectedSteps.get(planId)?.delete(stepId);
}

export function rejectStep(planId: string, stepId: string): void {
  const set = planIdToRejectedSteps.get(planId) ?? new Set<string>();
  set.add(stepId);
  planIdToRejectedSteps.set(planId, set);
}

// Approvals manager (in-memory)
type ApprovalKey = string;
type ApprovalState = "pending" | "granted" | "denied";

class Approvals {
  private state = new Map<ApprovalKey, ApprovalState>();
  private waiters = new Map<ApprovalKey, Array<(v: ApprovalState) => void>>();

  private key(planId: string, stepId: string): ApprovalKey {
    return `${planId}::${stepId}`;
  }

  require(planId: string, stepId: string): boolean {
    const k = this.key(planId, stepId);
    if (!this.state.has(k)) {
      this.state.set(k, "pending");
      return true;
    }
    return false;
  }

  get(planId: string, stepId: string): ApprovalState | undefined {
    return this.state.get(this.key(planId, stepId));
  }

  async wait(planId: string, stepId: string): Promise<ApprovalState> {
    const k = this.key(planId, stepId);
    const cur = this.state.get(k);
    if (cur && cur !== "pending") return cur;
    return new Promise<ApprovalState>((resolve) => {
      const arr = this.waiters.get(k) ?? [];
      arr.push(resolve);
      this.waiters.set(k, arr);
    });
  }

  approve(planId: string, stepId: string, granted: boolean) {
    const k = this.key(planId, stepId);
    const next: ApprovalState = granted ? "granted" : "denied";
    this.state.set(k, next);
    const arr = this.waiters.get(k) ?? [];
    this.waiters.delete(k);
    for (const fn of arr) {
      try {
        fn(next);
      } catch {}
    }
  }
}

export const approvals = new Approvals();
