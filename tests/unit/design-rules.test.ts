import { describe, expect, it } from "vitest";
import { checkRepo, checkSource } from "../../scripts/design-rules";

const rulesHit = (file: string, src: string) => checkSource(file, src).map((v) => v.rule.split(":")[0]);

describe("design rules: bad fixtures fail", () => {
  it.each([
    ['<div className="rounded-lg p-4" />', "no-rounded"],
    ['<img className="md:rounded-full" />', "no-rounded"],
    ['<button className="rounded" />', "no-rounded"],
    ["<div style={{ borderRadius: 8 }} />", "no-radius-style"],
    ['<div className="shadow-md" />', "no-shadow"],
    ['<div className="drop-shadow" />', "no-shadow"],
    ['<div className="bg-linear-to-r from-action to-fit" />', "no-gradient"],
    ['<div className="backdrop-blur-sm" />', "no-blur"],
    ['<span className="uppercase" />', "no-uppercase"],
    ['<span className="tracking-widest" />', "no-tracking"],
    ['<span className="font-mono" />', "no-mono"],
    ['<a className="hover:-translate-y-1" />', "no-hover-lift"],
    ["<p>Great part \u{1F525}</p>", "no-emoji"],
    ["<p>Pune · 2 km · Delivery</p>", "no-middle-dot"],
    ["<a href='/x'>See all →</a>", "no-trailing-arrow"],
  ])("%s → %s", (src, rule) => {
    expect(rulesHit("fixture.tsx", src)).toContain(rule);
  });

  it.each([
    [".x { border-radius: 4px; }", "no-radius-css"],
    [":root { --radius-lg: 0.5rem; }", "no-radius-token"],
    [".x { background: linear-gradient(red, blue); }", "no-gradient-css"],
    [".x { text-transform: uppercase; }", "no-uppercase-css"],
    [".x { font-family: monospace; }", "no-mono-css"],
    [".x { letter-spacing: 0.2em; }", "no-letter-spacing-css"],
    [".x { box-shadow: 0 1px 2px black; }", "no-box-shadow-css"],
  ])("%s → %s", (src, rule) => {
    expect(rulesHit("fixture.css", src)).toContain(rule);
  });
});

describe("design rules: allowed patterns pass", () => {
  it.each([
    '<div className="border border-rule bg-surface p-4" />',
    '<div className="shadow-float" />',
    '<span className="part-no">SAMPLE-BRK-0001</span>',
    "<p>We deliver from Sample City to your pincode.</p>",
    "// rounded corners are banned (comment only)",
    '<p>Start from scratch or move to-do items.</p>',
  ])("%s", (src) => {
    expect(checkSource("fixture.tsx", src)).toEqual([]);
  });

  it("allows zero radius and letter-spacing inside part-no", () => {
    const css = `*{border-radius:0 !important;} :root{--radius-lg:0;--radius-*:initial;} @utility part-no { letter-spacing: 0.04em; }`;
    expect(checkSource("fixture.css", css)).toEqual([]);
  });
});

describe("design rules: repository", () => {
  it("has no violations in app/ and src/", () => {
    expect(checkRepo(process.cwd())).toEqual([]);
  });
});
