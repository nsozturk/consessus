import readline from "node:readline";

// Only the listener's own command input may use this path. Socket frames never reach it.
export async function readRoomControl({ input, endpoint, dispatch, reportError }) {
  const lines = readline.createInterface({ input, terminal: false });
  const close = () => lines.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    for await (const line of lines) {
      try {
        const request = JSON.parse(line);
        if (!["join", "send", "leave"].includes(request?.action) || typeof request.room !== "string") {
          throw new Error("Room control supports join, send and leave with a room name");
        }
        await dispatch({
          _: ["room", request.action, request.room],
          "from-address": endpoint.address,
          "from-session": endpoint.sessionId,
          "from-mode": endpoint.fromMode,
          ...(request.action === "send" ? { to: request.to, all: request.all, message: request.message } : {}),
        });
      } catch (error) {
        reportError(error instanceof SyntaxError ? "Invalid room control JSON" : error.message);
      }
    }
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}
