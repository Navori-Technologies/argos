import { cancel, confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts";

/**
 * Interactive CLI layer (spec 0004, F5). The `Prompter` interface is the
 * injectable seam every interactive surface (`argos init`, `argos adopt`,
 * `argos remove`, `argos workspace link`) depends on instead of importing
 * `@clack/prompts` directly — same idiom as `OpenclawRunner` in
 * `lib/openclaw-agents.ts`: a typed interface, a real default implementation
 * that's a thin pass-through over the real library, and every surface takes
 * an optional `prompter?: Prompter` that defaults to it. Tests then inject a
 * trivial plain-object fake instead of depending on `@clack` internals.
 *
 * Shaped to mirror `@clack/prompts`' actual API 1:1 (same option names,
 * same `Value | symbol` return convention for cancellable prompts) so the
 * default implementation below is a pure pass-through.
 */

// `Value extends string` (rather than unconstrained) deliberately mirrors
// every actual use of `select` in this codebase (language codes, workspace
// names, match candidates) — it's also what makes `SelectOption` line up
// with `@clack/prompts`' own `Option<Value>` (whose `label` is optional only
// for `Value extends Readonly<string | boolean | number>`), so the default
// implementation below can pass options straight through with no adapter.
export interface SelectOption<Value extends string> {
  value: Value;
  label?: string;
  hint?: string;
}

export interface SelectPromptOptions<Value extends string> {
  message: string;
  options: SelectOption<Value>[];
  initialValue?: Value;
}

export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
}

export interface TextPromptOptions {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  /**
   * Signature matches `@clack/prompts`' own `Validate<string>` (accepts
   * `undefined` too — the prompt hasn't been submitted yet on first render)
   * so the default implementation below is a pure pass-through.
   */
  validate?: (value: string | undefined) => string | Error | undefined;
}

export interface Prompter {
  select<Value extends string>(opts: SelectPromptOptions<Value>): Promise<Value | symbol>;
  confirm(opts: ConfirmPromptOptions): Promise<boolean | symbol>;
  text(opts: TextPromptOptions): Promise<string | symbol>;
  isCancel(value: unknown): value is symbol;
  cancel(message?: string): void;
  note(message?: string, title?: string): void;
  intro(title?: string): void;
  outro(message?: string): void;
}

/** Real default implementation, backed by `@clack/prompts`. */
export const clackPrompter: Prompter = {
  // `@clack/prompts`' `Option<Value>` is a conditional type keyed on
  // `Value extends Primitive` — TS can't reduce that conditional for our
  // still-generic `Value` type parameter here (it only resolves once a
  // caller picks a concrete `Value`), so it refuses to unify
  // `SelectOption<Value>[]` with `Option<Value>[]` even though every
  // concrete instantiation (`Value extends string`) is structurally
  // identical. Narrow, single-purpose cast at this one boundary — not `any`
  // on the whole function — since `opts` is otherwise fully typed above.
  select: <Value extends string>(opts: SelectPromptOptions<Value>) =>
    select(opts as Parameters<typeof select>[0]) as Promise<Value | symbol>,
  confirm: (opts) => confirm(opts),
  text: (opts) => text(opts),
  isCancel: (value): value is symbol => isCancel(value),
  cancel: (message) => cancel(message),
  note: (message, title) => note(message, title),
  intro: (title) => intro(title),
  outro: (message) => outro(message),
};

/**
 * TTY gate every interactive surface checks independently before layering
 * prompts on top of its own flag-driven defaults (spec 0004's hard rule):
 * both stdout and stdin must be a real TTY, AND `--yes` must not have been
 * passed — `--yes` forces non-interactive behavior even under a real TTY,
 * since that's how a human operator opts out of the wizard on demand.
 */
export function isInteractive(options: { yes?: boolean }): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true && !options.yes;
}
