import { z } from "zod";

/** Render a single zod issue as a plain Spanish sentence, not a raw zod dump. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(raíz)";
  switch (issue.code) {
    case "invalid_type":
      return `${path}: tipo inválido, se esperaba ${issue.expected}.`;
    case "too_small":
      return `${path}: valor demasiado pequeño/corto (mínimo ${issue.minimum}).`;
    case "too_big":
      return `${path}: valor demasiado grande/largo (máximo ${issue.maximum}).`;
    case "invalid_value":
      return `${path}: valor no permitido (opciones válidas: ${issue.values.join(", ")}).`;
    case "unrecognized_keys":
      return `${path}: propiedades desconocidas (${issue.keys.join(", ")}).`;
    case "invalid_format":
      return `${path}: formato inválido (${issue.format}).`;
    default:
      return `${path}: ${issue.message}`;
  }
}

/** Map every issue in a ZodError to a readable Spanish sentence. */
export function describeZodError(error: z.core.$ZodError | unknown): string[] {
  if (error instanceof z.ZodError) return error.issues.map(describeIssue);
  return [error instanceof Error ? error.message : String(error)];
}
