// Types for the tests that hold a host's behold:view to the view keys (behold#922).
import type { Want } from "./view-url.js";
export function viewFromMessage(event: { origin?: string; data?: unknown } | null | undefined, host: string | null | undefined): Want | null;
