import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const listing = JSON.parse(read("plugins/listing.json"));

describe("listing copy (#1054)", () => {
  it("keeps the short form to 100 characters", () => {
    expect(listing.short.length).toBeLessThanOrEqual(100);
  });
  it("is the package description", () => {
    expect(JSON.parse(read("package.json")).description).toBe(listing.short);
  });
  it("opens the README with the line and the command", () => {
    const top = read("README.md").split("\n").slice(0, 10).join("\n").toLowerCase();
    expect(top).toContain(listing.line);
    expect(top).toContain(listing.command);
  });
  it("puts the paragraph in the README", () => {
    const sentence = listing.paragraph.split(". ")[1];
    expect(read("README.md").replaceAll("`", "")).toContain(sentence);
  });
});
