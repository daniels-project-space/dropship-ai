import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ASSEMBLY_OUTPUT_MAX_BYTES, assemble, runFfmpegProcess,
} from "../src/lib/assemble.ts";

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.kill = (signal) => { onKill(signal); setImmediate(() => child.emit("close", null, signal)); return true; };
  return child;
}

test("FFmpeg timeout kills and awaits the child while retaining only a bounded stderr tail", async () => {
  let killedWith = null;
  const child = fakeChild((signal) => { killedWith = signal; });
  const keepAlive = setTimeout(() => undefined, 100);
  queueMicrotask(() => {
    child.stderr.write(Buffer.alloc(512, 0x41));
    child.stderr.write("timeout-visible-tail");
  });
  await assert.rejects(() => runFfmpegProcess("ffmpeg-fixture", ["-x"], {
    timeoutMs: 10, stderrTailBytes: 32, spawnImpl: () => child,
  }), (error) => {
    assert.match(error.message, /timed out after 10ms and was killed/);
    assert.match(error.message, /timeout-visible-tail/);
    assert.equal(error.message.includes("A".repeat(64)), false);
    return true;
  });
  clearTimeout(keepAlive);
  assert.equal(killedWith, "SIGKILL");
});

test("FFmpeg nonzero exit exposes the diagnostic tail without an unbounded accumulator", async () => {
  const child = fakeChild(() => undefined);
  queueMicrotask(() => {
    child.stderr.write(`discard-me-${"B".repeat(1024)}`);
    child.stderr.write("final-diagnostic");
    child.emit("close", 1, null);
  });
  await assert.rejects(() => runFfmpegProcess("ffmpeg-fixture", [], {
    timeoutMs: 100, stderrTailBytes: 24, spawnImpl: () => child,
  }), (error) => {
    assert.match(error.message, /final-diagnostic/);
    assert.equal(error.message.includes("discard-me"), false);
    assert.ok(error.message.length < 100);
    return true;
  });
});

const receipt = (contentType, marker) => ({
  contentType, bytes: 12, sha256: createHash("sha256").update(marker).digest("hex"),
});

function baseInput(captions) {
  return {
    productClipR2Key: "creatives/generations/intent/v0/clip.mp4",
    productClipReceipt: receipt("video/mp4", "source"), captions,
    aiLabelRequired: true, outR2Key: "creatives/generations/intent/v0/final.mp4",
  };
}

test("assembly rejects an oversized FFmpeg output before read or upload", async () => {
  let reads = 0; let uploads = 0; let processRuns = 0;
  await assert.rejects(() => assemble(baseInput("safe caption"), {
    probeFfmpeg: () => true,
    getObjectBuffer: async () => Buffer.from("source"),
    runProcess: async () => { processRuns++; },
    statOutputFile: async () => ({ size: ASSEMBLY_OUTPUT_MAX_BYTES + 1 }),
    readOutputFile: async () => { reads++; return Buffer.alloc(0); },
    putObject: async () => { uploads++; throw new Error("upload must not run"); },
  }), /exceeds the 300 MiB/);
  assert.deepEqual({ processRuns, reads, uploads }, { processRuns: 1, reads: 0, uploads: 0 });
});

test("hostile operator captions stay in a temp text file and the mandatory label remains burned", async () => {
  const hostile = "quote' colon: comma, semicolon; brackets[] percent% slash\\ newline\n$(touch /tmp/never)";
  let ffmpegArgs; let captionContents; let uploads = 0;
  const result = await assemble(baseInput(hostile), {
    probeFfmpeg: () => true,
    getObjectBuffer: async () => Buffer.from("source"),
    runProcess: async (_command, args) => {
      ffmpegArgs = args;
      const filter = args[args.indexOf("-vf") + 1];
      const match = /textfile='([^']+caption\.txt)'/.exec(filter);
      assert.ok(match, "caption filter must reference a temp text file");
      captionContents = await readFile(match[1].replace(/\\:/g, ":").replace(/\\'/g, "'"), "utf8");
      await writeFile(args.at(-1), Buffer.from("0000ftypfixture"));
    },
    putObject: async (key, body, contentType) => {
      uploads++;
      return { key, contentType, bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"), reused: false };
    },
  });
  const filter = ffmpegArgs[ffmpegArgs.indexOf("-vf") + 1];
  assert.equal(captionContents, hostile);
  assert.equal(filter.includes(hostile), false);
  assert.match(filter, /drawtext=text='AI-generated'/);
  assert.deepEqual({ uploads, labelBurned: result.labelBurned, backend: result.backend },
    { uploads: 1, labelBurned: true, backend: "ffmpeg" });
  assert.equal(ffmpegArgs.includes("-fs"), true);
  assert.equal(ffmpegArgs.includes(String(ASSEMBLY_OUTPUT_MAX_BYTES)), true);
});

test("assembly duration is finite and capped before process execution", async () => {
  let processRuns = 0;
  await assert.rejects(() => assemble({ ...baseInput(), durationSec: 61 }, {
    probeFfmpeg: () => true,
    runProcess: async () => { processRuns++; },
  }), /duration must be from 1 to 60/);
  assert.equal(processRuns, 0);
});
