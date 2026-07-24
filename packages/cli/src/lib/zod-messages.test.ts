import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeZodError } from "./zod-messages.js";

describe("describeZodError", () => {
  it("describes an invalid_type issue in plain Spanish", () => {
    const result = z.string().safeParse(123);
    const messages = describeZodError(result.error);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/tipo inválido/);
    expect(messages[0]).toMatch(/string/);
  });

  it("describes a too_small issue", () => {
    const result = z.string().min(3).safeParse("ab");
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/demasiado pequeño|demasiado corto/);
  });

  it("describes a too_big issue", () => {
    const result = z.string().max(3).safeParse("abcd");
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/demasiado grande|demasiado largo/);
  });

  it("describes an invalid_value issue for an enum mismatch", () => {
    const result = z.enum(["es", "en"]).safeParse("fr");
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/valor no permitido/);
    expect(messages[0]).toMatch(/es, en/);
  });

  it("describes an invalid_format issue", () => {
    const result = z.string().email().safeParse("not-an-email");
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/formato inválido/);
  });

  it("describes an unrecognized_keys issue", () => {
    const schema = z.strictObject({ a: z.string() });
    const result = schema.safeParse({ a: "x", b: "y" });
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/propiedades desconocidas/);
    expect(messages[0]).toContain("b");
  });

  it("prefixes the field path, or '(raíz)' when the issue has no path", () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 42 });
    const messages = describeZodError(result.error);
    expect(messages[0]).toMatch(/^name:/);

    const rootResult = z.string().safeParse(42);
    const rootMessages = describeZodError(rootResult.error);
    expect(rootMessages[0]).toMatch(/^\(raíz\):/);
  });

  it("falls back to the issue's own message for a custom refinement", () => {
    const schema = z.string().refine(() => false, { message: "regla de negocio custom" });
    const result = schema.safeParse("anything");
    const messages = describeZodError(result.error);
    expect(messages[0]).toContain("regla de negocio custom");
  });

  it("maps every issue in a multi-error ZodError", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: "x" });
    const messages = describeZodError(result.error);
    expect(messages).toHaveLength(2);
  });

  it("falls back to error.message for a non-Zod Error", () => {
    expect(describeZodError(new Error("boom"))).toEqual(["boom"]);
  });

  it("falls back to String(error) for a non-Error, non-Zod value", () => {
    expect(describeZodError("just a string")).toEqual(["just a string"]);
  });
});
