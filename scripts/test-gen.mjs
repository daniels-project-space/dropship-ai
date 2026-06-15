// One-shot end-to-end proof of the content pipeline (near-zero opex: ONE image + ONE TTS line).
// Self-contained — uses only already-installed deps (@aws-sdk/client-s3, convex). No tsx needed.
// Run: NEXT_PUBLIC_CONVEX_URL=... node scripts/test-gen.mjs <siteId>
//
// Mirrors the real adapters (src/lib/gen/fal.ts, tts.ts, assemble.ts) step-for-step so a green
// run proves the production wire end-to-end: fal Flux → ElevenLabs → ffmpeg(+AI label) → R2 → Convex.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const VAULT = "https://fantastic-roadrunner-485.convex.cloud/api/query";
const siteId = process.argv[2];
if (!siteId) { console.error("usage: node scripts/test-gen.mjs <siteId>"); process.exit(1); }

async function vaultGet(service, keyName) {
  const r = await fetch(VAULT, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:getOne", args: { service, keyName }, format: "json" }),
  });
  const j = await r.json();
  return j?.value?.value ?? null;
}

const BUCKET = "dropship-ai";
let s3;
async function r2() {
  if (s3) return s3;
  const accountId = await vaultGet("cloudflare", "R2_ACCOUNT_ID");
  const accessKeyId = await vaultGet("cloudflare", "R2_ACCESS_KEY_ID");
  const secretAccessKey = await vaultGet("cloudflare", "R2_SECRET_ACCESS_KEY");
  s3 = new S3Client({ region: "auto", endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey } });
  return s3;
}
async function putR2(key, body, ct) {
  await (await r2()).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: ct }));
  return key;
}
async function signR2(key) {
  return presign(await r2(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 600 });
}

const stamp = Date.now();
const base = `creatives/${siteId}/test-${stamp}`;
const scene =
  "close-up product photography of a textured silicone dog lick mat smeared with creamy peanut " +
  "butter and yogurt, soft natural window light, calm muted palette, shallow depth of field, " +
  "no animals in frame, premium pet-enrichment brand look, vertical 9:16";
const line = "The 3-minute lick mat that melts the zoomies away.";
let cost = 0;

// 1) fal Flux still
console.log("[1/4] fal Flux product still…");
const falKey = await vaultGet("fal", "FAL_KEY");
const falRes = await fetch("https://fal.run/fal-ai/flux/schnell", {
  method: "POST", headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: scene, image_size: "portrait_16_9", num_images: 1 }),
});
if (!falRes.ok) throw new Error("fal failed: " + falRes.status + " " + (await falRes.text()).slice(0, 200));
const falJson = await falRes.json();
const imgUrl = falJson.images?.[0]?.url;
const imgBuf = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
await putR2(`${base}-still.jpg`, imgBuf, "image/jpeg");
console.log("   ->", `${base}-still.jpg`, imgBuf.byteLength, "bytes");
cost += 0.003;

// 2) ElevenLabs VO
console.log("[2/4] ElevenLabs voiceover…");
const elKey = await vaultGet("elevenlabs", "ELEVENLABS_API_KEY");
const elRes = await fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM", {
  method: "POST", headers: { "xi-api-key": elKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
  body: JSON.stringify({ text: line, model_id: "eleven_turbo_v2_5",
    voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
});
if (!elRes.ok) throw new Error("eleven failed: " + elRes.status + " " + (await elRes.text()).slice(0, 200));
const voBuf = Buffer.from(await elRes.arrayBuffer());
await putR2(`${base}-vo.mp3`, voBuf, "audio/mpeg");
console.log("   ->", `${base}-vo.mp3`, voBuf.byteLength, "bytes");
cost += line.length * 0.00003;

// 3) ffmpeg assemble with MANDATORY AI label (mirrors src/lib/assemble.ts filtergraph)
console.log("[3/4] ffmpeg assemble with MANDATORY AI label…");
const dir = mkdtempSync(join(tmpdir(), "testgen-"));
const stillPath = join(dir, "src.jpg"), voPath = join(dir, "vo.mp3"), outPath = join(dir, "out.mp4");
writeFileSync(stillPath, imgBuf); writeFileSync(voPath, voBuf);
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "’");
const vf = [
  "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
  `drawtext=text='${esc(line)}':fontcolor=white:fontsize=52:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=h*0.72`,
  `drawtext=text='${esc("AI-generated")}':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.6:boxborderw=16:x=w-text_w-44:y=56`,
].join(",");
const ff = spawnSync("ffmpeg", ["-y", "-loop", "1", "-t", "6", "-i", stillPath, "-i", voPath,
  "-vf", vf, "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
  "-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0", "-shortest", outPath], { encoding: "utf8" });
if (ff.status !== 0) throw new Error("ffmpeg failed: " + (ff.stderr || "").slice(-400));
const outBuf = readFileSync(outPath);
await putR2(`${base}-final.mp4`, outBuf, "video/mp4");
rmSync(dir, { recursive: true, force: true });
console.log("   ->", `${base}-final.mp4`, outBuf.byteLength, "bytes | labelBurned: true | backend: ffmpeg");

// 4) create creative row
console.log("[4/4] create creative row (status review)…");
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
const res = await convex.mutation(api.creatives.requestGen, {
  siteId, kind: "product_demo", aiGenerated: true, hook: line, r2Key: `${base}-final.mp4`, status: "review",
});
console.log("   -> creativeId:", res.creativeId, "| aiLabelRequired:", res.aiLabelRequired);
console.log(`\nDONE. Estimated cost ≈ $${cost.toFixed(4)} (1 flux img + ${line.length} TTS chars).`);
