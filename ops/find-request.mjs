import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pruneLogs, sanitizeRecord } from "./log-store.mjs";

const requestId = process.argv[2];
if (!/^req-[a-f0-9]{32}$/.test(requestId || "")) {
  process.stderr.write("Provide a request ID in the form req- followed by 32 lowercase hex characters.\n");
  process.exitCode = 1;
} else {
  try {
    const directory = process.env.YOINK_LOG_DIR || "/app/logs";
    pruneLogs(directory);
    for (const name of readdirSync(directory).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
        try {
          const record = JSON.parse(line);
          if (record.requestId !== requestId || !Number.isFinite(Date.parse(record.time))) continue;
          const safe = sanitizeRecord({ ...record, type: "yoink-log" }, Date.parse(record.time));
          if (safe) process.stdout.write(JSON.stringify(safe) + "\n");
        } catch { /* Ignore incomplete or malformed lines. */ }
      }
    }
  } catch {
    process.stderr.write("Unable to read retained request logs.\n");
    process.exitCode = 1;
  }
}
