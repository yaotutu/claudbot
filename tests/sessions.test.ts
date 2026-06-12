import { describe } from "bun:test";
import "../src/sessions/sdk-jsonl-store.test.ts";
import "../src/sessions/jsonl-store.test.ts";
import "../src/sessions/jsonl-parser.test.ts";
import "../src/sessions/session-read-model.test.ts";
import "../src/sessions/session-service.test.ts";
import "./sdk-conformance.test.ts";

describe("sessions (umbrella)", () => {
  // The actual tests live in their respective files. This block exists
  // only so `bun test tests/sessions.test.ts` runs them all.
});
