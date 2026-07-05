// Shared utilities for all cold-email-starter-kit scripts.
// Import with: import { env, readCsv, writeCsv, sleep, retry, ... } from "./_lib.ts";

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────
// .env loading (no dependency, works in ESM + CJS)
// ─────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadEnv(): Record<string, string> {
  const skillRoot = path.resolve(__dirname, "..");
  const envPath = path.join(skillRoot, ".env");
  if (!fs.existsSync(envPath)) return process.env as Record<string, string>;
  const raw = fs.readFileSync(envPath, "utf8");
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!out[key]) out[key] = val;
  }
  return out;
}
export const env = loadEnv();

export function required(key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}. Add it to .env.`);
  return v;
}

// ─────────────────────────────────────────────────────────
// CLI args (tiny parser — no dependency)
// ─────────────────────────────────────────────────────────
export function parseArgs(argv: string[] = process.argv.slice(2)): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        // support repeated --title "A" --title "B" → collected as array string joined with |
        if (flags[key] !== undefined) {
          flags[key] = `${flags[key]}|${next}`;
        } else {
          flags[key] = next;
        }
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function multiFlag(flags: Record<string, string | boolean>, key: string): string[] {
  const v = flags[key];
  if (!v || v === true) return [];
  return String(v).split("|");
}

// ─────────────────────────────────────────────────────────
// CSV (minimal, handles quoted fields)
// ─────────────────────────────────────────────────────────
export function readCsv(filepath: string): Record<string, string>[] {
  if (!fs.existsSync(filepath)) {
    throw new Error(`CSV file not found: ${filepath}`);
  }
  let raw = fs.readFileSync(filepath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
  const lines = parseCsvText(raw);
  if (lines.length === 0) return [];
  const headers = lines[0];
  return lines.slice(1).map(values => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

export function writeCsv(filepath: string, rows: Record<string, any>[]): void {
  if (rows.length === 0) {
    fs.writeFileSync(filepath, "");
    return;
  }
  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = Array.from(headerSet);
  const out: string[] = [headers.join(",")];
  for (const r of rows) {
    out.push(headers.map(h => escapeCsv(r[h])).join(","));
  }
  fs.writeFileSync(filepath, out.join("\n") + "\n");
}

// Quote-aware full-file CSV parser: handles quoted fields containing
// commas, escaped quotes, and embedded newlines (which writeCsv legally emits).
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (!(row.length === 1 && row[0] === "")) rows.push(row); // skip blank lines
        row = [];
      }
      else { cur += c; }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

function escapeCsv(v: any): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─────────────────────────────────────────────────────────
// Async utilities
// ─────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function retry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseDelayMs?: number; onAttemptError?: (e: any, attempt: number) => void } = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 1000, onAttemptError } = opts;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e: any) {
      lastErr = e;
      onAttemptError?.(e, i);
      await sleep(Math.min(baseDelayMs * Math.pow(2, i), 30000));
    }
  }
  throw lastErr;
}

// simple p-queue replacement (concurrency limiter)
export function createQueue(concurrency: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (running >= concurrency) return;
    const task = queue.shift();
    if (!task) return;
    running++;
    task();
  };
  return {
    add<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          fn().then(resolve, reject).finally(() => { running--; next(); });
        });
        next();
      });
    },
  };
}

// ─────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} `, answer => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

export function printTable(rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? "").length)));
  const sep = " ";
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(sep));
  console.log(widths.map(w => "─".repeat(w)).join(sep));
  for (const r of rows) {
    console.log(headers.map((h, i) => String(r[h] ?? "").padEnd(widths[i])).join(sep));
  }
}
