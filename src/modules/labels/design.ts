import { z } from "zod";
import { badRequest } from "@/lib/http";
import { HEX_COLOR, type LabelTemplate } from "./template";

/** `labels.design_state`: editable-field key → value (text, #RRGGBB colour or logo asset id). */
export type DesignState = Record<string, string>;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Structural validation against the template: unknown and locked keys are rejected, text is
 * length-limited, colours are hex, images are UUIDs (ownership is checked by the caller).
 * Empty strings and nulls unset a field. Required fields are enforced at submit, not on save.
 */
export function parseDesignState(template: LabelTemplate, raw: unknown): DesignState {
  const obj = z.record(z.string(), z.string().nullable()).safeParse(raw);
  if (!obj.success) throw badRequest("designState must be an object of string values");
  const fields = new Map(template.editableFields.map((f) => [f.key, f]));
  const locked = new Set(template.fixedPanels.map((p) => p.key));
  const errors: string[] = [];
  const out: DesignState = {};
  for (const [key, value] of Object.entries(obj.data)) {
    const field = fields.get(key);
    if (!field) {
      errors.push(locked.has(key) ? `${key}: locked panel` : `${key}: unknown field`);
      continue;
    }
    if (value === null || value === "") continue;
    if (field.type === "text") {
      if ([...value].length > field.maxLength) errors.push(`${key}: max ${field.maxLength} chars`);
      else if (CONTROL_CHARS.test(value)) errors.push(`${key}: control characters not allowed`);
      else out[key] = value;
    } else if (field.type === "color") {
      if (!HEX_COLOR.test(value)) errors.push(`${key}: must be a #RRGGBB hex colour`);
      else out[key] = value.toUpperCase();
    } else if (!z.uuid().safeParse(value).success) {
      errors.push(`${key}: must be an asset id`);
    } else {
      out[key] = value;
    }
  }
  if (errors.length) throw badRequest(errors.join("; "));
  return out;
}

/** Stored state is re-parsed before use; colour fields fall back to their template defaults. */
export function resolveDesign(template: LabelTemplate, stored: unknown): DesignState {
  const state = parseDesignState(template, stored ?? {});
  for (const f of template.editableFields)
    if (f.type === "color" && !state[f.key]) state[f.key] = f.default;
  return state;
}

export function missingRequired(template: LabelTemplate, state: DesignState): string[] {
  return template.editableFields
    .filter((f) => f.required && f.type !== "color" && !state[f.key])
    .map((f) => f.key);
}

export function logoFields(template: LabelTemplate) {
  return template.editableFields.filter((f) => f.type === "image");
}
