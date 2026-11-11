import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { AiopcMark, ProviderIcon } from "../src/react-app/design-system/provider-icon";

function paths(markup: string) {
  return [...markup.matchAll(/<path\b[^>]*>/g)].map(([path]) => ({
    d: path.match(/\bd="([^"]*)"/)?.[1],
    fillRule: path.match(/\bfill-rule="([^"]*)"/)?.[1],
  }));
}

const canonicalMark = readFileSync(new URL("../public/aiopc-mark.svg", import.meta.url), "utf8");
const canonicalPaths = paths(canonicalMark);

function expectAiopcMark(markup: string) {
  expect(markup).toContain('viewBox="0 0 512 512"');
  expect(markup).toContain('stroke="currentColor"');
  expect(markup).toContain('aria-label="AIOPC"');
  expect(paths(markup)).toEqual(canonicalPaths);
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("https://");
  expect(markup).not.toMatch(/fill="(?:white|black)/);
}

describe("AIOPC provider brand mark", () => {
  test.each([
    { providerId: "openwork" },
    { providerId: "  OpEnWoRk  " },
    { providerId: "550e8400-e29b-41d4-a716-446655440000", providerName: "OpenWork" },
    { providerId: "550e8400-e29b-41d4-a716-446655440000", providerName: "  oPeNwOrK Cloud  " },
  ])("uses the themed inline mark for $providerId / $providerName", (props) => {
    expectAiopcMark(renderToStaticMarkup(createElement(ProviderIcon, {
      ...props,
      baseUrl: "https://api.example.com/v1",
    })));
  });

  test("preserves provider size and wrapper classes", () => {
    const markup = renderToStaticMarkup(createElement(ProviderIcon, {
      providerId: "openwork", size: 28, className: "text-gray-12 provider-brand",
    }));
    expectAiopcMark(markup);
    expect(markup).toContain('<div class="text-gray-12 provider-brand"');
    expect(markup).toContain("width:28px;height:28px");
    expect(markup).toContain('width="28" height="28"');
  });

  test("shared mark draws the same ring the app's own file does", () => {
    const markup = renderToStaticMarkup(createElement(AiopcMark));
    expect(canonicalPaths).toHaveLength(1);
    expectAiopcMark(markup);
    expect(markup).toContain('width="16" height="16"');
    // The orange dot keeps its colour; only the ring follows the host's ink.
    expect(markup).toContain('<circle cx="404" cy="155" r="56" fill="#FF7A1A"');
    expect(markup).not.toMatch(/<(?:rect|image)\b/);
  });

  test("shared mark accepts its own size and className", () => {
    const markup = renderToStaticMarkup(createElement(AiopcMark, {
      size: 32, className: "text-gray-12 shared-brand",
    }));
    expectAiopcMark(markup);
    expect(markup).toContain('width="32" height="32" class="text-gray-12 shared-brand"');
  });
});

describe("other provider icons", () => {
  test.each([
    { providerId: "openai", pathStart: "M22.28 9.82", paint: 'fill="currentColor"' },
    { providerId: "opencode", pathStart: "M12 2L2 7l10 5 10-5-10-5Z", paint: 'stroke="currentColor"' },
  ])("keeps $providerId's existing inline logo", ({ providerId, pathStart, paint }) => {
    const markup = renderToStaticMarkup(createElement(ProviderIcon, { providerId }));
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain(`d="${pathStart}`);
    expect(markup).toContain(paint);
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('aria-label="OpenWork"');
  });

  test("Claude Code wears Anthropic's mark whatever the model is called", () => {
    const anthropic = renderToStaticMarkup(createElement(ProviderIcon, { providerId: "anthropic" }));
    const claudeCode = renderToStaticMarkup(createElement(ProviderIcon, { providerId: "claude-agent", providerName: "Claude Code" }));
    expect(claudeCode).toBe(anthropic);
    expect(claudeCode).toContain('d="M17.304 3.541');
    expect(claudeCode).not.toContain("<img");
  });

  test("unrelated providers still use their remote image", () => {
    const markup = renderToStaticMarkup(createElement(ProviderIcon, { providerId: "google" }));
    expect(markup).toContain('<img src="https://cdn.simpleicons.org/googlegemini"');
    expect(markup).not.toContain("<svg");
  });

  test("opaque unrelated providers still use the configured URL's favicon", () => {
    const markup = renderToStaticMarkup(createElement(ProviderIcon, {
      providerId: "550e8400-e29b-41d4-a716-446655440000", providerName: "Custom provider", baseUrl: "https://api.example.com/v1",
    }));
    expect(markup).toContain('<img src="https://www.google.com/s2/favicons?sz=64&amp;domain=example.com"');
    expect(markup).not.toContain("<svg");
  });
});
