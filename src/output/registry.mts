import type { OutputStyle, ThemeName } from "../types.mts"

export const OUTPUT_STYLES: OutputStyle[] = ["text", "json"]
export const THEMES: ThemeName[] = ["neutral", "contrast"]

export function formatOutput(
  style: OutputStyle,
  payload: unknown,
): string {
  if (style === "json") {
    return JSON.stringify(payload, null, 2)
  }
  if (typeof payload === "string") {
    return payload
  }
  return JSON.stringify(payload, null, 2)
}
