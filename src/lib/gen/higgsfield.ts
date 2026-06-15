// Higgsfield generation adapter — REAL (wired 2026-06-15 via the local `higgs` CLI).
//
// Source of truth: Daniel's Higgsfield account, authed through the `higgsfield`/`higgs`/`hf` CLI
// (~/.config/higgsfield/credentials.json). The same access_token is mirrored into the vault under
// service `higgsfield`, key HIGGSFIELD_API_KEY, so a hosted runtime (Trigger.dev) can later swap
// the CLI shell-out for a direct HTTP call without re-auth. Until then the cheapest, proven path is
// to invoke the CLI — it handles auth refresh, upload, polling and returns a CDN result URL.
//
// PRODUCT-FIRST DOCTRINE (locked): the hero asset is the PRODUCT (lick/snuffle mat, freeze-mold,
// hands-only demo), never a photoreal dog. `higgsfieldProductImage` is the hero still generator.
// Cheapest image model on the account is `z_image` (~0.15 credits, supports 9:16) — used by default.
//
// Output: the CDN image is downloaded and re-uploaded to R2 via storage.putObject; we return the R2
// key (never the CDN URL — those are account-scoped and can rotate). Signature is fal-compatible
// (FalResult) so callers can branch between fal and higgsfield with no shape change.
import { spawn } from "node:child_process";
import { getKey } from "../vault";
import { putObject } from "../storage";
import type { FalResult } from "./fal";

// Cheapest 9:16-capable image model on the account (probed 2026-06-15: z_image = 0.15 credits).
// Overridable without redeploy for cost/quality tuning.
const MODEL_IMAGE = process.env.HIGGS_MODEL_IMAGE ?? "z_image";
const HIGGS_BIN = process.env.HIGGS_BIN ?? "higgs";

/** True only when a higgsfield credential exists — lets callers branch without throwing. */
export async function higgsfieldAvailable(): Promise<boolean> {
  const a = await getKey("higgsfield", "HIGGSFIELD_API_KEY");
  const b = a ?? (await getKey("higgsfield", "HIGGSFIELD_TOKEN"));
  return Boolean(b);
}

type HiggsJob = {
  id: string;
  status: string;
  job_set_type?: string;
  result_url?: string;
  result_urls?: string[];
};

/** Run the higgs CLI, capture stdout, parse the trailing JSON array of completed jobs. */
function runHiggs(args: string[], timeoutMs = 300_000): Promise<HiggsJob[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(HIGGS_BIN, [...args, "--json", "--no-color"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`higgs ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`higgs ${args[0]} exited ${code}: ${err.slice(-400) || out.slice(-400)}`));
        return;
      }
      // CLI prints a JSON array of jobs; grab the last bracketed block to be robust to log noise.
      const start = out.lastIndexOf("[");
      const end = out.lastIndexOf("]");
      if (start === -1 || end === -1 || end < start) {
        reject(new Error(`higgs ${args[0]}: no JSON array in output: ${out.slice(-300)}`));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(start, end + 1)) as HiggsJob[]);
      } catch (e) {
        reject(new Error(`higgs ${args[0]}: bad JSON: ${(e as Error).message}`));
      }
    });
  });
}

async function fetchToR2(url: string, r2Key: string, contentType: string): Promise<number> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`higgsfield: download of output failed HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await putObject(r2Key, buf, contentType);
  return buf.byteLength;
}

/**
 * Product-first hero STILL via Higgsfield (default model z_image, 9:16). `prompt` must describe the
 * PRODUCT in scene — never a realistic dog as the subject. Returns the R2 key of the stored image.
 */
export async function higgsfieldProductImage(
  prompt: string,
  r2Key: string,
  opts?: { aspectRatio?: string; model?: string },
): Promise<FalResult> {
  const model = opts?.model ?? MODEL_IMAGE;
  const aspect = opts?.aspectRatio ?? "9:16";
  const jobs = await runHiggs([
    "generate",
    "create",
    model,
    "--prompt",
    prompt,
    "--aspect_ratio",
    aspect,
    "--wait",
    "--wait-timeout",
    "4m",
    "--wait-interval",
    "5s",
  ]);
  const job = jobs.find((j) => j.result_url || (j.result_urls && j.result_urls.length));
  const url = job?.result_url ?? job?.result_urls?.[0];
  if (!url) throw new Error(`higgsfield ${model}: no result_url in job output`);
  const isPng = /\.png(\?|$)/i.test(url);
  const bytes = await fetchToR2(url, r2Key, isPng ? "image/png" : "image/jpeg");
  return { r2Key, bytes, model, costNote: `higgs ${model} ≈ 0.15 credits/img (~$0.003)` };
}

/**
 * Stub clip generator kept fal-compatible. Higgsfield DOES have video models, but per the
 * product-first doctrine we assemble motion from a still via ffmpeg (assemble.ts) for the cheapest
 * proven path. Wire a real higgs video model here later if motion-gen is needed.
 */
export async function higgsfieldClip(
  _imageUrl: string,
  _prompt: string,
  _r2Key: string,
): Promise<FalResult> {
  throw new Error(
    "higgsfieldClip: not used — motion is assembled from the product still via ffmpeg (assemble.ts). " +
      "Wire a higgs video model (e.g. via `higgs model list --video`) here if direct clip-gen is needed.",
  );
}
