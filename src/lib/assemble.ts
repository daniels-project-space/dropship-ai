// Programmatic 9:16 short-form assembly with a MANDATORY burned-in AI-disclosure label.
//
// Pipeline: product clip (R2) [+ voiceover (R2)] [+ captions] → 1080x1920 vertical MP4 with a
// permanent "AI-generated" badge drawn over every frame. The label is NON-NEGOTIABLE: when
// `aiLabelRequired` is true, assembly REFUSES to emit an asset that lacks the burned-in label.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getObjectBuffer, putDeterministicObject, type StoredObjectReceipt } from "./storage";

const W = 1080;
const H = 1920;
const LABEL_TEXT = "AI-generated"; // burned-in disclosure (locked wording)
export const ASSEMBLY_OUTPUT_MAX_BYTES = 300 * 1024 * 1024;
export const ASSEMBLY_PROCESS_TIMEOUT_MS = 8 * 60_000;
export const ASSEMBLY_STDERR_TAIL_BYTES = 16 * 1024;
export const ASSEMBLY_MAX_DURATION_SECONDS = 60;

export type AssembleInput = {
  productClipR2Key: string;
  productClipReceipt: Pick<StoredObjectReceipt, "contentType" | "bytes" | "sha256">;
  voiceoverR2Key?: string;
  voiceoverReceipt?: Pick<StoredObjectReceipt, "contentType" | "bytes" | "sha256">;
  captions?: string;
  aiLabelRequired: boolean;
  outR2Key: string;
  durationSec?: number;
};

export type AssembleResult = {
  r2Key: string;
  bytes: number;
  labelBurned: boolean;
  backend: "ffmpeg" | "stub";
  contentType: "video/mp4";
  sha256: string;
};

export type AssemblyEffects = {
  probeFfmpeg: (command: string) => boolean;
  runProcess: (command: string, args: string[]) => Promise<void>;
  getObjectBuffer: typeof getObjectBuffer;
  putObject: typeof putDeterministicObject;
  readOutputFile: typeof readFile;
  statOutputFile: typeof stat;
};

function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

