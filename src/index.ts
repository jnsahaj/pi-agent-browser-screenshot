/**
 * Inline agent-browser screenshots in the pi TUI.
 *
 * When the agent runs an `agent-browser … screenshot …` bash command, this
 * extension finds the resulting image file and renders it inline.
 *
 * Outside tmux it defers to pi-tui's Image component (kitty graphics with a
 * text fallback). Inside tmux, pi-tui disables images entirely, so this
 * extension renders them itself using kitty graphics Unicode placeholders
 * (https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders):
 * the image transfer is wrapped in tmux DCS passthrough, and the visible
 * cells are ordinary text, so tmux can scroll and redraw them like any
 * other line.
 *
 * The tmux path requires (falls back to a text line otherwise):
 *   - tmux 3.3+ with `set -g allow-passthrough on`
 *   - a terminal that implements Unicode placeholders (kitty >= 0.28, Ghostty)
 *
 * Screenshot entries persist with the session but are TUI-only; they are
 * never sent to the model.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCellDimensions,
  getImageDimensions,
  Image,
  Text,
  type Component,
  type ImageDimensions,
} from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

const ENTRY_TYPE = "agent-browser-screenshot";
const IMAGE_PATH_RE = /(?:^|[\s"'=])((?:[~./\\]|\/)?[\w~@./\\-]+\.(?:png|jpe?g|webp|gif|bmp))/gi;
const IMAGE_PLACEHOLDER = "\u{10eeee}";
const MAX_WIDTH_CELLS = 100;
const MAX_HEIGHT_CELLS = 30;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Files modified this long before the command started still count as its
// output, to absorb clock/fs-timestamp slop.
const MTIME_SLACK_MS = 2000;
// The graphics protocol requires chunks of at most 4096 bytes, and every
// chunk except the last must be a multiple of 4 bytes long.
const KITTY_CHUNK_SIZE = 4096;
// tmux can drop passthrough sequences written while it is busy redrawing,
// so the transfer is re-sent a couple of times. Re-sending an id the
// terminal already has is harmless.
const KITTY_RETRY_DELAYS_MS = [100, 500];
const IMAGE_CACHE_MAX = 50;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

// Kitty's canonical row/column diacritics (rowcolumn-diacritics.txt from the
// protocol spec). Only the first 101 are needed because screenshots are
// capped at 100x30 terminal cells.
const NUMBER_TO_DIACRITIC = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
  0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
  0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
  0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2,
  0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733,
  0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074a, 0x07eb,
].map((codePoint) => String.fromCodePoint(codePoint));

function isScreenshotCommand(command: string): boolean {
  return command.includes("agent-browser") && command.includes("screenshot");
}

function extractImagePaths(text: string, cwd: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH_RE)) {
    let candidate = match[1];
    if (candidate.startsWith("~/")) {
      candidate = resolve(homedir(), candidate.slice(2));
    }
    if (!isAbsolute(candidate)) {
      candidate = resolve(cwd, candidate);
    }
    paths.add(candidate);
  }
  return [...paths];
}

function calculateImageCellSize(
  imageDimensions: ImageDimensions,
  maxWidthCells: number,
  maxHeightCells: number,
  cellDimensions: { widthPx: number; heightPx: number },
): { columns: number; rows: number } {
  const maxWidth = Math.max(1, Math.floor(maxWidthCells));
  const maxHeight = Math.max(1, Math.floor(maxHeightCells));
  const imageWidth = Math.max(1, imageDimensions.widthPx);
  const imageHeight = Math.max(1, imageDimensions.heightPx);
  const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
  const heightScale = (maxHeight * cellDimensions.heightPx) / imageHeight;
  const scale = Math.min(widthScale, heightScale);
  const columns = Math.ceil((imageWidth * scale) / cellDimensions.widthPx);
  const rows = Math.ceil((imageHeight * scale) / cellDimensions.heightPx);

  return {
    columns: Math.max(1, Math.min(maxWidth, columns)),
    rows: Math.max(1, Math.min(maxHeight, rows)),
  };
}

function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX) || (process.env.TERM ?? "").startsWith("tmux");
}

// Unicode placeholders are implemented by kitty (>= 0.28) and Ghostty.
// Inside tmux, TERM is rewritten, but the outer terminal's own environment
// variables are inherited from the client that started the tmux server.
function supportsUnicodePlaceholders(): boolean {
  if (process.env.KITTY_WINDOW_ID || process.env.GHOSTTY_RESOURCES_DIR) {
    return true;
  }
  const term = process.env.TERM ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) return true;
  return (process.env.TERM_PROGRAM ?? "").toLowerCase() === "ghostty";
}

// tmux >= 3.3 drops DCS passthrough unless `allow-passthrough` is on.
// Checked once; without it the image transfer would be silently discarded.
let allowsPassthrough: boolean | undefined;
function tmuxAllowsPassthrough(): boolean {
  if (allowsPassthrough === undefined) {
    try {
      const output = execFileSync("tmux", ["show", "-Ap", "allow-passthrough"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      allowsPassthrough = /\ballow-passthrough\s+(on|all)\b/.test(output);
    } catch {
      allowsPassthrough = false;
    }
  }
  return allowsPassthrough;
}

function useTmuxKittyPath(): boolean {
  return isInsideTmux() && supportsUnicodePlaceholders() && tmuxAllowsPassthrough();
}

// Derive a stable 24-bit image id from the cache key. Placeholder cells
// carry the id in their 24-bit foreground color, which is why ids are
// capped at 24 bits — no third diacritic needed.
function makeImageId(key: string): number {
  const bytes = createHash("sha256").update(key).digest();
  const red = bytes[0] || 1;
  const green = bytes[1] || 1;
  const blue = bytes[2] || 1;
  return (red << 16) | (green << 8) | blue;
}

function wrapTmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

// Transmit a PNG (f=100) and create a virtual placement (U=1) of the given
// cell size, quietly (q=2), chunked per the protocol.
function encodeVirtualPlacement(
  base64: string,
  imageId: number,
  columns: number,
  rows: number,
): string {
  let result = "";
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK_SIZE) {
    const data = base64.slice(offset, offset + KITTY_CHUNK_SIZE);
    const more = offset + KITTY_CHUNK_SIZE < base64.length ? 1 : 0;
    let control = `m=${more}`;
    if (offset === 0) {
      control = `a=T,f=100,U=1,i=${imageId},c=${columns},r=${rows},q=2,${control}`;
    }
    result += wrapTmuxPassthrough(`\x1b_G${control};${data}\x1b\\`);
  }
  return result;
}

class TmuxKittyImage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private retryGeneration = 0;
  private retryTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    private readonly base64: string,
    private readonly dimensions: ImageDimensions,
    private readonly imageId: number,
  ) {}

  private cancelTransferRetries(): void {
    this.retryGeneration++;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers = [];
  }

  private scheduleTransferRetries(transfer: string): void {
    this.cancelTransferRetries();
    const generation = this.retryGeneration;

    for (const delay of KITTY_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        if (generation !== this.retryGeneration) return;
        process.stdout.write(transfer);
      }, delay);
      timer.unref();
      this.retryTimers.push(timer);
    }
  }

  invalidate(): void {
    this.cancelTransferRetries();
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    const maxWidth = Math.max(1, Math.min(width - 2, MAX_WIDTH_CELLS));
    const { columns, rows } = calculateImageCellSize(
      this.dimensions,
      maxWidth,
      MAX_HEIGHT_CELLS,
      getCellDimensions(),
    );
    const transfer = encodeVirtualPlacement(
      this.base64,
      this.imageId,
      columns,
      rows,
    );
    process.stdout.write(transfer);
    this.scheduleTransferRetries(transfer);

    // Placeholder cells: image id in the foreground color, row/column in
    // combining diacritics. The terminal replaces them with image tiles.
    const red = (this.imageId >>> 16) & 255;
    const green = (this.imageId >>> 8) & 255;
    const blue = this.imageId & 255;
    const foreground = `\x1b[38:2:${red}:${green}:${blue}m`;

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = foreground;
      for (let column = 0; column < columns; column++) {
        line +=
          IMAGE_PLACEHOLDER +
          NUMBER_TO_DIACRITIC[row] +
          NUMBER_TO_DIACRITIC[column];
      }
      line += "\x1b[39m";
      lines.push(line);
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

const imageCache = new Map<string, Component>();

function getCachedImage(path: string, mtimeMs: number, theme: Theme): Component {
  const key = `${path}:${mtimeMs}`;
  let image = imageCache.get(key);
  if (image) return image;

  const base64 = readFileSync(path).toString("base64");
  const mimeType = MIME_TYPES[extname(path).toLowerCase()] ?? "image/png";
  const dimensions = getImageDimensions(base64, mimeType);

  // f=100 transfers are PNG-only; other formats take pi-tui's Image path,
  // which renders a text fallback inside tmux.
  if (useTmuxKittyPath() && mimeType === "image/png" && dimensions) {
    image = new TmuxKittyImage(base64, dimensions, makeImageId(key));
  } else {
    image = new Image(
      base64,
      mimeType,
      { fallbackColor: (str) => theme.fg("dim", str) },
      {
        maxWidthCells: MAX_WIDTH_CELLS,
        maxHeightCells: MAX_HEIGHT_CELLS,
        filename: path,
      },
    );
  }

  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(key, image);
  return image;
}

export default function (pi: ExtensionAPI) {
  const startTimes = new Map<string, number>();

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.args as { command?: string })?.command ?? "";
    if (isScreenshotCommand(command)) {
      startTimes.set(event.toolCallId, Date.now());
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const startedAt = startTimes.get(event.toolCallId);
    if (startedAt === undefined) return;
    startTimes.delete(event.toolCallId);
    if (event.isError) return;

    const command = (event.input as { command?: string })?.command ?? "";
    const output = event.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
    const candidates = [
      ...extractImagePaths(output, ctx.cwd),
      ...extractImagePaths(command, ctx.cwd),
    ];

    const seen = new Set<string>();
    for (const path of candidates) {
      if (seen.has(path)) continue;
      seen.add(path);
      let mtimeMs: number;
      try {
        const stats = statSync(path);
        if (stats.size > MAX_FILE_BYTES) continue;
        mtimeMs = stats.mtimeMs;
      } catch {
        continue;
      }
      // Only inline files this command actually produced, not older images
      // that merely appear in its output.
      if (mtimeMs < startedAt - MTIME_SLACK_MS) continue;
      pi.appendEntry(ENTRY_TYPE, { path, mtimeMs });
    }
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const { path, mtimeMs } = entry.data as { path: string; mtimeMs: number };
    const container = new Container();
    container.addChild(new Text(theme.fg("dim", `📸 ${path}`), 0, 0));
    try {
      container.addChild(getCachedImage(path, mtimeMs, theme));
    } catch {
      container.addChild(
        new Text(theme.fg("dim", "(screenshot file no longer available)"), 0, 0),
      );
    }
    return container;
  });
}
