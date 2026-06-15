// Programmatic 9:16 short-form assembly with a MANDATORY burned-in AI-disclosure label.
//
// Pipeline: product clip (R2) [+ voiceover (R2)] [+ captions] → 1080x1920 vertical MP4 with a
// permanent "AI-generated" badge drawn over every frame. The label is NON-NEGOTIABLE: when
// `aiLabelRequired` is true, assembly REFUSES to emit an asset that lacks the burned-in label.
// This is the code-level enforcement of the locked AI-disclosure rule.
//
// Backend selection (auto): ffmpeg if `which ffmpeg` succeeds (it does on this host:
// /usr/bin/ffmpeg) → real burn. Otherwise a documented STUB that still RECORDS the label
// requirement and throws, so no unlabeled asset can ever slip through.
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSignedUrl, putObject } from "./storage";

const W = 1080;
const H = 1920;
const LABEL_TEXT = "AI-generated"; // burned-in disclosure (locked wording)

export type AssembleInput = {
  productClipR2Key: string;            // hero product clip OR still (mp4/jpg) — REQUIRED
  voiceoverR2Key?: string;             // optional ElevenLabs MP3
  captions?: string;                   // optional on-screen caption line (hook)
  aiLabelRequired: boolean;            // MUST be true for any AI asset — enforced below
  outR2Key: string;                    // destination R2 key for the finished mp4
  durationSec?: number;                // fallback clip length when source is a still
};

export type AssembleResult = {
  r2Key: string;
  bytes: number;
  labelBurned: boolean;
  backend: "ffmpeg" | "stub";
};

function ffmpegAvailable(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function esc(s: string): string {
  // escape for ffmpeg drawtext
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "’").replace(/%/g, "\\%");
}

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)),
    );
  });
}

/**
 * Assemble a labeled 9:16 creative. Throws if `aiLabelRequired` and we cannot burn the label.
 * Returns the R2 key of the finished, labeled MP4.
 */
export async function assemble(input: AssembleInput): Promise<AssembleResult> {
  if (input.aiLabelRequired !== true && input.aiLabelRequired !== false) {
    throw new Error("assemble: aiLabelRequired must be an explicit boolean");
  }

  if (!ffmpegAvailable()) {
    // STUB PATH — we cannot burn the label, so we MUST NOT emit an asset for an AI creative.
    if (input.aiLabelRequired) {
      throw new Error(
        "assemble: ffmpeg unavailable and aiLabelRequired=true — refusing to emit an unlabeled AI asset. " +
          "Install ffmpeg or wire the Remotion fallback. (Label requirement recorded, no asset written.)",
      );
    }
    throw new Error("assemble: ffmpeg unavailable — stub backend cannot produce video output.");
  }

  const dir = await mkdtemp(join(tmpdir(), "assemble-"));
  try {
    // 1) pull source clip/still from R2
    const srcUrl = await getSignedUrl(input.productClipR2Key, 600);
    const srcResp = await fetch(srcUrl);
    if (!srcResp.ok) throw new Error(`assemble: source fetch HTTP ${srcResp.status}`);
    const isImage = /\.(jpe?g|png|webp)$/i.test(input.productClipR2Key);
    const srcPath = join(dir, isImage ? "src.jpg" : "src.mp4");
    await writeFile(srcPath, Buffer.from(await srcResp.arrayBuffer()));

    // 2) optional voiceover
    let voicePath: string | null = null;
    if (input.voiceoverR2Key) {
      const vUrl = await getSignedUrl(input.voiceoverR2Key, 600);
      const vResp = await fetch(vUrl);
      if (vResp.ok) {
        voicePath = join(dir, "voice.mp3");
        await writeFile(voicePath, Buffer.from(await vResp.arrayBuffer()));
      }
    }

    const outPath = join(dir, "out.mp4");
    const dur = input.durationSec ?? 6;

    // 3) build the filtergraph: scale+pad to 1080x1920, optional caption, MANDATORY label badge.
    const filters: string[] = [
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
    ];
    if (input.captions) {
      filters.push(
        `drawtext=text='${esc(input.captions)}':fontcolor=white:fontsize=52:` +
          `box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=h*0.72:line_spacing=8`,
      );
    }
    // ALWAYS-ON disclosure label — top-right, high-contrast pill. This is the enforced burn.
    filters.push(
      `drawtext=text='${esc(LABEL_TEXT)}':fontcolor=white:fontsize=34:` +
        `box=1:boxcolor=black@0.6:boxborderw=16:x=w-text_w-44:y=56`,
    );
    const vf = filters.join(",");

    // 4) assemble
    const args: string[] = ["-y"];
    if (isImage) {
      args.push("-loop", "1", "-t", String(dur), "-i", srcPath);
    } else {
      args.push("-i", srcPath);
    }
    if (voicePath) args.push("-i", voicePath);
    args.push("-vf", vf, "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast");
    if (voicePath) {
      args.push("-c:a", "aac", "-map", "0:v:0", "-map", `${isImage ? 1 : 1}:a:0`, "-shortest");
    } else if (!isImage) {
      args.push("-c:a", "aac"); // keep source audio if any
    }
    args.push(outPath);

    await run("ffmpeg", args);

    // 5) upload result to R2
    const out = await readFile(outPath);
    await putObject(input.outR2Key, out, "video/mp4");

    return { r2Key: input.outR2Key, bytes: out.byteLength, labelBurned: true, backend: "ffmpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