export function probeFfmpegBounded(command: string): boolean {
  try {
    execFileSync(command, ["-version"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function appendTail(current: Buffer, value: unknown, maxBytes: number): Buffer {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (chunk.byteLength >= maxBytes) return Buffer.from(chunk.subarray(chunk.byteLength - maxBytes));
  const keep = Math.min(current.byteLength, maxBytes - chunk.byteLength);
  return Buffer.concat([current.subarray(current.byteLength - keep), chunk], keep + chunk.byteLength);
}

/** Run FFmpeg with a bounded diagnostic tail and reject only after a timed-out child has closed. */
export async function runFfmpegProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; stderrTailBytes?: number; spawnImpl?: typeof spawn } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? ASSEMBLY_PROCESS_TIMEOUT_MS;
  const stderrTailBytes = options.stderrTailBytes ?? ASSEMBLY_STDERR_TAIL_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(stderrTailBytes) || stderrTailBytes < 1) {
    throw new Error("assemble: invalid process bounds");
  }
  await new Promise<void>((resolve, reject) => {
    const child = (options.spawnImpl ?? spawn)(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let spawnError: Error | undefined;
    child.stderr?.on("data", (chunk) => { stderrTail = appendTail(stderrTail, chunk, stderrTailBytes); });
    child.once("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const tail = stderrTail.toString("utf8");
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms and was killed: ${tail}`));
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`${command} exited ${code ?? signal ?? "unknown"}: ${tail}`));
      else resolve();
    });
  });
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

function validatedDuration(value: number | undefined): number {
  const duration = value ?? 6;
  if (!Number.isFinite(duration) || duration < 1 || duration > ASSEMBLY_MAX_DURATION_SECONDS) {
    throw new Error(`assemble: duration must be from 1 to ${ASSEMBLY_MAX_DURATION_SECONDS} seconds`);
  }
  return duration;
}

/** Assemble a labeled 9:16 creative. Throws before upload if any resource bound is violated. */
export async function assemble(input: AssembleInput, overrides: Partial<AssemblyEffects> = {}): Promise<AssembleResult> {
  if (input.aiLabelRequired !== true && input.aiLabelRequired !== false) {
    throw new Error("assemble: aiLabelRequired must be an explicit boolean");
  }
  const command = ffmpegBinary();
  const effects: AssemblyEffects = {
    probeFfmpeg: overrides.probeFfmpeg ?? probeFfmpegBounded,
    runProcess: overrides.runProcess ?? runFfmpegProcess,
    getObjectBuffer: overrides.getObjectBuffer ?? getObjectBuffer,
    putObject: overrides.putObject ?? putDeterministicObject,
    readOutputFile: overrides.readOutputFile ?? readFile,
    statOutputFile: overrides.statOutputFile ?? stat,
  };
  if (!effects.probeFfmpeg(command)) {
    if (input.aiLabelRequired) {
      throw new Error("assemble: ffmpeg unavailable and aiLabelRequired=true — refusing to emit an unlabeled AI asset");
    }
    throw new Error("assemble: ffmpeg unavailable — stub backend cannot produce video output");
  }

  const duration = validatedDuration(input.durationSec);
  if (input.captions !== undefined && Buffer.byteLength(input.captions, "utf8") > 4 * 1024) {
    throw new Error("assemble: captions exceed 4096 encoded bytes");
  }
  const dir = await mkdtemp(join(tmpdir(), "assemble-"));
  try {
    const isImage = /\.(jpe?g|png|webp)$/i.test(input.productClipR2Key);
    const srcPath = join(dir, isImage ? "src.jpg" : "src.mp4");
    await writeFile(srcPath, await effects.getObjectBuffer(input.productClipR2Key, input.productClipReceipt));

    let voicePath: string | null = null;
    if (input.voiceoverR2Key) {
      if (!input.voiceoverReceipt) throw new Error("assemble: voiceover receipt is required");
      voicePath = join(dir, "voice.mp3");
      await writeFile(voicePath, await effects.getObjectBuffer(input.voiceoverR2Key, input.voiceoverReceipt));
    }

    const filters = [`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`];
    if (input.captions) {
      const captionPath = join(dir, "caption.txt");
      await writeFile(captionPath, input.captions, "utf8");
      filters.push(
        `drawtext=textfile='${escapeFilterValue(captionPath)}':fontcolor=white:fontsize=52:`
        + "box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=h*0.72:line_spacing=8",
      );
    }
    filters.push(
      `drawtext=text='${LABEL_TEXT}':fontcolor=white:fontsize=34:`
      + "box=1:boxcolor=black@0.6:boxborderw=16:x=w-text_w-44:y=56",
    );

    const outPath = join(dir, "out.mp4");
    const args: string[] = ["-y"];
    if (isImage) args.push("-loop", "1", "-t", String(duration), "-i", srcPath);
    else args.push("-i", srcPath);
    if (voicePath) args.push("-i", voicePath);
    args.push("-vf", filters.join(","), "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast");
    if (voicePath) args.push("-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0", "-shortest");
    else if (!isImage) args.push("-c:a", "aac");
    if (!isImage) args.push("-t", String(ASSEMBLY_MAX_DURATION_SECONDS));
    args.push("-fs", String(ASSEMBLY_OUTPUT_MAX_BYTES), outPath);

    await effects.runProcess(command, args);
    const outputStat = await effects.statOutputFile(outPath);
    if (!Number.isSafeInteger(outputStat.size) || outputStat.size < 1 || outputStat.size > ASSEMBLY_OUTPUT_MAX_BYTES) {
      throw new Error("assemble: output exceeds the 300 MiB storage limit");
    }
    const output = await effects.readOutputFile(outPath);
    if (output.byteLength !== outputStat.size || output.byteLength > ASSEMBLY_OUTPUT_MAX_BYTES) {
      throw new Error("assemble: output changed after validation");
    }
    const receipt = await effects.putObject(input.outR2Key, output, "video/mp4", ASSEMBLY_OUTPUT_MAX_BYTES);
    return {
      r2Key: input.outR2Key, bytes: receipt.bytes, contentType: "video/mp4", sha256: receipt.sha256,
      labelBurned: true, backend: "ffmpeg",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
