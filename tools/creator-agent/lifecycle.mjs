/** A second signal joins the first shutdown; an unresponsive listener has a fixed termination deadline. */
export function installShutdown(app, { processRef = process, logger = console, deadlineMs = 15_000 } = {}) {
  let closing;
  const shutdown = (reason, exitCode = 0) => {
    if (closing) { if (exitCode) processRef.exitCode = exitCode; return closing; }
    processRef.exitCode = exitCode;
    const deadline = setTimeout(() => {
      logger.error("Creator agent shutdown deadline exceeded.");
      app.server.closeAllConnections?.();
      processRef.exit(1);
    }, deadlineMs);
    deadline.unref();
    closing = Promise.resolve().then(() => app.close()).then(() => {
      clearTimeout(deadline);
      logger.log(`Creator agent stopped (${reason}).`);
    }).catch(() => {
      clearTimeout(deadline);
      processRef.exitCode = 1;
      app.server.closeAllConnections?.();
      logger.error("Creator agent shutdown failed.");
      processRef.exit(1);
    });
    return closing;
  };
  processRef.once("SIGINT", () => void shutdown("SIGINT"));
  processRef.once("SIGTERM", () => void shutdown("SIGTERM"));
  app.server.on("error", () => { logger.error("Creator agent listener failed."); void shutdown("listener error", 1); });
  return shutdown;
}
