export function badgeClass(status: string): string {
  if (status === "completed") return "badge badge-ok";
  if (status === "failed") return "badge badge-err";
  if (status === "running") return "badge badge-run";
  if (status === "awaiting_approval" || status === "pending")
    return "badge badge-wait";
  if (status === "skipped") return "badge badge-skip";
  return "badge";
}

export const pretty = (o: unknown) => JSON.stringify(o, null, 2);

export const toolTip = (t: any) => {
  const inputRef =
    t?.inputSchema?.$ref ||
    (typeof t?.inputSchema === "string" ? t.inputSchema : "");
  const outputRef =
    t?.outputSchema?.$ref ||
    (typeof t?.outputSchema === "string" ? t.outputSchema : "");
  const scopes = Array.isArray(t?.authScopes) ? t.authScopes.join(", ") : "";
  return [
    `Name: ${t?.name ?? ""}`,
    `Capability: ${t?.capability ?? ""}`,
    `Version: ${t?.version ?? ""}`,
    scopes ? `Auth Scopes: ${scopes}` : undefined,
    `Sandboxed: ${t?.sandboxed ? "yes" : "no"}`,
    inputRef ? `Input Schema: ${inputRef}` : undefined,
    outputRef ? `Output Schema: ${outputRef}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
};
