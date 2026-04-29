import type { MonadViolation } from "../src/monadChecker.ts";
import { type FormatSourceSnippetOptions } from "./format-source-snippet.ts";
export declare function formatGraphViolation(violation: MonadViolation, files: ReadonlyMap<string, string>, options?: FormatSourceSnippetOptions): string | null;
