import { spawn } from "node:child_process";
import { createLogStore } from "./log-store.mjs";

// stdout/stderr are intentionally discarded: Next.js, Node, and subprocess
// errors can contain request content even if every app log call is safe.
// Only validated IPC events reach the managed, seven-day log directory.
let child;
let timer;
let stopping = false;
try {
  const store = createLogStore(process.env.YOINK_LOG_DIR || "/app/logs");
  const write = (message) => {
    try { store.write(message); } catch { stopForStorageFailure(); }
  };
  function stopForStorageFailure() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // Fail closed instead of silently abandoning retention or leaking errors.
    child?.kill("SIGTERM");
    process.exitCode = 1;
    setTimeout(() => child?.kill("SIGKILL"), 5000).unref();
  }

  child = spawn(process.execPath, [process.argv[2] || "server.js"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, YOINK_PRIVATE_LOGGING: "1" },
  });
  child.on("message", write);
  child.on("spawn", () => write({ type: "yoink-log", event: "runtime.started" }));
  child.on("error", () => {
    write({ type: "yoink-log", event: "runtime.failed" });
    clearInterval(timer);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    write({ type: "yoink-log", event: code === 0 || signal === "SIGTERM" ? "runtime.stopped" : "runtime.failed" });
    clearInterval(timer);
    process.exitCode = process.exitCode || (signal ? 1 : code ?? 1);
  });
  timer = setInterval(() => {
    try { store.prune(); } catch { stopForStorageFailure(); }
  }, 60_000);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      child.kill(signal);
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });
  }
} catch {
  // No raw error output if the storage path is inaccessible at startup.
  process.exitCode = 1;
}
