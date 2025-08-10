// Stack-neutral TypeScript types describing storage adapter contracts.
// Implementations can be in any language; this file serves as the canonical shape.

export type UnixEpochSeconds = number;

export interface EventRecord {
  id: string;
  ts: UnixEpochSeconds;
  type: string;
  actor: "user" | "metis";
  project?: string;
  payload: unknown;
}

export interface EventLogStore {
  put(event: EventRecord): Promise<void>; // idempotent by id
  list(params: {
    fromTs?: UnixEpochSeconds;
    toTs?: UnixEpochSeconds;
    types?: string[];
    project?: string;
  }): Promise<EventRecord[]>;
  query(filterDsl: unknown): Promise<EventRecord[]>;
}

export interface GraphNode {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  rel: string;
  to: string;
  props?: Record<string, unknown>;
}

export interface GraphStore {
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  query(patternDsl: unknown): Promise<unknown>; // triples/paths per implementation
}

export interface VectorItem {
  id: string;
  embedding: number[];
  meta?: Record<string, unknown>;
}

export interface VectorIndex {
  upsert(collection: string, item: VectorItem): Promise<void>;
  search(
    collection: string,
    params: {
      embedding: number[];
      k: number;
      filters?: Record<string, unknown>;
    }
  ): Promise<
    Array<{ id: string; score: number; meta?: Record<string, unknown> }>
  >;
}

export interface ArtifactMetadata {
  id: string;
  kind: string;
  title: string;
  uri: string;
  checksum: string;
  created_at: UnixEpochSeconds;
  created_by: "user" | "metis";
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface ArtifactStore {
  put(
    id: string,
    bytes: Uint8Array,
    metadata: Omit<ArtifactMetadata, "id">
  ): Promise<void>;
  get(id: string): Promise<{ bytes: Uint8Array; metadata: ArtifactMetadata }>;
  head(id: string): Promise<ArtifactMetadata>;
}
