export function selectCodexDelivery(content, routing = "queue") {
  if (routing !== "queue" && routing !== "hybrid" && routing !== "immediate") {
    throw new Error('routing must be "queue" or "hybrid" or "immediate"');
  }
  if (routing === "queue" || typeof content !== "string") return "queue";
  return routing === "immediate" || /^\s*\[STEER\](?=\s|$)/u.test(content) ? "steer" : "queue";
}
